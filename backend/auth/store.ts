import {
  GetItemCommand,
  TransactWriteItemsCommand,
  type GetItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { EncryptCommand } from "@aws-sdk/client-kms";
import type { StravaAuthorization } from "./strava-account";
import type { Provider } from "../providers/policy";

type ProviderAuthorization = StravaAuthorization & { provider?: Provider };

type Dependencies = {
  encrypt: (
    command: EncryptCommand,
  ) => Promise<{ CiphertextBlob?: Uint8Array }>;
  transact: (command: TransactWriteItemsCommand) => Promise<unknown>;
  get: (command: GetItemCommand) => Promise<Pick<GetItemCommandOutput, "Item">>;
};

export function createAuthStore(
  dependencies: Dependencies,
  tableName: string,
  kmsKeyArn: string,
) {
  return {
    async connect(account: ProviderAuthorization): Promise<void> {
      const provider = account.provider ?? "strava";
      const encrypted = await dependencies.encrypt(
        new EncryptCommand({
          KeyId: kmsKeyArn,
          EncryptionContext: { userId: account.userId, provider },
          Plaintext: Buffer.from(
            JSON.stringify({
              accessToken: account.accessToken,
              refreshToken: account.refreshToken,
            }),
          ),
        }),
      );
      if (!encrypted.CiphertextBlob?.length)
        throw new Error("Credential encryption unavailable");
      const now = new Date().toISOString();
      await dependencies.transact(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: {
                  PK: { S: `USER#${account.userId}` },
                  SK: { S: "PROFILE" },
                },
                UpdateExpression: `SET entityType = :type, #name = ${provider === "garmin" ? "if_not_exists(#name, :name)" : ":name"}, createdAt = if_not_exists(createdAt, :now), updatedAt = :now`,
                ExpressionAttributeNames: { "#name": "name" },
                ExpressionAttributeValues: {
                  ":type": { S: "USER_PROFILE" },
                  ":name": { S: account.name },
                  ":now": { S: now },
                },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  PK: { S: `USER#${account.userId}` },
                  SK: { S: `CONNECTION#${provider.toUpperCase()}` },
                  GSI1PK: {
                    S: `${provider.toUpperCase()}#${account.athleteId}`,
                  },
                  GSI1SK: { S: `USER#${account.userId}` },
                  entityType: { S: "PROVIDER_CONNECTION" },
                  provider: { S: provider },
                  athleteId: { S: account.athleteId },
                  name: { S: account.name },
                  status: { S: "ACTIVE" },
                  ...(account.scopes.length
                    ? { scopes: { SS: account.scopes } }
                    : {}),
                  expiresAt: { N: String(account.expiresAt) },
                  authorizedAt: { S: now },
                  encryptedTokens: {
                    S: Buffer.from(encrypted.CiphertextBlob).toString("base64"),
                  },
                  encryptionVersion: { N: "1" },
                },
                ConditionExpression:
                  "attribute_not_exists(athleteId) OR athleteId = :athlete",
                ExpressionAttributeValues: {
                  ":athlete": { S: account.athleteId },
                },
              },
            },
          ],
        }),
      );
    },

    async connection(userId: string, provider: Provider = "strava") {
      const response = await dependencies.get(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            PK: { S: `USER#${userId}` },
            SK: { S: `CONNECTION#${provider.toUpperCase()}` },
          },
          ConsistentRead: true,
          ProjectionExpression:
            "athleteId, #name, #status, scopes, expiresAt, authorizedAt",
          ExpressionAttributeNames: { "#name": "name", "#status": "status" },
        }),
      );
      const item = response.Item;
      if (!item) return null;
      return {
        provider,
        athleteId: item.athleteId?.S ?? "",
        name: item.name?.S ?? "Zawodnik",
        active: item.status?.S === "ACTIVE",
        scopes: item.scopes?.SS ?? [],
        expiresAt: Number(item.expiresAt?.N ?? 0),
        authorizedAt: item.authorizedAt?.S ?? "",
      };
    },

    async profileName(userId: string) {
      const response = await dependencies.get(
        new GetItemCommand({
          TableName: tableName,
          Key: { PK: { S: `USER#${userId}` }, SK: { S: "PROFILE" } },
          ConsistentRead: true,
          ProjectionExpression: "#name",
          ExpressionAttributeNames: { "#name": "name" },
        }),
      );
      return response.Item?.name?.S ?? "Zawodnik";
    },
  };
}
