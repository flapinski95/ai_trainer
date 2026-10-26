import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentityStore } from "./identity";

test("Garmin can create an independent application user without Strava", async () => {
  const store = createIdentityStore(
    {
      get: async () => ({}),
      put: async (command) => {
        assert.equal(
          command.input.Item?.PK?.S,
          "IDENTITY#GARMIN#garmin-user-1",
        );
        assert.equal(
          command.input.ConditionExpression,
          "attribute_not_exists(PK)",
        );
      },
    },
    "table",
  );
  const userId = await store.resolve("garmin", "garmin-user-1");
  assert.match(userId, /^[a-f0-9-]{36}$/);
});

test("existing Strava users keep their IDs and stored data", async () => {
  const store = createIdentityStore(
    {
      get: async (command) =>
        command.input.Key?.SK?.S === "PROFILE"
          ? { Item: { PK: { S: "USER#strava-123" } } }
          : {},
      put: async () => {},
    },
    "table",
  );
  assert.equal(await store.resolve("strava", "123"), "strava-123");
});

test("explicit linking reuses the signed-in user but never silently merges accounts", async () => {
  const newLink = createIdentityStore(
    { get: async () => ({}), put: async () => {} },
    "table",
  );
  assert.equal(
    await newLink.resolve("garmin", "external", "existing-user"),
    "existing-user",
  );
  const conflict = createIdentityStore(
    {
      get: async () => ({ Item: { userId: { S: "other-user" } } }),
      put: async () => assert.fail("Must not relink"),
    },
    "table",
  );
  await assert.rejects(
    conflict.resolve("garmin", "external", "existing-user"),
    /another application user/,
  );
});

test("a second account from the same provider is rejected before reserving an identity", async () => {
  const store = createIdentityStore(
    {
      get: async (command) =>
        command.input.Key?.SK?.S === "CONNECTION#GARMIN"
          ? { Item: { athleteId: { S: "first-garmin" } } }
          : {},
      put: async () => assert.fail("Must not create an orphan identity"),
    },
    "table",
  );
  await assert.rejects(
    store.resolve("garmin", "second-garmin", "application-user"),
    /already connected/,
  );
});
