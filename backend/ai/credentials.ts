import {
  type AttributeValue,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";

export const aiProviders = ["openai", "anthropic", "google"] as const;
export type AIProvider = (typeof aiProviders)[number];

type Dependencies = {
  encrypt: (
    command: EncryptCommand,
  ) => Promise<{ CiphertextBlob?: Uint8Array }>;
  decrypt: (
    command: DecryptCommand,
  ) => Promise<{ Plaintext?: Uint8Array }>;
  get: (command: GetItemCommand) => Promise<{
    Item?: Record<string, AttributeValue>;
  }>;
  put: (command: PutItemCommand) => Promise<unknown>;
  delete: (command: DeleteItemCommand) => Promise<unknown>;
  query: (command: QueryCommand) => Promise<{
    Items?: Record<string, AttributeValue>[];
  }>;
};

export function createCredentialStore(
  dependencies: Dependencies,
  tableName: string,
  kmsKeyArn: string,
) {
  return {
    async set(userId: string, provider: AIProvider, apiKey: string) {
      const key = apiKey.trim();
      if (key.length < 8 || key.length > 4096)
        throw new Error("Invalid API key");
      const encrypted = await dependencies.encrypt(
        new EncryptCommand({
          KeyId: kmsKeyArn,
          EncryptionContext: { userId, provider },
          Plaintext: Buffer.from(key, "utf8"),
        }),
      );
      if (!encrypted.CiphertextBlob?.length)
        throw new Error("Credential encryption unavailable");
      await dependencies.put(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            PK: { S: `USER#${userId}` },
            SK: { S: `SECRET#${provider}` },
            entityType: { S: "AI_CREDENTIAL" },
            provider: { S: provider },
            encryptedKey: {
              S: Buffer.from(encrypted.CiphertextBlob).toString("base64"),
            },
            encryptionVersion: { N: "1" },
            updatedAt: { S: new Date().toISOString() },
          },
        }),
      );
    },

    async get(userId: string, provider: AIProvider): Promise<string | null> {
      const result = await dependencies.get(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            PK: { S: `USER#${userId}` },
            SK: { S: `SECRET#${provider}` },
          },
          ConsistentRead: true,
          ProjectionExpression: "encryptedKey",
        }),
      );
      const ciphertext = result.Item?.encryptedKey?.S;
      if (!ciphertext) return null;
      const decrypted = await dependencies.decrypt(
        new DecryptCommand({
          KeyId: kmsKeyArn,
          CiphertextBlob: Buffer.from(ciphertext, "base64"),
          EncryptionContext: { userId, provider },
        }),
      );
      if (!decrypted.Plaintext?.length)
        throw new Error("Credential decryption unavailable");
      return Buffer.from(decrypted.Plaintext).toString("utf8");
    },

    async remove(userId: string, provider: AIProvider) {
      await dependencies.delete(
        new DeleteItemCommand({
          TableName: tableName,
          Key: {
            PK: { S: `USER#${userId}` },
            SK: { S: `SECRET#${provider}` },
          },
        }),
      );
    },

    async status(userId: string) {
      const result = await dependencies.query(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :user AND begins_with(SK, :secret)",
          ExpressionAttributeValues: {
            ":user": { S: `USER#${userId}` },
            ":secret": { S: "SECRET#" },
          },
          ProjectionExpression: "SK, updatedAt",
          ConsistentRead: true,
        }),
      );
      return aiProviders.map((provider) => {
        const item = result.Items?.find(
          (candidate) => candidate.SK?.S === `SECRET#${provider}`,
        );
        return { provider, configured: Boolean(item), updatedAt: item?.updatedAt?.S };
      });
    },
  };
}