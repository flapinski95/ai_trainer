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
  assert.equal(items?.length, 6);
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

test("manual Garmin imports reuse history aggregates without requiring OAuth tokens", async () => {
  const { save, writes } = setup();
  await save(connection, "fit-one", 0, activity, "IMPORT", true, "garmin");
  const items = writes[0]?.input.TransactItems ?? [];
  assert.equal(items.some((item) => item.ConditionCheck?.Key?.SK?.S?.startsWith("CONNECTION#")), false);
  assert.equal(items[0]?.ConditionCheck?.Key?.SK?.S, "WORKOUT_TIMESTAMP#2026-10-25T15:00:00.000Z");
  const workout = items.find((item) => item.Put?.Item?.entityType?.S === "WORKOUT")?.Put?.Item;
  assert.equal(workout?.SK?.S, "ACTIVITY#GARMIN#fit-one");
  assert.equal(workout?.source?.S, "HISTORY");
  const updates = items.flatMap((item) => item.Update ? [item.Update] : []);
  assert.equal(updates.length, 3);
  assert.ok(updates.every((update) => update.Key?.SK?.S?.startsWith("SUMMARY#GARMIN#")));
  await assert.rejects(save(connection, "fit-one", 0, activity, "IMPORT", true, "strava"));
});

test("an unchanged Garmin PUSH binds its FIT identity before a later provider deletion", async () => {
  const writes: TransactWriteItemsCommand[] = [];
  let linked = false;
  const previous = { ...activity, status: "ACTIVE", source: "HISTORY", summaryVersion: 1,
    metricsHash: fingerprint(activity), revision: "old", eventTime: 0 };
  const save = createWorkoutWriter({
    get: async (command) => {
      const key = command.input.Key?.SK?.S ?? "";
      if (key.startsWith("WORKOUT_IDENTITY#")) return { Item: marshall({ entityType: "WORKOUT_IDENTITY", activityId: "fit-one" }) };
      if (key.startsWith("WORKOUT_ALIAS#")) return { Item: linked ? marshall({ entityType: "WORKOUT_ALIAS", activityId: "fit-one" }) : undefined };
      assert.equal(key, "ACTIVITY#GARMIN#fit-one");
      return { Item: marshall(previous) };
    },
    transact: async (command) => { writes.push(command); linked = true; },
  }, "table");
  await save(connection, "provider-id", 100, activity, "WEBHOOK", true, "garmin");
  const items = writes[0]?.input.TransactItems ?? [];
  assert.ok(items.some((item) => item.Put?.Item?.SK?.S === "ACTIVITY#GARMIN#fit-one"));
  assert.ok(items.filter((item) => item.Update?.Key?.SK?.S?.startsWith("SUMMARY#"))
    .every((item) => item.Update?.ExpressionAttributeValues?.[":count"]?.N === "0"));
  await save(connection, "provider-id", 101, null, "WEBHOOK", true, "garmin");
  assert.ok(writes[1]?.input.TransactItems?.some((item) => item.Put?.Item?.SK?.S === "ACTIVITY#GARMIN#fit-one" && item.Put.Item.status?.S === "DELETED"));
});

test("manual import skips protected Strava and Garmin PUSH timestamps before writing", async () => {
  for (const field of ["hasStrava", "hasGarminPush"]) {
    const save = createWorkoutWriter({
      get: async (command) => {
        assert.equal(command.input.Key?.SK?.S, "WORKOUT_TIMESTAMP#2026-10-25T15:00:00.000Z");
        return { Item: marshall({ [field]: true }) };
      },
      transact: async () => assert.fail("Protected timestamp must not be imported"),
    }, "table");
    assert.equal(await save(connection, "fit-one", 0, activity, "IMPORT", true, "garmin"), false);
  }
});

test("new webhook workouts enqueue push in the workout transaction", async () => {
  for (const provider of ["strava", "garmin"] as const) {
    const { save, writes } = setup();
    await save(connection, 123, 100, activity, "WEBHOOK", true, provider, true);
    const items = writes[0]?.input.TransactItems ?? [];
    const job = items.find((item) => item.Put?.Item?.entityType?.S === "PUSH_WORKOUT_JOB")?.Put;
    assert.equal(job?.Item?.SK?.S, `PUSH_JOB#${provider.toUpperCase()}#123`);
    assert.equal(job?.Item?.userId?.S, connection.userId);
    assert.equal(job?.Item?.state?.S, "QUEUED");
    assert.equal(job?.ConditionExpression, "attribute_not_exists(PK)");
    assert.ok(items.some((item) => item.Put?.Item?.entityType?.S === "WORKOUT"));
  }
});

test("history, imports, edits and deletes never enqueue push", async () => {
  for (const source of ["HISTORY", "IMPORT"] as const) {
    const { save, writes } = setup();
    await save(connection, 123, 100, activity, source, true, "garmin", true);
    assert.ok(writes[0]?.input.TransactItems?.every((item) => item.Put?.Item?.entityType?.S !== "PUSH_WORKOUT_JOB"));
  }
  const previous = {
    ...activity, status: "ACTIVE", source: "WEBHOOK", summaryVersion: 1,
    metricsHash: fingerprint(activity), eventTime: 100, revision: "old",
  };
  for (const incoming of [{ ...activity, name: "Renamed" }, null]) {
    const { save, writes } = setup(previous);
    await save(connection, 123, 101, incoming, "WEBHOOK", true, "strava", true);
    assert.ok(writes[0]?.input.TransactItems?.every((item) => item.Put?.Item?.entityType?.S !== "PUSH_WORKOUT_JOB"));
  }
  const { save, writes } = setup();
  await save(connection, 123, 100, activity, "WEBHOOK", true, "strava", false);
  assert.ok(writes[0]?.input.TransactItems?.every((item) => item.Put?.Item?.entityType?.S !== "PUSH_WORKOUT_JOB"));
});
