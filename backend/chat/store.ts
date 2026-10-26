import { randomUUID } from "node:crypto";
import {
  type AttributeValue,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";

export type ChatRole = "user" | "assistant";

type StoredChatMessage = {
  messageId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
};

export function chatRegenerationContext(messages: readonly StoredChatMessage[], messageId: string) {
  const index = messages.findIndex((message) => message.messageId === messageId);
  const target = messages[index];
  if (!target || target.role !== "assistant") throw new Error("regeneration_message_not_found");
  const preceding = messages.slice(0, index);
  const promptIndex = preceding.findLastIndex((message) => message.role === "user");
  const prompt = preceding[promptIndex];
  if (!prompt) throw new Error("regeneration_prompt_not_found");
  return { target, prompt, previousMessages: preceding.slice(0, promptIndex).slice(-5) };
}

type Dependencies = {
  put: (command: PutItemCommand) => Promise<unknown>;
  query: (command: QueryCommand) => Promise<{
    Items?: Record<string, AttributeValue>[];
    LastEvaluatedKey?: Record<string, AttributeValue>;
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
      messageId: string = randomUUID(),
    ) {
      const text = content.trim();
      if (!text || text.length > 100_000)
        throw new Error("Invalid message content");
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

    async replaceAssistantMessage(userId: string, sessionId: string, original: StoredChatMessage, content: string) {
      const text = content.trim();
      if (original.role !== "assistant" || !text || text.length > 100_000)
        throw new Error("Invalid replacement message");
      const updatedAt = new Date().toISOString();
      await dependencies.transact(new TransactWriteItemsCommand({
        TransactItems: [
          { Update: {
            TableName: tableName,
            Key: { PK: { S: `USER#${userId}` }, SK: { S: `CHAT#${sessionId}` } },
            UpdateExpression: "SET updatedAt = :now",
            ConditionExpression: "entityType = :type",
            ExpressionAttributeValues: { ":now": { S: updatedAt }, ":type": { S: "CHAT_SESSION" } },
          } },
          { Update: {
            TableName: tableName,
            Key: { PK: { S: `USER#${userId}` }, SK: { S: `MSG#${sessionId}#${original.createdAt}#${original.messageId}` } },
            UpdateExpression: "SET #content = :text",
            ConditionExpression: "entityType = :type AND #role = :role AND #content = :original",
            ExpressionAttributeNames: { "#content": "content", "#role": "role" },
            ExpressionAttributeValues: {
              ":text": { S: text }, ":original": { S: original.content },
              ":type": { S: "CHAT_MESSAGE" }, ":role": { S: "assistant" },
            },
          } },
        ],
      }));
      return { ...original, content: text };
    },

    async setSessionArchived(userId: string, sessionId: string, archived: boolean) {
      await dependencies.transact(
        new TransactWriteItemsCommand({
          TransactItems: [{
            Update: {
              TableName: tableName,
              Key: { PK: { S: `USER#${userId}` }, SK: { S: `CHAT#${sessionId}` } },
              UpdateExpression: "SET #archived = :archived",
              ConditionExpression: "entityType = :type",
              ExpressionAttributeNames: { "#archived": "archived" },
              ExpressionAttributeValues: {
                ":archived": { BOOL: archived },
                ":type": { S: "CHAT_SESSION" },
              },
            },
          }],
        }),
      );
      return { sessionId, archived };
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
            "sessionId, #title, createdAt, updatedAt, messageCount, #archived",
          ExpressionAttributeNames: { "#title": "title", "#archived": "archived" },
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
          archived: item.archived?.BOOL ?? false,
        }))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async messages(userId: string, sessionId: string) {
      const items: Record<string, AttributeValue>[] = [];
      let cursor: Record<string, AttributeValue> | undefined;
      do {
        const result = await dependencies.query(
        new QueryCommand({
          TableName: tableName,
          ExclusiveStartKey: cursor,
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
        items.push(...(result.Items ?? []));
        cursor = result.LastEvaluatedKey;
      } while (cursor && Object.keys(cursor).length > 0);
      return items.map((item) => ({
        messageId: item.messageId?.S ?? "",
        sessionId: item.sessionId?.S ?? sessionId,
        role: item.role?.S as ChatRole,
        content: item.content?.S ?? "",
        createdAt: item.createdAt?.S ?? "",
      }));
    },

    async recentMessages(userId: string, sessionId: string) {
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
          ScanIndexForward: false,
          Limit: 5,
        }),
      );
      return (result.Items ?? [])
        .map((item) => ({
          messageId: item.messageId?.S ?? "",
          sessionId: item.sessionId?.S ?? sessionId,
          role: item.role?.S as ChatRole,
          content: item.content?.S ?? "",
          createdAt: item.createdAt?.S ?? "",
        }))
        .reverse();
    },
  };
}