import assert from "node:assert/strict";
import { test } from "node:test";
import type { DynamoDBRecord } from "aws-lambda";
import { createStreamHandler } from "./handler";

function record(sequence: string): DynamoDBRecord {
  return {
    eventName: "INSERT",
    dynamodb: {
      SequenceNumber: sequence,
      NewImage: {
        entityType: { S: "STRAVA_WEBHOOK_EVENT" },
        status: { S: "RECEIVED" },
        payload: {
          S: JSON.stringify({
            object_type: "activity",
            object_id: 123,
            owner_id: 456,
            aspect_type: "update",
            event_time: 1792886400,
            subscription_id: 789,
            updates: {},
          }),
        },
      },
    },
  };
}

test("stream handler only processes new inbox events for the configured subscription", async () => {
  let calls = 0;
  const handler = createStreamHandler(async () => {
    calls += 1;
  }, "789");
  assert.deepEqual(
    await handler({
      Records: [
        { ...record("1"), eventName: "MODIFY" },
        {
          eventName: "INSERT",
          dynamodb: { NewImage: { entityType: { S: "WORKOUT" } } },
        },
        record("2"),
      ],
    }),
    { batchItemFailures: [] },
  );
  assert.equal(calls, 1);
});

test("stream processing stops at the first failure and returns its sequence number", async (context) => {
  context.mock.method(console, "error", () => {});
  let calls = 0;
  const handler = createStreamHandler(async () => {
    if (++calls === 2) throw new Error("Retry");
  }, "789");
  assert.deepEqual(
    await handler({ Records: [record("1"), record("2"), record("3")] }),
    { batchItemFailures: [{ itemIdentifier: "2" }] },
  );
  assert.equal(calls, 2);
});

test("unexpected subscriptions are not processed or silently acknowledged", async (context) => {
  context.mock.method(console, "error", () => {});
  assert.deepEqual(
    await createStreamHandler(
      async () => assert.fail("Unexpected subscription"),
      "999",
    )({ Records: [record("1")] }),
    { batchItemFailures: [{ itemIdentifier: "1" }] },
  );
});

test("new history jobs dispatch separately while progress updates cannot create loops", async () => {
  const users: string[] = [];
  const handler = createStreamHandler(
    async () => assert.fail("History is not a webhook"),
    "789",
    async (userId) => {
      users.push(userId);
    },
  );
  const job: DynamoDBRecord = {
    eventName: "INSERT",
    dynamodb: {
      SequenceNumber: "1",
      NewImage: {
        entityType: { S: "STRAVA_SYNC_JOB" },
        state: { S: "QUEUED" },
        userId: { S: "strava-456" },
      },
    },
  };
  assert.deepEqual(
    await handler({ Records: [job, { ...job, eventName: "MODIFY" }] }),
    { batchItemFailures: [] },
  );
  assert.deepEqual(users, ["strava-456"]);
});
