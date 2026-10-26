import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { createChatStore } from "./store";

test("creates a user-owned chat session with stable schema keys", async () => {
  let write: PutItemCommand | undefined;
  const store = createChatStore(
    {
      put: async (command) => {
        write = command;
      },
      query: async () => ({}),
      transact: async () => undefined,
    },
    "test-table",
  );

  const session = await store.createSession("user-1", "  Trening  ");
  const item = write?.input.Item;
  assert.equal(item?.PK?.S, "USER#user-1");
  assert.equal(item?.SK?.S, `CHAT#${session.sessionId}`);
  assert.equal(item?.entityType?.S, "CHAT_SESSION");
  assert.equal(item?.title?.S, "Trening");
  assert.equal(item?.messageCount?.N, "0");
});

test("persists a message and increments its session atomically", async () => {
  let write: TransactWriteItemsCommand | undefined;
  const store = createChatStore(
    {
      put: async () => undefined,
      query: async () => ({}),
      transact: async (command) => {
        write = command;
      },
    },
    "test-table",
  );

  const message = await store.appendMessage(
    "user-1",
    "session-1",
    "user",
    "  How should I recover?  ",
  );
  const operations = write?.input.TransactItems;
  assert.equal(operations?.length, 2);
  assert.equal(operations?.[0]?.Update?.Key?.PK?.S, "USER#user-1");
  assert.equal(operations?.[0]?.Update?.Key?.SK?.S, "CHAT#session-1");
  const item = operations?.[1]?.Put?.Item;
  assert.equal(item?.PK?.S, "USER#user-1");
  assert.match(item?.SK?.S ?? "", /^MSG#session-1#.+#/);
  assert.equal(item?.entityType?.S, "CHAT_MESSAGE");
  assert.equal(item?.role?.S, "user");
  assert.equal(item?.content?.S, "How should I recover?");
  assert.equal(message.messageId, item?.messageId?.S);
});

test("lists sessions newest-updated first and queries only messages in one session", async () => {
  const queries: QueryCommand[] = [];
  const store = createChatStore(
    {
      put: async () => undefined,
      transact: async () => undefined,
      query: async (command) => {
        queries.push(command);
        if (command.input.ProjectionExpression?.includes("sessionId, #title"))
          return {
            Items: [
              {
                sessionId: { S: "old" },
                title: { S: "Older" },
                createdAt: { S: "2026-01-01T00:00:00.000Z" },
                updatedAt: { S: "2026-01-01T00:00:00.000Z" },
                messageCount: { N: "2" },
              },
              {
                sessionId: { S: "new" },
                title: { S: "Newer" },
                createdAt: { S: "2026-02-01T00:00:00.000Z" },
                updatedAt: { S: "2026-02-02T00:00:00.000Z" },
                messageCount: { N: "1" },
              },
            ],
          };
        return {
          Items: [
            {
              messageId: { S: "message-1" },
              sessionId: { S: "new" },
              role: { S: "assistant" },
              content: { S: "Rest today." },
              createdAt: { S: "2026-02-02T00:00:00.000Z" },
            },
          ],
        };
      },
    },
    "test-table",
  );

  const sessions = await store.sessions("user-1");
  const messages = await store.messages("user-1", "new");
  assert.deepEqual(sessions.map((session) => session.sessionId), ["new", "old"]);
  assert.equal(messages[0]?.content, "Rest today.");
  assert.equal(queries[1]?.input.ExpressionAttributeValues?.[":message"]?.S, "MSG#new#");
  assert.equal(queries[1]?.input.ScanIndexForward, true);
});

test("rejects empty or oversized message text without writing", async () => {
  const store = createChatStore(
    {
      put: async () => undefined,
      query: async () => ({}),
      transact: async () => assert.fail("Invalid messages must not be written"),
    },
    "test-table",
  );
  await assert.rejects(store.appendMessage("user-1", "session-1", "user", " "));
  await assert.rejects(
    store.appendMessage("user-1", "session-1", "user", "x".repeat(100_001)),
  );
});