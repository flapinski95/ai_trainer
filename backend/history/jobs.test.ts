import assert from "node:assert/strict";
import { test } from "node:test";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  ConditionalCheckFailedException,
  type PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { createJobStore, jobSchema } from "./jobs";

const now = Date.parse("2026-10-25T16:00:00Z");
const previous = () =>
  jobSchema.parse({
    userId: "strava-456",
    jobId: "old",
    state: "SUCCEEDED",
    after: 0,
    before: now / 1000 - 86400,
    lastSuccess: now / 1000 - 86400,
    requestedAt: now / 1000 - 86400,
    dueAt: 0,
    page: 1,
    offset: 0,
    readAll: false,
    successReadAll: false,
  });

test("first login enqueues a full lightweight import and subsequent login uses a watermark", async () => {
  for (const old of [null, previous()]) {
    let written: PutItemCommand | undefined;
    const store = createJobStore(
      {
        get: async () => ({ Item: old ? marshall(old) : undefined }),
        query: async () => ({}),
        put: async (command) => {
          written = command;
        },
        update: async () => {},
      },
      "table",
      () => now,
    );
    assert.equal(await store.request("strava-456", false), true);
    const item = unmarshall(written!.input.Item!);
    assert.equal(item.after, old ? old.lastSuccess! - 7 * 86400 : 0);
    assert.equal(item.GSI1PK, "STRAVA#SYNC#PENDING");
    assert.equal(item.entityType, "STRAVA_SYNC_JOB");
  }
});

test("one active job is reused and concurrent queue creation is conditional", async () => {
  const active = { ...previous(), state: "RUNNING" };
  const store = createJobStore(
    {
      get: async () => ({ Item: marshall(active) }),
      query: async () => ({}),
      put: async () => assert.fail("Must not duplicate jobs"),
      update: async () => {},
    },
    "table",
    () => now,
  );
  assert.equal(await store.request("strava-456", false, true), false);
  const race = createJobStore(
    {
      get: async () => ({}),
      query: async () => ({}),
      put: async () => {
        throw new ConditionalCheckFailedException({
          message: "Already queued",
          $metadata: {},
        });
      },
      update: async () => {},
    },
    "table",
    () => now,
  );
  assert.equal(await race.request("strava-456", false), false);
});

test("expired leases can resume but an unexpired lease cannot be claimed", async () => {
  let updates = 0;
  const store = createJobStore(
    {
      get: async () => ({
        Item: marshall({
          ...previous(),
          state: "RUNNING",
          leaseUntil: now / 1000 + 10,
        }),
      }),
      query: async () => ({}),
      put: async () => {},
      update: async () => {
        updates += 1;
      },
    },
    "table",
    () => now,
  );
  assert.equal(await store.claim("strava-456"), null);
  assert.equal(updates, 0);
});

test("completed jobs leave the scheduling index and checkpoints are fenced by job and lease", async () => {
  const store = createJobStore(
    {
      get: async () => ({}),
      query: async () => ({}),
      put: async (command) => {
        assert.equal(
          command.input.ConditionExpression,
          "jobId = :job AND leaseId = :lease",
        );
        assert.equal(command.input.Item?.GSI1PK, undefined);
        assert.equal(command.input.Item?.leaseId, undefined);
      },
      update: async () => {},
    },
    "table",
    () => now,
  );
  await store.checkpoint({ ...previous(), leaseId: "lease" });
});

test("a mismatched job identity fails closed rather than crossing user partitions", async () => {
  const store = createJobStore(
    {
      get: async () => ({
        Item: marshall({ ...previous(), userId: "strava-999" }),
      }),
      query: async () => ({}),
      put: async () => assert.fail("Must not write another user"),
      update: async () => {},
    },
    "table",
    () => now,
  );
  await assert.rejects(store.claim("strava-456"), /ownership mismatch/);
});
