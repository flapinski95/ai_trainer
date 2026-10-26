import assert from "node:assert/strict";
import { test } from "node:test";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createWorkoutStore } from "./store";

const key = { PK: { S: "USER#strava-456" }, SK: { S: "ACTIVITY#STRAVA#123" } };
const workout = {
  PK: "USER#strava-456",
  SK: "ACTIVITY#STRAVA#123",
  entityType: "WORKOUT",
  provider: "strava",
  status: "ACTIVE",
  activityId: "123",
  name: "Ride",
  sport_type: "Ride",
  start_date: "2026-10-25T15:00:00Z",
  distance: 20000,
  moving_time: 3600,
  elapsed_time: 3700,
};

test("workout reads use only the signed-in user's recent activity index and safe projection", async () => {
  const store = createWorkoutStore(
    {
      query: async (command) => {
        assert.equal(command.input.IndexName, "GSI1");
        assert.equal(
          command.input.ExpressionAttributeValues?.[":user"]?.S,
          "USER#strava-456",
        );
        assert.equal(command.input.ScanIndexForward, false);
        assert.equal(command.input.Limit, 50);
        return { Items: [key] };
      },
      batchGet: async (command) => {
        assert.equal(
          command.input.RequestItems?.table?.ProjectionExpression?.includes(
            "encryptedTokens",
          ),
          false,
        );
        return {
          Responses: {
            table: [marshall({ ...workout, encryptedTokens: "must-not-leak" })],
          },
        };
      },
    },
    "table",
  );
  const results = await store.recent("strava-456");
  assert.equal(results[0]?.name, "Ride");
  assert.equal(JSON.stringify(results).includes("must-not-leak"), false);
});

test("foreign partitions, tombstones and malformed records are never displayed", async () => {
  const store = createWorkoutStore(
    {
      query: async () => ({ Items: [key] }),
      batchGet: async () => ({
        Responses: {
          table: [
            marshall({ ...workout, PK: "USER#other" }),
            marshall({ ...workout, status: "DELETED" }),
            marshall({ invalid: true }),
          ],
        },
      }),
    },
    "table",
  );
  assert.deepEqual(await store.recent("strava-456"), []);
});

test("batch results are ordered chronologically rather than by database response order", async () => {
  const store = createWorkoutStore(
    {
      query: async () => ({ Items: [key] }),
      batchGet: async () => ({
        Responses: {
          table: [
            marshall(workout),
            marshall({
              ...workout,
              activityId: "124",
              SK: "ACTIVITY#STRAVA#124",
              start_date: "2026-10-26T15:00:00Z",
            }),
          ],
        },
      }),
    },
    "table",
  );
  assert.deepEqual(
    (await store.recent("strava-456")).map((item) => item.id),
    ["124", "123"],
  );
});

test("unprocessed keys are retried and persistent failures do not look like an empty diary", async () => {
  let calls = 0;
  const store = createWorkoutStore(
    {
      query: async () => ({ Items: [key] }),
      batchGet: async () => {
        calls += 1;
        return calls === 1
          ? { UnprocessedKeys: { table: { Keys: [key] } } }
          : { Responses: { table: [marshall(workout)] } };
      },
    },
    "table",
  );
  assert.equal((await store.recent("strava-456")).length, 1);
  assert.equal(calls, 2);
  const failing = createWorkoutStore(
    {
      query: async () => ({ Items: [key] }),
      batchGet: async () => ({ UnprocessedKeys: { table: { Keys: [key] } } }),
    },
    "table",
  );
  await assert.rejects(failing.recent("strava-456"), /incomplete/);
});

test("an empty index never scans the table or reads credentials", async () => {
  const store = createWorkoutStore(
    {
      query: async () => ({ Items: [] }),
      batchGet: async () => assert.fail("No batch read needed"),
    },
    "table",
  );
  assert.deepEqual(await store.recent("strava-456"), []);
});
