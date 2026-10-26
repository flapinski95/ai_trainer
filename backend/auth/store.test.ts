import assert from "node:assert/strict";
import { test } from "node:test";
import type { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { createAuthStore } from "./store";
import { parseStravaAuthorization } from "./strava-account";

const account = parseStravaAuthorization(
  {
    provider: "strava",
    providerAccountId: "123",
    access_token: "secret-access",
    refresh_token: "secret-refresh",
    expires_at: 4102444800,
    scope: "activity:read",
  },
  { id: 123, firstname: "Test", lastname: "Athlete" },
);

test("encrypts credentials with user-bound context before atomically saving the user and connection", async () => {
  let encrypted = false;
  let write: TransactWriteItemsCommand | undefined;
  const store = createAuthStore(
    {
      encrypt: async (command) => {
        assert.equal(command.input.KeyId, "test-key");
        assert.deepEqual(command.input.EncryptionContext, {
          userId: "strava-123",
          provider: "strava",
        });
        assert.deepEqual(
          JSON.parse(Buffer.from(command.input.Plaintext!).toString()),
          { accessToken: "secret-access", refreshToken: "secret-refresh" },
        );
        encrypted = true;
        return { CiphertextBlob: Buffer.from("encrypted-test-bytes") };
      },
      transact: async (command) => {
        assert.equal(encrypted, true);
        write = command;
      },
      get: async () => ({}),
    },
    "test-table",
    "test-key",
  );
  await store.connect(account);
  assert.equal(write?.input.TransactItems?.length, 2);
  assert.equal(JSON.stringify(write?.input).includes("secret-access"), false);
  assert.equal(JSON.stringify(write?.input).includes("secret-refresh"), false);
  const connection = write?.input.TransactItems?.[1]?.Put?.Item;
  assert.equal(connection?.GSI1PK?.S, "STRAVA#123");
  assert.equal(connection?.GSI1SK?.S, "USER#strava-123");
  assert.equal(
    connection?.encryptedTokens?.S,
    Buffer.from("encrypted-test-bytes").toString("base64"),
  );
});

test("encryption failures never write plaintext credentials", async () => {
  for (const encrypt of [
    async () => {
      throw new Error("KMS unavailable");
    },
    async () => ({}),
  ]) {
    const store = createAuthStore(
      {
        encrypt,
        transact: async () =>
          assert.fail("No write is allowed without encryption"),
        get: async () => ({}),
      },
      "test-table",
      "test-key",
    );
    await assert.rejects(store.connect(account));
  }
});

test("storage errors fail the login rather than returning a false success", async () => {
  const store = createAuthStore(
    {
      encrypt: async () => ({ CiphertextBlob: Buffer.from("encrypted") }),
      transact: async () => {
        throw new Error("DynamoDB unavailable");
      },
      get: async () => ({}),
    },
    "test-table",
    "test-key",
  );
  await assert.rejects(store.connect(account), /DynamoDB unavailable/);
});

test("connection summaries never read or return OAuth credentials", async () => {
  const store = createAuthStore(
    {
      encrypt: async () => assert.fail("Summary must not encrypt or decrypt"),
      transact: async () => assert.fail("Summary must not write"),
      get: async (command) => {
        assert.equal(command.input.ConsistentRead, true);
        assert.equal(
          command.input.ProjectionExpression?.includes("encryptedTokens"),
          false,
        );
        return {
          Item: {
            athleteId: { S: "123" },
            name: { S: "Test Athlete" },
            status: { S: "ACTIVE" },
            scopes: { SS: ["activity:read"] },
            encryptedTokens: { S: "must-never-leak" },
          },
        };
      },
    },
    "test-table",
    "test-key",
  );
  const result = await store.connection("strava-123");
  assert.equal(result?.active, true);
  assert.equal(JSON.stringify(result).includes("must-never-leak"), false);
});

test("Garmin credentials and permissions use independent keys and KMS context", async () => {
  const store = createAuthStore(
    {
      get: async () => ({}),
      encrypt: async (command) => {
        assert.deepEqual(command.input.EncryptionContext, {
          userId: "application-user",
          provider: "garmin",
        });
        return { CiphertextBlob: Buffer.from("cipher") };
      },
      transact: async (command) => {
        const item = command.input.TransactItems?.[1]?.Put?.Item;
        assert.equal(item?.PK?.S, "USER#application-user");
        assert.equal(item?.SK?.S, "CONNECTION#GARMIN");
        assert.equal(item?.GSI1PK?.S, "GARMIN#garmin-external");
        assert.equal(
          JSON.stringify(command.input).includes("secret-access"),
          false,
        );
      },
    },
    "table",
    "key",
  );
  await store.connect({
    ...account,
    userId: "application-user",
    athleteId: "garmin-external",
    provider: "garmin",
    scopes: ["HEALTH_EXPORT", "MCT_EXPORT"],
  });
});
