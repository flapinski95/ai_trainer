import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { createAuthStore } from "@/backend/auth/store";
import { authSettings } from "./server-config";
import { createIdentityStore } from "@/backend/auth/identity";
import { createPhysiologyStore } from "@/backend/auth/physiology";

export function authStore() {
  const settings = authSettings();
  if (!settings) throw new Error("Authentication is not configured");
  const options = {
    region: settings.AWS_REGION,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 },
  };
  const dynamodb = new DynamoDBClient(options);
  const kms = new KMSClient(options);
  const connections = createAuthStore(
    {
      encrypt: (command) => kms.send(command),
      transact: (command) => dynamodb.send(command),
      get: (command) => dynamodb.send(command),
    },
    settings.DYNAMODB_TABLE_NAME,
    settings.DYNAMODB_KMS_KEY_ARN,
  );
  return {
    ...connections,
    ...createPhysiologyStore({ get: (command) => dynamodb.send(command), update: (command) => dynamodb.send(command) }, settings.DYNAMODB_TABLE_NAME),
    ...createIdentityStore(
      {
        get: (command) => dynamodb.send(command),
        put: (command) => dynamodb.send(command),
      },
      settings.DYNAMODB_TABLE_NAME,
    ),
  };
}
