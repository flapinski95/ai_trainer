import type {
  Context,
  DynamoDBStreamEvent,
  DynamoDBBatchResponse,
} from "aws-lambda";
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { marshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import { createArtifactStore } from "./artifacts";
import { createEnvelopeEncryption } from "./encryption";
import { createGarminAccess } from "./access";
import { createGarminProcessor } from "./processor";
import { categorySchema, payloadSchema, garminHash } from "./payload";
import { createWorkoutWriter } from "../workouts/persist";
import type { Connection } from "../strava-worker/processor";
import { createDailyMetricStore } from "./daily-store";

const options = {
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 },
};
const dynamodb = new DynamoDBClient(options);
const kms = new KMSClient(options);
const secrets = new SecretsManagerClient(options);
export async function handler(
  batch: DynamoDBStreamEvent,
  context: Context,
): Promise<DynamoDBBatchResponse> {
  const table = process.env.DYNAMODB_TABLE_NAME;
  const keyArn = process.env.DYNAMODB_KMS_KEY_ARN;
  const secretArn = process.env.GARMIN_OAUTH_SECRET_ARN;
  if (!table || !keyArn || !secretArn)
    throw new Error("Garmin worker is not configured");
  const dependencies = {
    get: (command: import("@aws-sdk/client-dynamodb").GetItemCommand) =>
      dynamodb.send(command),
    query: (command: import("@aws-sdk/client-dynamodb").QueryCommand) =>
      dynamodb.send(command),
    transact: (
      command: import("@aws-sdk/client-dynamodb").TransactWriteItemsCommand,
    ) => dynamodb.send(command),
  };
  const artifacts = createArtifactStore(dependencies, table);
  const encryption = createEnvelopeEncryption(
    {
      generate: (command) => kms.send(command),
      decrypt: (command) => kms.send(command),
    },
    keyArn,
  );
  const writer = createWorkoutWriter(dependencies, table);
  const dailyMetrics = createDailyMetricStore({ get: dependencies.get, artifacts, encryption }, table);
  const verify = createGarminAccess(
    {
      decrypt: (command) => kms.send(command),
      encrypt: (command) => kms.send(command),
      update: (command) => dynamodb.send(command),
      credentials: async () => {
        const response = await secrets.send(
          new GetSecretValueCommand({ SecretId: secretArn }),
        );
        const secret = z
          .object({
            client_id: z.string().min(1),
            client_secret: z.string().min(1),
          })
          .parse(JSON.parse(response.SecretString ?? ""));
        return {
          clientId: secret.client_id,
          clientSecret: secret.client_secret,
        };
      },
    },
    table,
    keyArn,
  );
  for (const record of batch.Records) {
    if (
      record.eventName !== "INSERT" ||
      record.dynamodb?.NewImage?.entityType?.S !== "GARMIN_PUSH"
    )
      continue;
    const image = record.dynamodb.NewImage;
    const PK = image.PK?.S;
    const revision = image.revision?.S;
    const sequence = record.dynamodb.SequenceNumber;
    if (!PK || !revision || !sequence)
      throw new Error("Invalid Garmin stream record");
    try {
      const current = await dynamodb.send(
        new GetItemCommand({
          TableName: table,
          Key: marshall({ PK, SK: "MANIFEST" }),
          ConsistentRead: true,
        }),
      );
      if (!current.Item || current.Item.status?.S === "PROCESSED") continue;
      const category = categorySchema.parse(current.Item.category?.S);
      const receivedAt = Number(current.Item.receivedAt?.N);
      const count = Number(current.Item.partCount?.N);
      const ciphertext = await artifacts.read(PK, "MANIFEST", revision, count);
      const payload = payloadSchema.parse(
        await encryption.decrypt(ciphertext, {
          provider: "garmin",
          purpose: "push",
        }),
      );
      const rows = Object.entries(payload).flatMap(([type, records]) =>
        records.map((data) => ({ type, data })),
      );
      let offset = Number(current.Item.offset?.N ?? 0);
      const processRecord = createGarminProcessor({
        connection: async (externalId) => {
          const mapping = await dynamodb.send(
            new QueryCommand({
              TableName: table,
              IndexName: "GSI1",
              KeyConditionExpression: "GSI1PK = :provider",
              ExpressionAttributeValues: marshall({
                ":provider": `GARMIN#${externalId}`,
              }),
              Limit: 2,
            }),
          );
          if (!mapping.Items?.length)
            throw new Error("Garmin identity mapping is not available yet");
          if (mapping.Items.length !== 1)
            throw new Error("Ambiguous Garmin identity");
          const item = mapping.Items[0]!;
          const partition = item.PK?.S;
          if (
            !partition?.startsWith("USER#") ||
            item.SK?.S !== "CONNECTION#GARMIN"
          )
            throw new Error("Invalid Garmin identity mapping");
          const response = await dynamodb.send(
            new GetItemCommand({
              TableName: table,
              Key: { PK: item.PK!, SK: item.SK! },
              ConsistentRead: true,
            }),
          );
          const connection = response.Item;
          if (!connection)
            throw new Error("Garmin connection is not available yet");
          return {
            userId: partition.slice(5),
            athleteId: connection.athleteId?.S ?? "",
            active: connection.status?.S === "ACTIVE",
            scopes: connection.scopes?.SS ?? [],
            encryptedTokens: connection.encryptedTokens?.S ?? "",
            expiresAt: Number(connection.expiresAt?.N ?? 0),
            authorizedAt: connection.authorizedAt?.S ?? "",
          };
        },
        verify,
        revoke: async (connection) => {
          await dynamodb.send(
            new UpdateItemCommand({
              TableName: table,
              Key: marshall({
                PK: `USER#${connection.userId}`,
                SK: "CONNECTION#GARMIN",
              }),
              UpdateExpression:
                "SET #status = :revoked REMOVE encryptedTokens, scopes",
              ConditionExpression: "encryptedTokens = :old",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: marshall({
                ":revoked": "REVOKED",
                ":old": connection.encryptedTokens,
              }),
            }),
          );
        },
        saveRecord: async (connection, sourceCategory, type, data) => {
          const id = garminHash({
            type,
            summaryId: data.summaryId ?? data.startTimeInSeconds ?? data,
          });
          const prefix =
            sourceCategory === "activity" ? "GARMIN_ACTIVITY" : "HEALTH";
          await artifacts.put(
            `USER#${connection.userId}`,
            `${prefix}#GARMIN#${type}#${id}`,
            data,
            () =>
              encryption.encrypt(data, {
                userId: connection.userId,
                provider: "garmin",
                purpose: sourceCategory,
              }),
            {
              entityType:
                sourceCategory === "activity"
                  ? "GARMIN_ACTIVITY_DATA"
                  : "GARMIN_HEALTH",
              provider: "garmin",
              category: sourceCategory,
              dataType: type,
              GSI1PK: `USER#${connection.userId}`,
              GSI1SK: `${prefix}#GARMIN#${String(receivedAt).padStart(16, "0")}#${id}`,
            },
            receivedAt,
            undefined,
            {
              encryptedTokens: connection.encryptedTokens,
              permission:
                sourceCategory === "activity"
                  ? "ACTIVITY_EXPORT"
                  : sourceCategory === "womens-health"
                    ? "MCT_EXPORT"
                    : "HEALTH_EXPORT",
            },
          );
        },
        saveDailyMetric: async (connection, type, data) => {
          await dailyMetrics.save(connection, type, data, receivedAt);
        },
        saveActivity: async (connection, id, metrics) => {
          await writer(
            connection,
            id,
            Math.floor(receivedAt / 1000),
            metrics,
            "WEBHOOK",
            true,
            "garmin",
          );
        },
      });
      while (
        offset < rows.length &&
        context.getRemainingTimeInMillis() > 17000
      ) {
        const row = rows[offset]!;
        await processRecord(category, row.type, row.data);
        offset += 1;
      }
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: table,
          Key: marshall({ PK, SK: "MANIFEST" }),
          UpdateExpression: "SET #offset = :offset, #status = :status",
          ConditionExpression: "revision = :revision",
          ExpressionAttributeNames: {
            "#offset": "offset",
            "#status": "status",
          },
          ExpressionAttributeValues: marshall({
            ":offset": offset,
            ":status": offset === rows.length ? "PROCESSED" : "RECEIVED",
            ":revision": revision,
          }),
        }),
      );
      if (offset < rows.length)
        return { batchItemFailures: [{ itemIdentifier: sequence }] };
    } catch (error) {
      console.error("garmin_push_processing_failed", {
        type: error instanceof Error ? error.name : "UnknownError",
      });
      return { batchItemFailures: [{ itemIdentifier: sequence }] };
    }
  }
  return { batchItemFailures: [] };
}
