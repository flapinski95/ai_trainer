import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createChatStore } from "@/backend/chat/store";
import { authSettings } from "./server-config";

export function chatStore() {
  const settings = authSettings();
  if (!settings) throw new Error("Authentication is not configured");
  const client = new DynamoDBClient({
    region: settings.AWS_REGION,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 },
  });
  return createChatStore(
    {
      put: (command) => client.send(command),
      query: (command) => client.send(command),
      transact: (command) => client.send(command),
    },
    settings.DYNAMODB_TABLE_NAME,
  );
}