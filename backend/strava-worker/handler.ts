import type {
  DynamoDBStreamEvent,
  DynamoDBBatchResponse,
  ScheduledEvent,
  Context,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { stravaEventSchema, type StravaEvent } from "../strava-webhook/events";
import { createWorkerStore } from "./store";
import { createProcessor, StravaRequestError } from "./processor";
import { createStravaClient } from "./strava";
import { createJobStore } from "../history/jobs";
import { createStravaBackfill } from "../strava/backfill";
import { createRateGate, RateLimitError } from "../history/rate-limit";
import { userIdSchema } from "../auth/identity";

const clientOptions = {
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 },
};
const dynamodb = new DynamoDBClient(clientOptions);
const kms = new KMSClient(clientOptions);
const secrets = new SecretsManagerClient(clientOptions);
const secretSchema = z.object({
  client_id: z.string().regex(/^[1-9]\d*$/),
  client_secret: z.string().min(1),
});

export function createStreamHandler(
  process: (event: StravaEvent) => Promise<void>,
  subscriptionId: string,
  synchronize?: (userId: string) => Promise<void>,
) {
  return async (batch: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
    for (const record of batch.Records) {
      const image = record.dynamodb?.NewImage;
      if (record.eventName !== "INSERT") continue;
      const history =
        image?.entityType?.S === "STRAVA_SYNC_JOB" &&
        image.state?.S === "QUEUED";
      const inbox =
        image?.entityType?.S === "STRAVA_WEBHOOK_EVENT" &&
        image.status?.S === "RECEIVED";
      if (!history && !inbox) continue;
      try {
        if (history) {
          if (!synchronize) throw new Error("History processor unavailable");
          await synchronize(userIdSchema.parse(image?.userId?.S));
          continue;
        }
        const event = stravaEventSchema.parse(
          JSON.parse(image?.payload?.S ?? ""),
        );
        if (String(event.subscription_id) !== subscriptionId)
          throw new Error("Unexpected subscription");
        await process(event);
      } catch (error) {
        console.error("strava_worker_event_failed", {
          type: error instanceof Error ? error.name : "UnknownError",
          status:
            error instanceof StravaRequestError ? error.status : undefined,
        });
        const sequenceNumber = record.dynamodb?.SequenceNumber;
        if (!sequenceNumber)
          throw new Error("Stream record has no sequence number");
        return { batchItemFailures: [{ itemIdentifier: sequenceNumber }] };
      }
    }
    return { batchItemFailures: [] };
  };
}

export async function handler(
  batch: DynamoDBStreamEvent | ScheduledEvent,
  context?: Context,
): Promise<DynamoDBBatchResponse | void> {
  const table = process.env.DYNAMODB_TABLE_NAME;
  const key = process.env.DYNAMODB_KMS_KEY_ARN;
  const secretArn = process.env.STRAVA_OAUTH_SECRET_ARN;
  const subscriptionId = process.env.STRAVA_SUBSCRIPTION_ID;
  if (!table || !key || !secretArn || !subscriptionId)
    throw new Error("Strava worker is not configured");
  const store = createWorkerStore(
    {
      get: (command) => dynamodb.send(command),
      query: (command) => dynamodb.send(command),
      update: (command) => dynamodb.send(command),
      transact: (command) => dynamodb.send(command),
      encrypt: (command) => kms.send(command),
      decrypt: (command) => kms.send(command),
    },
    table,
    key,
  );
  const credentials = async () => {
    const value = await secrets.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    const credentials = secretSchema.parse(
      JSON.parse(value.SecretString ?? ""),
    );
    return {
      clientId: credentials.client_id,
      clientSecret: credentials.client_secret,
    };
  };
  const rateDependencies = {
    get: (command: import("@aws-sdk/client-dynamodb").GetItemCommand) =>
      dynamodb.send(command),
    update: (command: import("@aws-sdk/client-dynamodb").UpdateItemCommand) =>
      dynamodb.send(command),
    transact: (
      command: import("@aws-sdk/client-dynamodb").TransactWriteItemsCommand,
    ) => dynamodb.send(command),
  };
  const jobs = createJobStore(
    {
      ...rateDependencies,
      query: (command) => dynamodb.send(command),
      put: (command) => dynamodb.send(command),
    },
    table,
  );
  const webhookClient = createStravaClient(
    credentials,
    fetch,
    createRateGate(rateDependencies, table, "WEBHOOK"),
  );
  const historyClient = createStravaClient(
    credentials,
    fetch,
    createRateGate(rateDependencies, table, "HISTORY"),
  );
  const processEvent = createProcessor({ ...store, ...webhookClient });
  const processWebhook = async (event: StravaEvent) => {
    if (String(event.subscription_id) !== subscriptionId)
      throw new Error("Unexpected subscription");
    try {
      await processEvent(event);
    } catch (error) {
      if (error instanceof RateLimitError) {
        await store.defer(event, error.retryAt);
        return;
      }
      throw error;
    }
  };
  const synchronize = createStravaBackfill({
    ...store,
    ...historyClient,
    ...jobs,
    revoke: (connection) => store.revoke(null, connection),
    remaining: () => context?.getRemainingTimeInMillis() ?? 30000,
  });
  if (!("Records" in batch)) {
    if (batch.source !== "aws.events")
      throw new Error("Unsupported worker invocation");
    const event = await store.nextWebhook();
    if (event) {
      await processWebhook(event);
      return;
    }
    const userId = await jobs.nextDue();
    if (userId) await synchronize(userId);
    return;
  }
  return createStreamHandler(
    processWebhook,
    subscriptionId,
    synchronize,
  )(batch);
}
