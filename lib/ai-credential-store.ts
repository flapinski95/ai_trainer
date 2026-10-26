import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { createCredentialStore } from "@/backend/ai/credentials";
import { authSettings } from "./server-config";

export function aiCredentialStore() {
  const settings = authSettings();
  if (!settings) throw new Error("Authentication is not configured");
  const options = {
    region: settings.AWS_REGION,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 },
  };
  const dynamodb = new DynamoDBClient(options);
  const kms = new KMSClient(options);
  return createCredentialStore(
    {
      encrypt: (command) => kms.send(command),
      decrypt: (command) => kms.send(command),
      get: (command) => dynamodb.send(command),
      put: (command) => dynamodb.send(command),
      delete: (command) => dynamodb.send(command),
      query: (command) => dynamodb.send(command),
    },
    settings.DYNAMODB_TABLE_NAME,
    settings.DYNAMODB_KMS_KEY_ARN,
  );
}