import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeleteItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { createCredentialStore } from "./credentials";

test("encrypts a BYOK key with user-bound context before persisting ciphertext", async () => {
  let write: PutItemCommand | undefined;
  const store = createCredentialStore(
    {
      encrypt: async (command) => {
        assert.equal(command.input.KeyId, "test-key");
        assert.deepEqual(command.input.EncryptionContext, {
          userId: "user-1",
          provider: "openai",
        });
        assert.equal(Buffer.from(command.input.Plaintext!).toString(), "sk-test-secret");
        return { CiphertextBlob: Buffer.from("encrypted-test-bytes") };
      },
      decrypt: async () => assert.fail("Unexpected decryption"),
      get: async () => ({}),
      put: async (command) => {
        write = command;
      },
      delete: async () => undefined,
      query: async () => ({}),
    },
    "test-table",
    "test-key",
  );

  await store.set("user-1", "openai", "  sk-test-secret  ");

  const item = write?.input.Item;
  assert.equal(item?.PK?.S, "USER#user-1");
  assert.equal(item?.SK?.S, "SECRET#openai");
  assert.equal(
    item?.encryptedKey?.S,
    Buffer.from("encrypted-test-bytes").toString("base64"),
  );
  assert.equal(JSON.stringify(write?.input).includes("sk-test-secret"), false);
});

test("decrypts only the requested user's credential and never selects it in status", async () => {
  const store = createCredentialStore(
    {
      encrypt: async () => assert.fail("Unexpected encryption"),
      decrypt: async (command) => {
        assert.equal(command.input.KeyId, "test-key");
        assert.deepEqual(command.input.EncryptionContext, {
          userId: "user-1",
          provider: "anthropic",
        });
        assert.equal(
          Buffer.from(command.input.CiphertextBlob!).toString(),
          "ciphertext",
        );
        return { Plaintext: Buffer.from("anthropic-secret") };
      },
      get: async (command) => {
        assert.deepEqual(command.input.Key, {
          PK: { S: "USER#user-1" },
          SK: { S: "SECRET#anthropic" },
        });
        assert.equal(command.input.ConsistentRead, true);
        return { Item: { encryptedKey: { S: Buffer.from("ciphertext").toString("base64") } } };
      },
      put: async () => assert.fail("Unexpected write"),
      delete: async () => undefined,
      query: async (command) => {
        assert.equal(command.input.ProjectionExpression, "SK, updatedAt");
        return {
          Items: [
            {
              SK: { S: "SECRET#anthropic" },
              updatedAt: { S: "2026-10-26T00:00:00.000Z" },
              encryptedKey: { S: "must-not-be-projected" },
            },
          ],
        };
      },
    },
    "test-table",
    "test-key",
  );

  assert.equal(await store.get("user-1", "anthropic"), "anthropic-secret");
  const status = await store.status("user-1");
  assert.deepEqual(status, [
    { provider: "openai", configured: false, updatedAt: undefined },
    {
      provider: "anthropic",
      configured: true,
      updatedAt: "2026-10-26T00:00:00.000Z",
    },
    { provider: "google", configured: false, updatedAt: undefined },
  ]);
  assert.equal(JSON.stringify(status).includes("must-not-be-projected"), false);
});

test("deletes only the chosen user's provider credential", async () => {
  let removed: DeleteItemCommand | undefined;
  const store = createCredentialStore(
    {
      encrypt: async () => assert.fail("Unexpected encryption"),
      decrypt: async () => assert.fail("Unexpected decryption"),
      get: async () => ({}),
      put: async () => undefined,
      delete: async (command) => {
        removed = command;
      },
      query: async () => ({}),
    },
    "test-table",
    "test-key",
  );

  await store.remove("user-2", "google");
  assert.deepEqual(removed?.input.Key, {
    PK: { S: "USER#user-2" },
    SK: { S: "SECRET#google" },
  });
});

test("encryption failure never writes a key", async () => {
  const store = createCredentialStore(
    {
      encrypt: async () => ({}),
      decrypt: async () => ({}),
      get: async () => ({}),
      put: async () => assert.fail("No write is allowed without encryption"),
      delete: async () => undefined,
      query: async () => ({}),
    },
    "test-table",
    "test-key",
  );
  await assert.rejects(store.set("user-1", "google", "google-test-key"));
});