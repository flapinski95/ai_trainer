import {
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
  type GetItemCommandOutput,
  type QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { marshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import {
  eventIdentity,
  stravaEventSchema,
  type StravaEvent,
} from "../strava-webhook/events";
import type { Activity, Connection, Outcome, Tokens } from "./processor";
import { createWorkoutWriter } from "../workouts/persist";

type Dependencies = {
  get: (command: GetItemCommand) => Promise<Pick<GetItemCommandOutput, "Item">>;
  query: (command: QueryCommand) => Promise<Pick<QueryCommandOutput, "Items">>;
  update: (command: UpdateItemCommand) => Promise<unknown>;
  transact: (command: TransactWriteItemsCommand) => Promise<unknown>;
  encrypt: (
    command: EncryptCommand,
  ) => Promise<{ CiphertextBlob?: Uint8Array }>;
  decrypt: (command: DecryptCommand) => Promise<{ Plaintext?: Uint8Array }>;
};

const tokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});
const inboxKey = (event: StravaEvent) =>
  marshall({
    PK: `STRAVA#ATHLETE#${event.owner_id}`,
    SK: `WEBHOOK#${eventIdentity(event)}`,
  });
const connectionKey = (connection: Connection) =>
  marshall({ PK: `USER#${connection.userId}`, SK: "CONNECTION#STRAVA" });

export function createWorkerStore(
  dependencies: Dependencies,
  tableName: string,
  kmsKeyArn: string,
) {
  const condition = (connection: Connection) => ({
    TableName: tableName,
    Key: connectionKey(connection),
    ConditionExpression: "#status = :active AND encryptedTokens = :tokens",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: marshall({
      ":active": "ACTIVE",
      ":tokens": connection.encryptedTokens,
    }),
  });

  const writeWorkout = createWorkoutWriter(dependencies, tableName);

  return {
    async connectionByUser(userId: string): Promise<Connection | null> {
      const response = await dependencies.get(
        new GetItemCommand({
          TableName: tableName,
          Key: marshall({ PK: `USER#${userId}`, SK: "CONNECTION#STRAVA" }),
          ConsistentRead: true,
        }),
      );
      const item = response.Item;
      if (!item) return null;
      const authorizedAt = item.authorizedAt?.S ?? "";
      if (!Number.isFinite(Date.parse(authorizedAt)))
        throw new Error("Invalid authorization timestamp");
      return {
        userId,
        athleteId: item.athleteId?.S ?? "",
        active: item.status?.S === "ACTIVE",
        scopes: item.scopes?.SS ?? [],
        encryptedTokens: item.encryptedTokens?.S ?? "",
        expiresAt: Number(item.expiresAt?.N ?? 0),
        authorizedAt,
      };
    },
    async completed(event: StravaEvent) {
      const response = await dependencies.get(
        new GetItemCommand({
          TableName: tableName,
          Key: inboxKey(event),
          ConsistentRead: true,
          ProjectionExpression: "#status",
          ExpressionAttributeNames: { "#status": "status" },
        }),
      );
      if (!response.Item) throw new Error("Inbox event is missing");
      return ["PROCESSED", "IGNORED"].includes(response.Item.status?.S ?? "");
    },

    async connection(athleteId: number): Promise<Connection | null> {
      const mapping = await dependencies.query(
        new QueryCommand({
          TableName: tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :athlete",
          ExpressionAttributeValues: marshall({
            ":athlete": `STRAVA#${athleteId}`,
          }),
          Limit: 2,
        }),
      );
      const candidates = mapping.Items ?? [];
      if (!candidates.length) return null;
      if (candidates.length !== 1)
        throw new Error("Ambiguous Strava connection");
      const key = candidates[0]!;
      const partition = key.PK?.S;
      if (!partition?.startsWith("USER#") || key.SK?.S !== "CONNECTION#STRAVA")
        throw new Error("Invalid Strava mapping");
      const response = await dependencies.get(
        new GetItemCommand({
          TableName: tableName,
          Key: { PK: key.PK!, SK: key.SK! },
          ConsistentRead: true,
        }),
      );
      const item = response.Item;
      if (!item) return null;
      const authorizedAt = item.authorizedAt?.S ?? "";
      if (!Number.isFinite(Date.parse(authorizedAt)))
        throw new Error("Invalid authorization timestamp");
      return {
        userId: partition.slice(5),
        athleteId: item.athleteId?.S ?? "",
        active: item.status?.S === "ACTIVE",
        scopes: item.scopes?.SS ?? [],
        encryptedTokens: item.encryptedTokens?.S ?? "",
        expiresAt: Number(item.expiresAt?.N ?? 0),
        authorizedAt,
      };
    },

    async decrypt(connection: Connection): Promise<Tokens> {
      const response = await dependencies.decrypt(
        new DecryptCommand({
          KeyId: kmsKeyArn,
          CiphertextBlob: Buffer.from(connection.encryptedTokens, "base64"),
          EncryptionContext: { userId: connection.userId, provider: "strava" },
        }),
      );
      if (!response.Plaintext) throw new Error("Token decryption unavailable");
      return tokenSchema.parse(
        JSON.parse(Buffer.from(response.Plaintext).toString("utf8")),
      );
    },

    async saveTokens(
      connection: Connection,
      tokens: Tokens & { expiresAt: number },
    ): Promise<Connection> {
      const response = await dependencies.encrypt(
        new EncryptCommand({
          KeyId: kmsKeyArn,
          EncryptionContext: { userId: connection.userId, provider: "strava" },
          Plaintext: Buffer.from(
            JSON.stringify({
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
            }),
          ),
        }),
      );
      if (!response.CiphertextBlob?.length)
        throw new Error("Token encryption unavailable");
      const encryptedTokens = Buffer.from(response.CiphertextBlob).toString(
        "base64",
      );
      const check = condition(connection);
      await dependencies.update(
        new UpdateItemCommand({
          ...check,
          UpdateExpression: "SET encryptedTokens = :next, expiresAt = :expiry",
          ExpressionAttributeValues: {
            ...check.ExpressionAttributeValues,
            ...marshall({
              ":next": encryptedTokens,
              ":expiry": tokens.expiresAt,
            }),
          },
        }),
      );
      return { ...connection, encryptedTokens, expiresAt: tokens.expiresAt };
    },

    async saveActivity(
      event: StravaEvent,
      connection: Connection,
      activity: Activity,
    ) {
      await writeWorkout(
        connection,
        event.object_id,
        event.event_time,
        activity,
        "WEBHOOK",
        true,
        "strava",
        process.env.WEB_PUSH_ENABLED === "true" && event.aspect_type === "create",
      );
    },

    async removeActivity(event: StravaEvent, connection: Connection) {
      await writeWorkout(
        connection,
        event.object_id,
        event.event_time,
        null,
        "WEBHOOK",
      );
    },

    async saveHistory(
      connection: Connection,
      activity: Activity,
      detailed: boolean,
    ) {
      return writeWorkout(
        connection,
        activity.id,
        0,
        activity,
        "HISTORY",
        detailed,
      );
    },

    async revoke(_event: StravaEvent | null, connection: Connection) {
      const check = condition(connection);
      await dependencies.update(
        new UpdateItemCommand({
          ...check,
          UpdateExpression:
            "SET #status = :revoked, revokedAt = :now REMOVE encryptedTokens",
          ExpressionAttributeValues: {
            ...check.ExpressionAttributeValues,
            ...marshall({
              ":revoked": "REVOKED",
              ":now": new Date().toISOString(),
            }),
          },
        }),
      );
    },

    async finish(event: StravaEvent, outcome: Outcome) {
      await dependencies.update(
        new UpdateItemCommand({
          TableName: tableName,
          Key: inboxKey(event),
          UpdateExpression:
            "SET #status = :status, processedAt = :now, ttlEpoch = :ttl REMOVE GSI1PK, GSI1SK",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: marshall({
            ":status": outcome,
            ":now": new Date().toISOString(),
            ":ttl": Math.floor(Date.now() / 1000) + 14 * 86400,
          }),
        }),
      );
    },

    async defer(event: StravaEvent, retryAt: number) {
      await dependencies.update(
        new UpdateItemCommand({
          TableName: tableName,
          Key: inboxKey(event),
          UpdateExpression: "SET GSI1PK = :pending, GSI1SK = :due",
          ConditionExpression: "#status = :received",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: marshall({
            ":pending": "STRAVA#WEBHOOK#PENDING",
            ":due": `RETRY#${String(Math.floor(retryAt)).padStart(12, "0")}#${eventIdentity(event)}`,
            ":received": "RECEIVED",
          }),
        }),
      );
    },

    async nextWebhook() {
      const response = await dependencies.query(
        new QueryCommand({
          TableName: tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pending AND GSI1SK <= :due",
          Limit: 1,
          ExpressionAttributeValues: marshall({
            ":pending": "STRAVA#WEBHOOK#PENDING",
            ":due": `RETRY#${String(Math.floor(Date.now() / 1000)).padStart(12, "0")}#~`,
          }),
        }),
      );
      const key = response.Items?.[0];
      if (!key?.PK || !key.SK) return null;
      const current = await dependencies.get(
        new GetItemCommand({
          TableName: tableName,
          Key: { PK: key.PK, SK: key.SK },
          ConsistentRead: true,
        }),
      );
      if (current.Item?.status?.S !== "RECEIVED") return null;
      return stravaEventSchema.parse(JSON.parse(current.Item.payload?.S ?? ""));
    },
  };
}
