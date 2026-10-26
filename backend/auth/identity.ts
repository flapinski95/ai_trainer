import { randomUUID } from "node:crypto";
import {
  GetItemCommand,
  PutItemCommand,
  ConditionalCheckFailedException,
  type GetItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { z } from "zod";
import type { Provider } from "../providers/policy";

export const userIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
type Dependencies = {
  get: (command: GetItemCommand) => Promise<Pick<GetItemCommandOutput, "Item">>;
  put: (command: PutItemCommand) => Promise<unknown>;
};

export function createIdentityStore(dependencies: Dependencies, table: string) {
  return {
    async resolve(
      provider: Provider,
      providerId: string,
      signedInUserId?: string,
    ) {
      const externalId = z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/)
        .parse(providerId);
      if (signedInUserId) userIdSchema.parse(signedInUserId);
      const key = {
        PK: { S: `IDENTITY#${provider.toUpperCase()}#${externalId}` },
        SK: { S: "USER" },
      };
      const read = () =>
        dependencies.get(
          new GetItemCommand({
            TableName: table,
            Key: key,
            ConsistentRead: true,
            ProjectionExpression: "userId",
          }),
        );
      const existing = (await read()).Item?.userId?.S;
      if (existing) {
        userIdSchema.parse(existing);
        if (signedInUserId && existing !== signedInUserId)
          throw new Error(
            "Provider account belongs to another application user",
          );
        return existing;
      }
      let userId = signedInUserId;
      if (userId) {
        const connection = await dependencies.get(
          new GetItemCommand({
            TableName: table,
            Key: {
              PK: { S: `USER#${userId}` },
              SK: { S: `CONNECTION#${provider.toUpperCase()}` },
            },
            ConsistentRead: true,
            ProjectionExpression: "athleteId",
          }),
        );
        if (
          connection.Item?.athleteId?.S &&
          connection.Item.athleteId.S !== externalId
        )
          throw new Error(
            "A different account of this provider is already connected",
          );
      }
      if (!userId && provider === "strava") {
        const legacy = await dependencies.get(
          new GetItemCommand({
            TableName: table,
            Key: {
              PK: { S: `USER#strava-${externalId}` },
              SK: { S: "PROFILE" },
            },
            ConsistentRead: true,
            ProjectionExpression: "PK",
          }),
        );
        if (legacy.Item) userId = `strava-${externalId}`;
      }
      userId ??= randomUUID();
      try {
        await dependencies.put(
          new PutItemCommand({
            TableName: table,
            Item: {
              ...key,
              entityType: { S: "PROVIDER_IDENTITY" },
              userId: { S: userId },
            },
            ConditionExpression: "attribute_not_exists(PK)",
          }),
        );
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
        const winner = (await read()).Item?.userId?.S;
        if (!winner || (signedInUserId && winner !== signedInUserId))
          throw new Error("Provider identity linking conflict");
        return userIdSchema.parse(winner);
      }
      return userId;
    },
  };
}
