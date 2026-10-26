import "server-only";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { auth } from "@/auth";
import { createWorkoutStore } from "@/backend/workouts/store";
import { authStore } from "./auth-store";
import { authSettings } from "./server-config";
import { activityProvider } from "@/backend/providers/policy";

export async function workoutProvider() {
  const settings = authSettings();
  if (!settings) return null;
  const session = await auth();
  if (!session?.user.id) return null;
  const store = authStore();
  const [strava, garmin] = await Promise.all([
    store.connection(session.user.id),
    store.connection(session.user.id, "garmin"),
  ]);
  const provider = activityProvider({ strava, garmin });
  if (provider) return provider;
  const client = new DynamoDBClient({ region: settings.AWS_REGION, maxAttempts: 2 });
  const result = await client.send(new GetItemCommand({ TableName: settings.DYNAMODB_TABLE_NAME,
    ConsistentRead: true, Key: marshall({ PK: `USER#${session.user.id}`, SK: "IMPORT#GARMIN" }),
    ProjectionExpression: "entityType",
  }));
  return result.Item?.entityType?.S === "GARMIN_IMPORT" ? "garmin" as const : null;
}

export async function recentWorkouts() {
  const settings = authSettings();
  if (!settings) return [];
  const session = await auth();
  if (!session?.user.id) return [];
  const provider = await workoutProvider();
  if (!provider) return [];
  const client = new DynamoDBClient({
    region: settings.AWS_REGION,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 },
  });
  return createWorkoutStore(
    {
      query: (command) => client.send(command),
      batchGet: (command) => client.send(command),
    },
    settings.DYNAMODB_TABLE_NAME,
  ).recent(session.user.id, provider);
}
