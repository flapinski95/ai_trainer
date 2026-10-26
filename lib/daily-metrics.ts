import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { auth } from "@/auth";
import { authStore } from "./auth-store";
import { authSettings } from "./server-config";
import { createArtifactStore } from "@/backend/garmin/artifacts";
import { createEnvelopeEncryption } from "@/backend/garmin/encryption";
import { createDailyMetricReader } from "@/backend/garmin/daily-reader";
import { createDailyMetricEndpoint } from "@/backend/garmin/daily-endpoint";

export async function dailyMetricsResponse(request: Request) {
  const settings = authSettings();
  if (!settings) return Response.json({ error: "Daily metrics unavailable" }, { status: 503, headers: { "cache-control": "private, no-store" } });
  const options = { region: settings.AWS_REGION, maxAttempts: 2, requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 } };
  const dynamodb = new DynamoDBClient(options);
  const kms = new KMSClient(options);
  const dependencies = { get: (command: import("@aws-sdk/client-dynamodb").GetItemCommand) => dynamodb.send(command), query: (command: import("@aws-sdk/client-dynamodb").QueryCommand) => dynamodb.send(command) };
  const artifacts = createArtifactStore({ ...dependencies, transact: (command) => dynamodb.send(command) }, settings.DYNAMODB_TABLE_NAME);
  const encryption = createEnvelopeEncryption({ generate: (command) => kms.send(command), decrypt: (command) => kms.send(command) }, settings.DYNAMODB_KMS_KEY_ARN);
  return createDailyMetricEndpoint({ session: async () => { const session = await auth(); return session?.user.id ? { userId: session.user.id } : null; },
    connection: (userId) => authStore().connection(userId, "garmin"),
    read: createDailyMetricReader({ ...dependencies, artifacts, encryption }, settings.DYNAMODB_TABLE_NAME),
  })(request);
}