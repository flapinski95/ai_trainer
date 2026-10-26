import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";
import { DynamoDBClient, GetItemCommand, UpdateItemCommand, type GetItemCommandOutput } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { userIdSchema } from "../auth/identity";

const jobSchema = z.object({
  userId: userIdSchema,
  provider: z.enum(["strava", "garmin"]),
  activityId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
const resultSchema = z.object({
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  sessionId: z.string().uuid().optional(),
});
const secretSchema = z.object({ web_push_trigger_secret: z.string().min(32).max(4096) });
const endpointSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
    !url.port && url.pathname === "/api/push/workout" && url.hostname !== "localhost" &&
    !url.hostname.endsWith(".localhost") && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]";
});

type Dependencies = {
  get: (command: GetItemCommand) => Promise<Pick<GetItemCommandOutput, "Item">>;
  update: (command: UpdateItemCommand) => Promise<unknown>;
  credentials: () => Promise<string>;
  fetch?: (url: string, options: RequestInit) => Promise<Response>;
};

class PushRequestError extends Error {
  constructor(readonly status: number) {
    super("Push endpoint rejected the request");
    this.name = "PushRequestError";
  }
}

export function createPushHandler(dependencies: Dependencies, tableName: string, endpoint: string) {
  const url = endpointSchema.parse(endpoint);
  const request = dependencies.fetch ?? fetch;
  return async (batch: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
    let token: string | undefined;
    for (const record of batch.Records) {
      const image = record.dynamodb?.NewImage;
      if (record.eventName !== "INSERT" || image?.entityType?.S !== "PUSH_WORKOUT_JOB" || image.state?.S !== "QUEUED") continue;
      try {
        const job = jobSchema.parse({ userId: image.userId?.S, provider: image.provider?.S, activityId: image.activityId?.S });
        const key = {
          PK: { S: `USER#${job.userId}` },
          SK: { S: `PUSH_JOB#${job.provider.toUpperCase()}#${job.activityId}` },
        };
        if (image.PK?.S !== key.PK.S || image.SK?.S !== key.SK.S) throw new Error("Push job identity mismatch");
        const stored = await dependencies.get(new GetItemCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
        if (!stored.Item) throw new Error("Push job is missing");
        if (stored.Item.entityType?.S !== "PUSH_WORKOUT_JOB") throw new Error("Invalid push job type");
        if (stored.Item.state?.S === "COMPLETED") continue;
        if (stored.Item.state?.S !== "QUEUED") throw new Error("Invalid push job state");
        if (stored.Item.userId?.S !== job.userId || stored.Item.provider?.S !== job.provider || stored.Item.activityId?.S !== job.activityId)
          throw new Error("Stored push job identity mismatch");
        token ??= z.string().min(32).max(4096).parse(await dependencies.credentials());
        const response = await request(url, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(45_000),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(job),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new PushRequestError(response.status);
        }
        const result = resultSchema.parse(await response.json());
        if (result.failed) throw new PushRequestError(503);
        await dependencies.update(new UpdateItemCommand({
          TableName: tableName, Key: key,
          UpdateExpression: "SET #state = :completed, completedAt = :now, sent = :sent",
          ConditionExpression: "#state = :queued AND entityType = :type",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":completed": { S: "COMPLETED" }, ":queued": { S: "QUEUED" },
            ":type": { S: "PUSH_WORKOUT_JOB" }, ":now": { S: new Date().toISOString() }, ":sent": { N: String(result.sent) },
          },
        }));
      } catch (error) {
        console.error("push_worker_job_failed", {
          type: error instanceof Error ? error.name : "UnknownError",
          status: error instanceof PushRequestError ? error.status : undefined,
        });
        const sequence = record.dynamodb?.SequenceNumber;
        if (!sequence) throw new Error("Push stream record has no sequence number");
        return { batchItemFailures: [{ itemIdentifier: sequence }] };
      }
    }
    return { batchItemFailures: [] };
  };
}

const options = { maxAttempts: 2, requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 } };
const dynamodb = new DynamoDBClient(options);
const secrets = new SecretsManagerClient(options);

export async function handler(batch: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const table = process.env.DYNAMODB_TABLE_NAME;
  const endpoint = process.env.WEB_PUSH_ENDPOINT;
  const secretArn = process.env.WEB_PUSH_SECRET_ARN;
  if (!table || !endpoint || !secretArn) throw new Error("Push worker is not configured");
  return createPushHandler({
    get: (command) => dynamodb.send(command),
    update: (command) => dynamodb.send(command),
    credentials: async () => {
      const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
      return secretSchema.parse(JSON.parse(result.SecretString ?? "")).web_push_trigger_secret;
    },
  }, table, endpoint)(batch);
}