import assert from "node:assert/strict";
import { test } from "node:test";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { createWorkoutWriter } from "./persist";
import { normalizeSummary, fingerprint } from "../history/model";
import type { Connection } from "../strava-worker/processor";

const connection: Connection = {
  userId: "strava-456",
  athleteId: "456",
  active: true,
  scopes: ["activity:read"],
  encryptedTokens: "cipher",
  expiresAt: 4102444800,
  authorizedAt: "2026-10-01T00:00:00Z",
};
const activity = normalizeSummary(
  {
    id: 123,
    athlete: { id: 456 },
    name: "Ride",
    sport_type: "Ride",
    start_date: "2026-10-25T15:00:00Z",
    distance: 20000,
    moving_time: 3600,
    elapsed_time: 3700,
  },
  "456",
);

function setup(previous?: Record<string, unknown>) {
  const writes: TransactWriteItemsCommand[] = [];
  return {
    writes,
    save: createWorkoutWriter(
      {
        get: async () => ({ Item: previous ? marshall(previous) : undefined }),
        transact: async (command) => {
          writes.push(command);
        },
      },
      "table",
    ),
  };
}

test("history writes metrics plus three summaries atomically with consent", async () => {
  const { save, writes } = setup();
  await save(connection, 123, 0, activity, "HISTORY");
  const items = writes[0]?.input.TransactItems;
  assert.equal(items?.length, 5);
  assert.equal(items?.[1]?.Put?.Item?.source?.S, "HISTORY");
  assert.equal(
    items?.[1]?.Put?.ConditionExpression,
    "attribute_not_exists(PK)",
  );
  assert.equal(
    items?.[2]?.Update?.ExpressionAttributeValues?.[":count"]?.N,
    "1",
  );
});

test("unchanged imports perform no writes and do not double-count", async () => {
  const { save, writes } = setup({
    ...activity,
    source: "HISTORY",
    status: "ACTIVE",
    summaryVersion: 1,
    metricsHash: fingerprint(activity),
    eventTime: 0,
    revision: "old",
  });
  assert.equal(await save(connection, 123, 0, activity, "HISTORY"), false);
  assert.equal(writes.length, 0);
});

test("history cannot overwrite webhook workouts or deletion tombstones", async () => {
  for (const status of ["ACTIVE", "DELETED"]) {
    const { save, writes } = setup({
      ...activity,
      source: "WEBHOOK",
      status,
      summaryVersion: 1,
      metricsHash: fingerprint(activity),
      eventTime: 100,
    });
    assert.equal(await save(connection, 123, 0, activity, "HISTORY"), false);
    assert.equal(writes.length, 0);
  }
});

test("changed and deleted activities apply only summary deltas", async () => {
  const previous = {
    ...activity,
    status: "ACTIVE",
    source: "HISTORY",
    summaryVersion: 1,
    metricsHash: fingerprint(activity),
    eventTime: 0,
    revision: "revision-1",
  };
  const changed = setup(previous);
  await changed.save(
    connection,
    123,
    100,
    { ...activity, distance: 21000 },
    "WEBHOOK",
    true,
  );
  assert.equal(
    changed.writes[0]?.input.TransactItems?.[2]?.Update
      ?.ExpressionAttributeValues?.[":count"]?.N,
    "0",
  );
  assert.equal(
    changed.writes[0]?.input.TransactItems?.[2]?.Update
      ?.ExpressionAttributeValues?.[":distance"]?.N,
    "1000",
  );
  const removed = setup(previous);
  await removed.save(connection, 123, 100, null, "WEBHOOK");
  assert.equal(
    removed.writes[0]?.input.TransactItems?.[2]?.Update
      ?.ExpressionAttributeValues?.[":count"]?.N,
    "-1",
  );
  assert.equal(
    removed.writes[0]?.input.TransactItems?.[1]?.Put?.Item?.GSI1PK,
    undefined,
  );
});

test("optimistic revision checks keep retries from double-applying aggregates", async () => {
  const { save, writes } = setup({
    ...activity,
    status: "ACTIVE",
    summaryVersion: 1,
    eventTime: 1,
    revision: "old",
  });
  await save(connection, 123, 2, { ...activity, name: "Renamed" }, "WEBHOOK");
  assert.equal(
    writes[0]?.input.TransactItems?.[1]?.Put?.ConditionExpression,
    "revision = :previous",
  );
});
