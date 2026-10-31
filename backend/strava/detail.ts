import { DynamoDBClient, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { marshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import { createWorkerStore } from "../strava-worker/store";
import { createStravaClient } from "../strava-worker/strava";
import { createWorkoutWriter } from "../workouts/persist";
import { normalizeSummary, summarySchema, workoutMetricsSchema, type WorkoutMetrics } from "../history/model";
import { StravaRequestError } from "../strava-worker/processor";

const streamSchema = z.object({
  data: z.array(z.number().finite().nonnegative().nullable()).max(10000),
  original_size: z.number().int().nonnegative().optional(),
  resolution: z.string().optional(),
  series_type: z.string().optional(),
});

export const activityStreamsSchema = z.object({
  time: streamSchema.optional(),
  heartrate: streamSchema.optional(),
  cadence: streamSchema.optional(),
  watts: streamSchema.optional(),
});
export type ActivityStreams = z.infer<typeof activityStreamsSchema>;
export type ActivityStreamKey = keyof ActivityStreams;

type Settings = {
  AWS_REGION: string;
  DYNAMODB_TABLE_NAME: string;
  DYNAMODB_KMS_KEY_ARN: string;
  strava: { AUTH_STRAVA_ID: string; AUTH_STRAVA_SECRET: string } | null;
};

export async function fetchStravaActivityDetail(
  userId: string,
  activityId: string,
  settings: Settings,
  signal?: AbortSignal,
  options: { streamKeys?: ActivityStreamKey[]; requirePersistence?: boolean } = {},
): Promise<(WorkoutMetrics & { telemetry_streams?: ActivityStreams }) | null> {
  if (!settings.strava || !/^[1-9]\d{0,15}$/.test(activityId)) return null;
  const clientOptions = { region: settings.AWS_REGION, maxAttempts: 1, requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 } };
  const dynamodb = new DynamoDBClient(clientOptions);
  const kms = new KMSClient(clientOptions);
  const abortSignal = signal;
  const store = createWorkerStore({
    get: (command) => dynamodb.send(command, { abortSignal }),
    query: (command) => dynamodb.send(command, { abortSignal }),
    update: (command) => dynamodb.send(command, { abortSignal }),
    transact: (command) => dynamodb.send(command, { abortSignal }),
    encrypt: (command) => kms.send(command, { abortSignal }),
    decrypt: (command) => kms.send(command, { abortSignal }),
  }, settings.DYNAMODB_TABLE_NAME, settings.DYNAMODB_KMS_KEY_ARN);
  const { AUTH_STRAVA_ID: clientId, AUTH_STRAVA_SECRET: clientSecret } = settings.strava;
  const client = createStravaClient(async () => ({ clientId, clientSecret }), fetch, undefined, signal);
  let connection = await store.connectionByUser(userId);
  if (!connection?.active) return null;
  let tokens = await store.decrypt(connection);
  if (connection.expiresAt <= Date.now() / 1000 + 60) {
    const refreshed = await client.refresh(tokens.refreshToken);
    connection = await store.saveTokens(connection, refreshed);
    tokens = refreshed;
  }
  const raw = await client.fetchActivity(Number(activityId), tokens.accessToken);
  const parsed = summarySchema.safeParse(raw);
  if (!parsed.success) {
    if (process.env.NODE_ENV !== "production")
      console.error("strava_detail_validation_failed", parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })));
    throw parsed.error;
  }
  const workout = workoutMetricsSchema.parse(normalizeSummary(raw, connection.athleteId));
  const streamKeys = [...new Set(options.streamKeys ?? [])].filter((key) => key !== "watts" || workout.device_watts === true);
  let streams: ActivityStreams | undefined;
  if (streamKeys.length) {
    try {
      const received = activityStreamsSchema.parse(await client.fetchStreams(Number(activityId), tokens.accessToken, ["time", ...streamKeys]));
      streams = Object.fromEntries(Object.entries(received).filter(([key]) => key === "time" || streamKeys.includes(key as ActivityStreamKey)));
    } catch (error) {
      if (!(error instanceof StravaRequestError && [402, 403, 404].includes(error.status))) throw error;
      streams = {};
    }
  }
  try {
    await createWorkoutWriter({
      get: (command) => dynamodb.send(command, { abortSignal }),
      transact: (command) => dynamodb.send(command, { abortSignal }),
    }, settings.DYNAMODB_TABLE_NAME)(connection, activityId, Math.floor(Date.now() / 1000), workout, "WEBHOOK", true, "strava");
    if (streams && Object.keys(streams).length) {
      if (Buffer.byteLength(JSON.stringify(streams)) > 300000) throw new Error("activity_streams_too_large");
      await dynamodb.send(new TransactWriteItemsCommand({ TransactItems: [
        { ConditionCheck: {
          TableName: settings.DYNAMODB_TABLE_NAME,
          Key: marshall({ PK: `USER#${userId}`, SK: `ACTIVITY#STRAVA#${activityId}` }),
          ConditionExpression: "#status = :active",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: marshall({ ":active": "ACTIVE" }),
        } },
        { Update: {
          TableName: settings.DYNAMODB_TABLE_NAME,
          Key: marshall({ PK: `USER#${userId}`, SK: `TELEMETRY#STRAVA#${activityId}` }),
          UpdateExpression: "SET #streams = :streams, updatedAt = :updated, entityType = :type",
          ExpressionAttributeNames: { "#streams": "streams" },
          ExpressionAttributeValues: marshall({ ":streams": streams, ":updated": new Date().toISOString(), ":type": "STRAVA_TELEMETRY" }),
        } },
      ] }), { abortSignal });
    }
  } catch (error) {
    if (options.requirePersistence) throw error;
    console.warn("strava_detail_persist_failed", { type: error instanceof Error ? error.name : "UnknownError" });
  }
  return { ...workout, telemetry_streams: streams };
}
