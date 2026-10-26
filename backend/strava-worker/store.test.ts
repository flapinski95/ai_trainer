import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
  type TransactWriteItemsCommand,
  type UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { createWorkerStore } from "./store";
import type { Connection } from "./processor";
import type { StravaEvent } from "../strava-webhook/events";

const connection: Connection = {
  userId: "strava-456",
  athleteId: "456",
  active: true,
  scopes: ["activity:read"],
  encryptedTokens: "old-cipher",
  expiresAt: 4102444800,
  authorizedAt: "2026-10-24T00:00:00Z",
};
const event: StravaEvent = {
  object_type: "activity",
  object_id: 123,
  owner_id: 456,
  aspect_type: "update",
  event_time: 1792886400,
  subscription_id: 789,
  updates: {},
};
type Dependencies = Parameters<typeof createWorkerStore>[0];

function setup(overrides: Partial<Dependencies> = {}) {
  const writes: TransactWriteItemsCommand[] = [];
  const updates: UpdateItemCommand[] = [];
  const store = createWorkerStore(
    {
      get: async (command) =>
        command.input.Key?.SK?.S?.startsWith("ACTIVITY#")
          ? {}
          : { Item: { status: { S: "RECEIVED" } } },
      query: async () => ({ Items: [] }),
      transact: async (command) => {
        writes.push(command);
      },
      update: async (command) => {
        updates.push(command);
      },
      encrypt: async () => ({ CiphertextBlob: Buffer.from("new-cipher") }),
      decrypt: async (command) => {
        assert.deepEqual(command.input.EncryptionContext, {
          userId: "strava-456",
          provider: "strava",
        });
        assert.equal(command.input.KeyId, "test-key");
        return {
          Plaintext: Buffer.from(
            JSON.stringify({
              accessToken: "secret-access",
              refreshToken: "secret-refresh",
            }),
          ),
        };
      },
      ...overrides,
    },
    "test-table",
    "test-key",
  );
  return { store, writes, updates };
}

test("worker decrypts with the same user-bound KMS context as OAuth storage", async () => {
  const { store } = setup();
  assert.deepEqual(await store.decrypt(connection), {
    accessToken: "secret-access",
    refreshToken: "secret-refresh",
  });
});

test("token rotation is encrypted and conditional on the previous active authorization", async () => {
  const { store, updates } = setup();
  const result = await store.saveTokens(connection, {
    accessToken: "secret-new",
    refreshToken: "secret-rotated",
    expiresAt: 4102444801,
  });
  assert.equal(
    result.encryptedTokens,
    Buffer.from("new-cipher").toString("base64"),
  );
  assert.equal(
    updates[0]?.input.ConditionExpression,
    "#status = :active AND encryptedTokens = :tokens",
  );
  assert.equal(
    updates[0]?.input.ExpressionAttributeValues?.[":tokens"]?.S,
    "old-cipher",
  );
  assert.equal(JSON.stringify(updates).includes("secret-new"), false);
  assert.equal(JSON.stringify(updates).includes("secret-rotated"), false);
  const race = setup({
    update: async () => {
      throw new ConditionalCheckFailedException({
        message: "Reauthorized",
        $metadata: {},
      });
    },
  });
  await assert.rejects(
    race.store.saveTokens(connection, {
      accessToken: "new",
      refreshToken: "rotated",
      expiresAt: 4102444801,
    }),
  );
});

test("workout writes are versioned and transactional with authorization checks", async () => {
  const { store, writes } = setup();
  await store.saveActivity(event, connection, {
    id: 123,
    athlete: { id: 456 },
    name: "Ride",
    sport_type: "Ride",
    start_date: "2026-10-25T15:00:00Z",
    distance: 20000,
    moving_time: 3600,
    elapsed_time: 3700,
  });
  const transaction = writes[0]?.input.TransactItems;
  assert.equal(
    transaction?.[0]?.ConditionCheck?.ConditionExpression,
    "#status = :active AND encryptedTokens = :tokens",
  );
  assert.equal(
    transaction?.[1]?.Put?.ConditionExpression,
    "attribute_not_exists(PK)",
  );
  assert.equal(transaction?.[1]?.Put?.Item?.SK?.S, "ACTIVITY#STRAVA#123");
  assert.equal(
    transaction?.[1]?.Put?.Item?.GSI1SK?.S,
    "ACTIVITY#2026-10-25T15:00:00.000Z#STRAVA#123",
  );
});

test("deletions create versioned tombstones without indexing or retaining workout metrics", async () => {
  const { store, writes } = setup();
  await store.removeActivity(event, connection);
  const item = writes[0]?.input.TransactItems?.[1]?.Put?.Item;
  assert.equal(item?.status?.S, "DELETED");
  assert.equal(item?.GSI1PK, undefined);
  assert.equal(item?.distance, undefined);
});

test("stale events cannot overwrite newer workout state but auth races remain retryable", async () => {
  for (const firstCode of ["None", "ConditionalCheckFailed"]) {
    const { store } = setup({
      transact: async () => {
        throw new TransactionCanceledException({
          message: "Conflict",
          $metadata: {},
          CancellationReasons: [
            { Code: firstCode },
            { Code: "ConditionalCheckFailed" },
          ],
        });
      },
    });
    await assert.rejects(store.removeActivity(event, connection));
  }
  const stale = setup({
    get: async () => ({
      Item: { eventTime: { N: String(event.event_time + 1) } },
    }),
    transact: async () => assert.fail("Old events must not write"),
  });
  await stale.store.removeActivity(event, connection);
});

test("revocation removes encrypted credentials and preserves lookup for subsequent ignored events", async () => {
  const { store, updates } = setup();
  await store.revoke(event, connection);
  assert.match(
    updates[0]?.input.UpdateExpression ?? "",
    /REMOVE encryptedTokens/,
  );
  assert.equal(updates[0]?.input.UpdateExpression?.includes("GSI1"), false);
});

test("GSI provider mapping is followed by a consistent connection read", async () => {
  const { store } = setup({
    query: async (command) => {
      assert.equal(command.input.IndexName, "GSI1");
      assert.equal(
        command.input.ExpressionAttributeValues?.[":athlete"]?.S,
        "STRAVA#456",
      );
      return {
        Items: [
          { PK: { S: "USER#strava-456" }, SK: { S: "CONNECTION#STRAVA" } },
        ],
      };
    },
    get: async (command) => {
      assert.equal(command.input.ConsistentRead, true);
      return {
        Item: {
          athleteId: { S: "456" },
          authorizedAt: { S: "2026-10-24T00:00:00Z" },
          status: { S: "ACTIVE" },
          scopes: { SS: ["activity:read"] },
          encryptedTokens: { S: "cipher" },
          expiresAt: { N: "4102444800" },
        },
      };
    },
  });
  assert.equal((await store.connection(456))?.userId, "strava-456");
});
