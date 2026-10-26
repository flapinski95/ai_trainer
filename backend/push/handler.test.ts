import assert from "node:assert/strict";
import { test } from "node:test";
import type { DynamoDBStreamEvent } from "aws-lambda";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { createPushHandler } from "./handler";

const job = {
  PK: "USER#athlete-1", SK: "PUSH_JOB#STRAVA#123", entityType: "PUSH_WORKOUT_JOB",
  state: "QUEUED", userId: "athlete-1", provider: "strava", activityId: "123",
};
const batch: DynamoDBStreamEvent = { Records: [{
  eventName: "INSERT", dynamodb: { SequenceNumber: "42", NewImage: {
    PK: { S: job.PK }, SK: { S: job.SK }, entityType: { S: job.entityType }, state: { S: job.state },
    userId: { S: job.userId }, provider: { S: job.provider }, activityId: { S: job.activityId },
  } },
}] };

function setup(status = 200, state = "QUEUED") {
  const updates: UpdateItemCommand[] = [];
  const requests: RequestInit[] = [];
  const process = createPushHandler({
    get: async () => ({ Item: marshall({ ...job, state }) }),
    update: async (command) => { updates.push(command); },
    credentials: async () => "test-secret-that-is-at-least-32-characters",
    fetch: async (url, options) => {
      assert.equal(url, "https://trainer.example.com/api/push/workout");
      requests.push(options);
      return Response.json({ sent: 1, failed: 0 }, { status });
    },
  }, "table", "https://trainer.example.com/api/push/workout");
  return { process, updates, requests };
}

test("push worker calls the endpoint before completing its durable job", async () => {
  const worker = setup();
  assert.deepEqual(await worker.process(batch), { batchItemFailures: [] });
  assert.deepEqual(JSON.parse(String(worker.requests[0]?.body)), { userId: job.userId, provider: "strava", activityId: "123" });
  assert.equal(worker.requests[0]?.redirect, "error");
  assert.ok(worker.requests[0]?.signal instanceof AbortSignal);
  assert.equal(worker.updates[0]?.input.ExpressionAttributeValues?.[":completed"]?.S, "COMPLETED");
  assert.equal(worker.updates[0]?.input.ExpressionAttributeValues?.[":sent"]?.N, "1");
});

test("failed requests remain retryable and are not marked completed", async () => {
  for (const status of [401, 429, 500, 503]) {
    const worker = setup(status);
    assert.deepEqual(await worker.process(batch), { batchItemFailures: [{ itemIdentifier: "42" }] });
    assert.equal(worker.updates.length, 0);
  }
});

test("completed jobs and unrelated records never send notifications", async () => {
  const worker = setup(200, "COMPLETED");
  assert.deepEqual(await worker.process(batch), { batchItemFailures: [] });
  assert.equal(worker.requests.length, 0);
  const ignored = setup();
  assert.deepEqual(await ignored.process({ Records: [{ eventName: "MODIFY", dynamodb: batch.Records[0]?.dynamodb }] }), { batchItemFailures: [] });
  assert.equal(ignored.requests.length, 0);
});

test("invalid job identities fail without calling the endpoint", async () => {
  const worker = setup();
  const invalid: DynamoDBStreamEvent = { Records: [{
    ...batch.Records[0], dynamodb: { ...batch.Records[0]?.dynamodb, NewImage: {
      ...batch.Records[0]?.dynamodb?.NewImage, PK: { S: "USER#other-athlete" },
    } },
  }] };
  assert.deepEqual(await worker.process(invalid), { batchItemFailures: [{ itemIdentifier: "42" }] });
  assert.equal(worker.requests.length, 0);
});

test("partial delivery, malformed replies and network failures leave jobs queued", async () => {
  for (const result of [{ sent: 1, failed: 1 }, { invalid: true }, null]) {
    let completed = false;
    const process = createPushHandler({
      get: async () => ({ Item: marshall(job) }),
      update: async () => { completed = true; },
      credentials: async () => "test-secret-that-is-at-least-32-characters",
      fetch: async () => {
        if (result === null) throw new TypeError("Network unavailable");
        return Response.json(result);
      },
    }, "table", "https://trainer.example.com/api/push/workout");
    assert.deepEqual(await process(batch), { batchItemFailures: [{ itemIdentifier: "42" }] });
    assert.equal(completed, false);
  }
});

test("push endpoint must use HTTPS without credentials or query tokens", () => {
  const dependencies = {
    get: async () => ({}), update: async () => undefined, credentials: async () => "secret",
  };
  for (const endpoint of ["http://localhost:3000/api/push/workout", "https://user:password@example.com/api/push/workout", "https://example.com/api/push/workout?token=secret"]) {
    assert.throws(() => createPushHandler(dependencies, "table", endpoint));
  }
});