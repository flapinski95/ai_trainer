import { randomUUID } from "node:crypto";
import {
  type AttributeValue,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";

export type ChatRole = "user" | "assistant";

type Dependencies = {
  put: (command: PutItemCommand) => Promise<unknown>;
  query: (command: QueryCommand) => Promise<{
    Items?: Record<string, AttributeValue>[];
  }>;
  transact: (command: TransactWriteItemsCommand) => Promise<unknown>;
};

export function createChatStore(dependencies: Dependencies, tableName: string) {
  return {
    async createSession(userId: string, title = "Nowa rozmowa") {
      const sessionId = randomUUID();
      const now = new Date().toISOString();
      const normalizedTitle = title.trim().slice(0, 120) || "Nowa rozmowa";
      await dependencies.put(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            PK: { S: `USER#${userId}` },
            SK: { S: `CHAT#${sessionId}` },
            entityType: { S: "CHAT_SESSION" },
            sessionId: { S: sessionId },
            title: { S: normalizedTitle },
            createdAt: { S: now },
            updatedAt: { S: now },
            messageCount: { N: "0" },
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return { sessionId, title: normalizedTitle, createdAt: now, updatedAt: now };
    },

    async appendMessage(
      userId: string,
      sessionId: string,
      role: ChatRole,
      content: string,
    ) {
      const text = content.trim();
      if (!text || text.length > 100_000)
        throw new Error("Invalid message content");
      const messageId = randomUUID();
      const createdAt = new Date().toISOString();
      const messageKey = `MSG#${sessionId}#${createdAt}#${messageId}`;
      await dependencies.transact(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: {
                  PK: { S: `USER#${userId}` },
                  SK: { S: `CHAT#${sessionId}` },
                },
                UpdateExpression: "SET updatedAt = :now ADD messageCount :one",
                ConditionExpression: "entityType = :type",
                ExpressionAttributeValues: {
                  ":now": { S: createdAt },
                  ":one": { N: "1" },
                  ":type": { S: "CHAT_SESSION" },
                },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  PK: { S: `USER#${userId}` },
                  SK: { S: messageKey },
                  entityType: { S: "CHAT_MESSAGE" },
                  sessionId: { S: sessionId },
                  messageId: { S: messageId },
                  role: { S: role },
                  content: { S: text },
                  createdAt: { S: createdAt },
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
      return { messageId, sessionId, role, content: text, createdAt };
    },

    async sessions(userId: string) {
      const result = await dependencies.query(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :user AND begins_with(SK, :chat)",
          FilterExpression: "entityType = :type",
          ExpressionAttributeValues: {
            ":user": { S: `USER#${userId}` },
            ":chat": { S: "CHAT#" },
            ":type": { S: "CHAT_SESSION" },
          },
          ProjectionExpression:
            "sessionId, #title, createdAt, updatedAt, messageCount",
          ExpressionAttributeNames: { "#title": "title" },
          ConsistentRead: true,
        }),
      );
      return (result.Items ?? [])
        .map((item) => ({
          sessionId: item.sessionId?.S ?? "",
          title: item.title?.S ?? "Nowa rozmowa",
          createdAt: item.createdAt?.S ?? "",
          updatedAt: item.updatedAt?.S ?? "",
          messageCount: Number(item.messageCount?.N ?? 0),
        }))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async messages(userId: string, sessionId: string) {
      const result = await dependencies.query(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :user AND begins_with(SK, :message)",
          ExpressionAttributeValues: {
            ":user": { S: `USER#${userId}` },
            ":message": { S: `MSG#${sessionId}#` },
          },
          ProjectionExpression:
            "messageId, sessionId, #role, #content, createdAt",
          ExpressionAttributeNames: { "#role": "role", "#content": "content" },
          ConsistentRead: true,
          ScanIndexForward: true,
        }),
      );
      return (result.Items ?? []).map((item) => ({
        messageId: item.messageId?.S ?? "",
        sessionId: item.sessionId?.S ?? sessionId,
        role: item.role?.S as ChatRole,
        content: item.content?.S ?? "",
        createdAt: item.createdAt?.S ?? "",
      }));
    },
  };
}