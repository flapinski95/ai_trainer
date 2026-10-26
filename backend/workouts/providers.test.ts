import assert from "node:assert/strict";
import { test } from "node:test";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createWorkoutStore } from "./store";

const metrics = {
  PK: "USER#independent-user",
  entityType: "WORKOUT",
  status: "ACTIVE",
  name: "Run",
  sport_type: "Run",
  start_date: "2026-10-25T15:00:00Z",
  distance: 10000,
  moving_time: 3600,
  elapsed_time: 3700,
};
test("Garmin-only diary reads Garmin records and never returns Strava duplicates", async () => {
  const garmin = {
    ...metrics,
    provider: "garmin",
    activityId: "summary-1",
    SK: "ACTIVITY#GARMIN#summary-1",
  };
  const strava = {
    ...metrics,
    provider: "strava",
    activityId: "123",
    SK: "ACTIVITY#STRAVA#123",
  };
  const store = createWorkoutStore(
    {
      query: async (command) => {
        assert.equal(
          command.input.ExpressionAttributeValues?.[":providerKey"]?.S,
          "ACTIVITY#GARMIN#",
        );
        return { Items: [marshall(garmin), marshall(strava)] };
      },
      batchGet: async () => ({
        Responses: { table: [marshall(garmin), marshall(strava)] },
      }),
    },
    "table",
  );
  const result = await store.recent("independent-user", "garmin");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.provider, "garmin");
});
test("provider filtering follows index pages instead of hiding older selected-source workouts", async () => {
  let calls = 0;
  const garmin = {
    ...metrics,
    provider: "garmin",
    activityId: "1",
    SK: "ACTIVITY#GARMIN#1",
  };
  const store = createWorkoutStore(
    {
      query: async () =>
        ++calls === 1
          ? {
              Items: [],
              LastEvaluatedKey: marshall({ PK: "cursor", SK: "cursor" }),
            }
          : { Items: [marshall(garmin)] },
      batchGet: async () => ({ Responses: { table: [marshall(garmin)] } }),
    },
    "table",
  );
  assert.equal((await store.recent("independent-user", "garmin")).length, 1);
  assert.equal(calls, 2);
});
