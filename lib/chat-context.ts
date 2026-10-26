import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { activityProvider } from "@/backend/providers/policy";
import { createArtifactStore } from "@/backend/garmin/artifacts";
import { createDailyMetricReader } from "@/backend/garmin/daily-reader";
import { createEnvelopeEncryption } from "@/backend/garmin/encryption";
import { authStore } from "./auth-store";
import { historyStore } from "./history-store";
import { authSettings } from "./server-config";
import { recentWorkouts } from "./workouts";

export async function athleteChatContext(userId: string) {
  const settings = authSettings();
  if (!settings) throw new Error("Authentication is not configured");
  const options = {
    region: settings.AWS_REGION,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 },
  };
  const dynamodb = new DynamoDBClient(options);
  const kms = new KMSClient(options);
  const store = authStore();
  const [strava, garmin] = await Promise.all([
    store.connection(userId),
    store.connection(userId, "garmin"),
  ]);
  const provider = activityProvider({ strava, garmin });
  const [workouts, totals] = await Promise.all([
    provider ? recentWorkouts() : Promise.resolve([]),
    provider
      ? historyStore().context(userId, provider)
      : Promise.resolve({ count: 0, distance: 0, movingTime: 0 }),
  ]);
  const metricReader = createDailyMetricReader(
    {
      get: (command) => dynamodb.send(command),
      query: (command) => dynamodb.send(command),
      artifacts: createArtifactStore(
        {
          get: (command) => dynamodb.send(command),
          query: (command) => dynamodb.send(command),
          transact: (command) => dynamodb.send(command),
        },
        settings.DYNAMODB_TABLE_NAME,
      ),
      encryption: createEnvelopeEncryption(
        {
          generate: (command) => kms.send(command),
          decrypt: (command) => kms.send(command),
        },
        settings.DYNAMODB_KMS_KEY_ARN,
      ),
    },
    settings.DYNAMODB_TABLE_NAME,
  );
  const dailyMetrics =
    garmin?.active && garmin.scopes.includes("HEALTH_EXPORT")
      ? await metricReader(userId).catch(() => null)
      : null;

  return {
    activitySource: provider,
    trainingTotals: totals,
    recentWorkouts: workouts.slice(0, 5).map((workout) => ({
      date: workout.startedAt,
      sport: workout.sport,
      name: workout.name,
      distanceMeters: workout.distance,
      movingTimeSeconds: workout.movingTime,
      elevationGainMeters: workout.elevationGain,
    })),
    healthMetrics: dailyMetrics?.values ?? null,
  };
}