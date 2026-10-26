import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TransactionCanceledException,
  type UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { createRateGate, RateLimitError } from "./rate-limit";

const clock = () => Date.parse("2026-10-25T12:01:00Z");
test("history atomically reserves read and overall budgets while leaving a webhook reserve", async () => {
  const gate = createRateGate(
    {
      get: async () => ({}),
      update: async () => {},
      transact: async (command) => {
        assert.equal(command.input.TransactItems?.length, 4);
        assert.deepEqual(
          command.input.TransactItems?.map(
            (item) => item.Update?.ExpressionAttributeValues?.[":limit"]?.N,
          ),
          ["360", "3600", "180", "1800"],
        );
      },
    },
    "table",
    "HISTORY",
    clock,
  );
  await gate.before("read");
});
test("daily quota failures resume at UTC midnight instead of quick retry", async () => {
  const gate = createRateGate(
    {
      get: async () => ({}),
      update: async () => {},
      transact: async () => {
        throw new TransactionCanceledException({
          message: "Full",
          $metadata: {},
          CancellationReasons: [
            { Code: "None" },
            { Code: "None" },
            { Code: "None" },
            { Code: "ConditionalCheckFailed" },
          ],
        });
      },
    },
    "table",
    "HISTORY",
    clock,
  );
  await assert.rejects(
    gate.before("read"),
    (error) =>
      error instanceof RateLimitError &&
      error.retryAt === Date.parse("2026-10-26T00:00:02Z") / 1000,
  );
});
test("real quota headers update shared usage and 429 creates a persisted cooldown", async () => {
  const writes: UpdateItemCommand[] = [];
  const gate = createRateGate(
    {
      get: async () => ({}),
      transact: async () => {},
      update: async (command) => {
        writes.push(command);
      },
    },
    "table",
    "WEBHOOK",
    clock,
  );
  await assert.rejects(
    gate.after(
      new Headers({
        "x-readratelimit-limit": "200,2000",
        "x-readratelimit-usage": "200,2000",
      }),
      429,
      "read",
    ),
    RateLimitError,
  );
  assert.equal(
    writes.at(-1)?.input.ExpressionAttributeValues?.[":until"]?.N,
    String(Date.parse("2026-10-26T00:00:02Z") / 1000),
  );
});
test("persistent cooldown stops requests before reserving or calling Strava", async () => {
  const gate = createRateGate(
    {
      get: async () => ({
        Item: { blockedUntil: { N: String(clock() / 1000 + 600) } },
      }),
      update: async () => {},
      transact: async () => assert.fail("Cooldown must stop reservation"),
    },
    "table",
    "HISTORY",
    clock,
  );
  await assert.rejects(gate.before("read"), RateLimitError);
});
