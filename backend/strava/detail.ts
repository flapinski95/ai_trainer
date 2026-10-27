import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { createWorkerStore } from "../strava-worker/store";
import { createStravaClient } from "../strava-worker/strava";
import { createWorkoutWriter } from "../workouts/persist";
import { normalizeSummary, summarySchema, workoutMetricsSchema, type WorkoutMetrics } from "../history/model";

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
): Promise<WorkoutMetrics | null> {
  if (!settings.strava || !/^[1-9]\d{0,15}$/.test(activityId)) return null;
  const options = { region: settings.AWS_REGION, maxAttempts: 1, requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 } };
  const dynamodb = new DynamoDBClient(options);
  const kms = new KMSClient(options);
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
  const client = createStravaClient(async () => ({ clientId, clientSecret }));
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
  try {
    await createWorkoutWriter({
      get: (command) => dynamodb.send(command, { abortSignal }),
      transact: (command) => dynamodb.send(command, { abortSignal }),
    }, settings.DYNAMODB_TABLE_NAME)(connection, activityId, Math.floor(Date.now() / 1000), workout, "WEBHOOK", true, "strava");
  } catch (error) {
    console.warn("strava_detail_persist_failed", { type: error instanceof Error ? error.name : "UnknownError" });
  }
  return workout;
}
