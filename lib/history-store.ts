import "server-only";
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { createJobStore } from "@/backend/history/jobs";
import { authSettings } from "./server-config";
import type { Provider } from "@/backend/providers/policy";

export function historyStore() {
  const settings = authSettings();
  if (!settings) throw new Error("Authentication is not configured");
  const client = new DynamoDBClient({
    region: settings.AWS_REGION,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 },
  });
  const jobs = createJobStore(
    {
      get: (command) => client.send(command),
      query: (command) => client.send(command),
      put: (command) => client.send(command),
      update: (command) => client.send(command),
    },
    settings.DYNAMODB_TABLE_NAME,
  );
  return {
    request: jobs.request,
    async status(userId: string) {
      const result = await client.send(
        new GetItemCommand({
          TableName: settings.DYNAMODB_TABLE_NAME,
          Key: { PK: { S: `USER#${userId}` }, SK: { S: "SYNC#STRAVA" } },
          ConsistentRead: true,
          ProjectionExpression:
            "#state, #processed, #changed, #lastSuccess, #dueAt, #errorCode",
          ExpressionAttributeNames: {
            "#state": "state",
            "#processed": "processed",
            "#changed": "changed",
            "#lastSuccess": "lastSuccess",
            "#dueAt": "dueAt",
            "#errorCode": "errorCode",
          },
        }),
      );
      if (!result.Item) return null;
      const item = result.Item;
      return {
        state: item.state?.S ?? "FAILED",
        processed: Number(item.processed?.N ?? 0),
        changed: Number(item.changed?.N ?? 0),
        lastSuccess: Number(item.lastSuccess?.N ?? 0),
        retryAt: Number(item.dueAt?.N ?? 0),
        errorCode: item.errorCode?.S ?? null,
      };
    },
    async context(userId: string, provider: Provider = "strava") {
      const result = await client.send(
        new QueryCommand({
          TableName: settings.DYNAMODB_TABLE_NAME,
          KeyConditionExpression: "PK = :user AND begins_with(SK, :summary)",
          ExpressionAttributeValues: {
            ":user": { S: `USER#${userId}` },
            ":summary": {
              S:
                provider === "garmin"
                  ? "SUMMARY#GARMIN#LIFETIME#"
                  : "SUMMARY#LIFETIME#",
            },
          },
          ProjectionExpression: "activityCount, distance, movingTime",
          ConsistentRead: true,
        }),
      );
      return (result.Items ?? []).reduce(
        (total, item) => ({
          count: total.count + Number(item.activityCount?.N ?? 0),
          distance: total.distance + Number(item.distance?.N ?? 0),
          movingTime: total.movingTime + Number(item.movingTime?.N ?? 0),
        }),
        { count: 0, distance: 0, movingTime: 0 },
      );
    },
  };
}
