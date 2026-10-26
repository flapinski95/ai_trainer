import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { chatRegenerationContext, createChatStore } from "./store";

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
                archived: { BOOL: true },
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
  assert.equal(sessions[0]?.archived, false);
  assert.equal(sessions[1]?.archived, true);
  assert.equal(messages[0]?.content, "Rest today.");
  assert.equal(queries[1]?.input.ExpressionAttributeValues?.[":message"]?.S, "MSG#new#");
  assert.equal(queries[1]?.input.ScanIndexForward, true);
});

test("archives and restores only an existing session owned by the user without changing messages", async () => {
  const writes: TransactWriteItemsCommand[] = [];
  const store = createChatStore({
    put: async () => assert.fail("Archiving must not write messages"),
    query: async () => ({}),
    transact: async (command) => { writes.push(command); },
  }, "test-table");

  assert.deepEqual(await store.setSessionArchived("user-1", "session-1", true), { sessionId: "session-1", archived: true });
  await store.setSessionArchived("user-1", "session-1", false);
  assert.equal(writes[0]?.input.TransactItems?.length, 1);
  const archive = writes[0]?.input.TransactItems?.[0]?.Update;
  assert.equal(archive?.Key?.PK?.S, "USER#user-1");
  assert.equal(archive?.Key?.SK?.S, "CHAT#session-1");
  assert.equal(archive?.ConditionExpression, "entityType = :type");
  assert.equal(archive?.ExpressionAttributeValues?.[":type"]?.S, "CHAT_SESSION");
  assert.equal(archive?.ExpressionAttributeValues?.[":archived"]?.BOOL, true);
  assert.equal(writes[1]?.input.TransactItems?.[0]?.Update?.ExpressionAttributeValues?.[":archived"]?.BOOL, false);
});

test("reads only the five latest prompt messages in chronological order", async () => {
  let query: QueryCommand | undefined;
  const store = createChatStore(
    {
      put: async () => undefined,
      transact: async () => undefined,
      query: async (command) => {
        query = command;
        return {
          Items: [
            { messageId: { S: "new" }, role: { S: "assistant" }, content: { S: "new" } },
            { messageId: { S: "old" }, role: { S: "user" }, content: { S: "old" } },
          ],
        };
      },
    },
    "test-table",
  );

  const messages = await store.recentMessages("user-1", "session-1");
  assert.equal(query?.input.Limit, 5);
  assert.equal(query?.input.ScanIndexForward, false);
  assert.deepEqual(messages.map((message) => message.messageId), ["old", "new"]);
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

test("regenerates from the original user prompt without including the answer or later messages", () => {
  const history = [
    { messageId: "user-1", role: "user" as const, content: "Earlier question", createdAt: "1" },
    { messageId: "answer-1", role: "assistant" as const, content: "Earlier answer", createdAt: "2" },
    { messageId: "user-2", role: "user" as const, content: "Original question", createdAt: "3" },
    { messageId: "answer-2", role: "assistant" as const, content: "Replace me", createdAt: "4" },
    { messageId: "user-3", role: "user" as const, content: "Later question", createdAt: "5" },
  ];
  const result = chatRegenerationContext(history, "answer-2");
  assert.equal(result.target.messageId, "answer-2");
  assert.equal(result.prompt.content, "Original question");
  assert.deepEqual(result.previousMessages.map((message) => message.messageId), ["user-1", "answer-1"]);
  assert.throws(() => chatRegenerationContext(history, "missing"));
  assert.throws(() => chatRegenerationContext(history, "user-1"));
  assert.throws(() => chatRegenerationContext([history[1]!], "answer-1"));
});

test("replaces an assistant message conditionally without changing its key or the message count", async () => {
  let write: TransactWriteItemsCommand | undefined;
  const store = createChatStore({
    put: async () => assert.fail("Replacement must not insert messages"),
    query: async () => ({}),
    transact: async (command) => { write = command; },
  }, "test-table");
  const original = { messageId: "answer-1", role: "assistant" as const, content: "Old answer", createdAt: "2026-10-26T12:00:00Z" };
  await store.replaceAssistantMessage("user-1", "session-1", original, " New answer ");
  const operations = write?.input.TransactItems;
  assert.equal(operations?.length, 2);
  assert.equal(operations?.[0]?.Update?.UpdateExpression, "SET updatedAt = :now");
  const replacement = operations?.[1]?.Update;
  assert.equal(replacement?.Key?.PK?.S, "USER#user-1");
  assert.equal(replacement?.Key?.SK?.S, "MSG#session-1#2026-10-26T12:00:00Z#answer-1");
  assert.equal(replacement?.ExpressionAttributeValues?.[":original"]?.S, "Old answer");
  assert.equal(replacement?.ExpressionAttributeValues?.[":text"]?.S, "New answer");
  assert.match(replacement?.ConditionExpression ?? "", /#role = :role AND #content = :original/);
  await assert.rejects(store.replaceAssistantMessage("user-1", "session-1", { ...original, role: "user" }, "New answer"));
  await assert.rejects(store.replaceAssistantMessage("user-1", "session-1", original, " "));
});

test("keeps the streamed assistant id when persisting a new answer", async () => {
  let write: TransactWriteItemsCommand | undefined;
  const store = createChatStore({
    put: async () => undefined, query: async () => ({}),
    transact: async (command) => { write = command; },
  }, "test-table");
  const message = await store.appendMessage("user-1", "session-1", "assistant", "Answer", "streamed-id");
  assert.equal(message.messageId, "streamed-id");
  assert.equal(write?.input.TransactItems?.[1]?.Put?.Item?.messageId?.S, "streamed-id");
});

test("loads every message page so regeneration can preserve the entire thread", async () => {
  const queries: QueryCommand[] = [];
  const cursor = { PK: { S: "USER#user-1" }, SK: { S: "MSG#session-1#cursor" } };
  const store = createChatStore({
    put: async () => undefined, transact: async () => undefined,
    query: async (command) => {
      queries.push(command);
      return queries.length === 1
        ? { Items: [{ messageId: { S: "first" }, role: { S: "user" } }], LastEvaluatedKey: cursor }
        : { Items: [{ messageId: { S: "last" }, role: { S: "assistant" } }] };
    },
  }, "test-table");
  const messages = await store.messages("user-1", "session-1");
  assert.deepEqual(messages.map((message) => message.messageId), ["first", "last"]);
  assert.deepEqual(queries[1]?.input.ExclusiveStartKey, cursor);
});