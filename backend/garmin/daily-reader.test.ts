import assert from "node:assert/strict";
import { test } from "node:test";
import { createDailyMetricReader } from "./daily-reader";
import { createDailyMetricEndpoint } from "./daily-endpoint";

test("daily metric DTO decrypts only the user's own date and excludes raw source records", async () => {
  const receivedAt = Date.now();
  const metricDate = new Date(receivedAt).toISOString().slice(0, 10);
  const read = createDailyMetricReader({ query: async (command) => {
    assert.equal(command.input.IndexName, undefined);
    assert.equal(command.input.ConsistentRead, true);
    assert.equal(command.input.FilterExpression, "entityType = :type AND receivedAt BETWEEN :cutoff AND :now");
    assert.deepEqual(Object.keys(command.input.ExpressionAttributeValues ?? {}).sort(), [":cutoff", ":from", ":now", ":to", ":type", ":user"]);
    assert.equal(command.input.ScanIndexForward, false);
    return { Items: [{ PK: { S: "USER#user" }, SK: { S: `METRIC#${metricDate}` }, receivedAt: { N: String(receivedAt) } }] };
  },
    get: async (command) => { assert.equal(command.input.Key?.PK?.S, "USER#user"); return { Item: { entityType: { S: "GARMIN_METRIC" }, provider: { S: "garmin" }, revision: { S: "rev" }, partCount: { N: "1" } } }; },
    artifacts: { read: async (PK) => { assert.equal(PK, "USER#user"); return "encrypted"; } },
    encryption: { decrypt: async (_value, context) => { assert.equal(context.userId, "user"); return { date: metricDate, provider: "garmin", values: { restingHeartRate: 48 }, sources: { dailies: { receivedAt: 100, values: { restingHeartRate: 48 }, summaryId: "private-source-reference" } } }; } },
  }, "table");
  const result = await read("user");
  assert.equal(result?.values.restingHeartRate, 48);
  assert.equal(JSON.stringify(result).includes("private-source-reference"), false);
});

test("latest metric lookup continues past a page containing only encrypted chunks", async () => {
  let calls = 0;
  const receivedAt = Date.now();
  const metricDate = new Date(receivedAt).toISOString().slice(0, 10);
  const cursor = { PK: { S: "USER#user" }, SK: { S: `METRIC#${metricDate}#PART#rev#000` } };
  const read = createDailyMetricReader({
    query: async (command) => {
      calls += 1;
      if (calls === 1) return { Items: [], LastEvaluatedKey: cursor };
      assert.deepEqual(command.input.ExclusiveStartKey, cursor);
      return { Items: [{ PK: { S: "USER#user" }, SK: { S: `METRIC#${metricDate}` }, receivedAt: { N: String(receivedAt) } }] };
    },
    get: async () => ({ Item: { entityType: { S: "GARMIN_METRIC" }, provider: { S: "garmin" }, revision: { S: "rev" }, partCount: { N: "1" } } }),
    artifacts: { read: async () => "encrypted" },
    encryption: { decrypt: async () => ({ date: metricDate, provider: "garmin", values: { bodyBattery: 76 } }) },
  }, "table");
  assert.equal((await read("user"))?.values.bodyBattery, 76);
  assert.equal(calls, 2);
});

test("latest metric lookup chooses the newest receipt in the 36-hour window, not the newest calendar date", async () => {
  const now = Date.now();
  const currentDate = new Date(now).toISOString().slice(0, 10);
  const previousDate = new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const olderDate = new Date(now - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let selectedDate = "";
  const read = createDailyMetricReader({
    query: async (command) => {
      assert.equal(command.input.FilterExpression, "entityType = :type AND receivedAt BETWEEN :cutoff AND :now");
      return {
        Items: [
          { PK: { S: "USER#user" }, SK: { S: `METRIC#${currentDate}` }, receivedAt: { N: String(now - 60000) } },
          { PK: { S: "USER#user" }, SK: { S: `METRIC#${previousDate}` }, receivedAt: { N: String(now - 1000) } },
          { PK: { S: "USER#user" }, SK: { S: `METRIC#${olderDate}` }, receivedAt: { N: String(now - 36 * 60 * 60 * 1000 - 1) } },
        ],
      };
    },
    get: async (command) => {
      selectedDate = command.input.Key?.SK?.S ?? "";
      return { Item: { entityType: { S: "GARMIN_METRIC" }, provider: { S: "garmin" }, revision: { S: "rev" }, partCount: { N: "1" } } };
    },
    artifacts: { read: async () => "encrypted" },
    encryption: { decrypt: async () => ({ date: previousDate, provider: "garmin", values: { bodyBattery: 82 } }) },
  }, "table");

  const result = await read("user");
  assert.equal(selectedDate, `METRIC#${previousDate}`);
  assert.equal(result?.values.bodyBattery, 82);
});

test("daily API requires login and Health consent and never accepts a caller-selected user ID", async () => {
  const request = new Request("http://localhost/api/health/daily");
  const base = { session: async () => ({ userId: "user" }), connection: async () => ({ active: true, scopes: ["HEALTH_EXPORT"] }), read: async () => ({ date: "2026-10-25", provider: "garmin" as const, values: { restingHeartRate: 48 } }) };
  assert.equal((await createDailyMetricEndpoint({ ...base, session: async () => null })(request)).status, 401);
  assert.equal((await createDailyMetricEndpoint({ ...base, connection: async () => ({ active: true, scopes: ["MCT_EXPORT"] }) })(request)).status, 403);
  assert.equal((await createDailyMetricEndpoint(base)(new Request(`${request.url}?userId=other`))).status, 400);
  assert.equal((await createDailyMetricEndpoint(base)(new Request(`${request.url}?date=2026-02-30`))).status, 400);
  const response = await createDailyMetricEndpoint(base)(request);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("daily API distinguishes missing data and retryable read failures without leaking details", async (context) => {
  context.mock.method(console, "error", () => {});
  const base = { session: async () => ({ userId: "user" }), connection: async () => ({ active: true, scopes: ["HEALTH_EXPORT"] }) };
  const request = new Request("http://localhost/api/health/daily");
  assert.equal((await createDailyMetricEndpoint({ ...base, read: async () => null })(request)).status, 404);
  const response = await createDailyMetricEndpoint({ ...base, read: async () => { throw new Error("private-payload"); } })(request);
  assert.equal(response.status, 503); assert.equal((await response.text()).includes("private-payload"), false);
});

test("import-only health access excludes PUSH values after Health permission is absent", async () => {
  const read = createDailyMetricReader({
    query: async (command) => {
      assert.equal(command.input.FilterExpression, "entityType = :type AND imported = :imported");
      assert.deepEqual(Object.keys(command.input.ExpressionAttributeValues ?? {}).sort(), [":imported", ":metric", ":type", ":user"]);
      assert.deepEqual(command.input.ExpressionAttributeValues?.[":metric"], { S: "METRIC#" });
      return { Items: [{ PK: { S: "USER#user" }, SK: { S: "METRIC#2026-10-25" } }] };
    },
    get: async () => ({ Item: { imported: { BOOL: true }, entityType: { S: "GARMIN_METRIC" }, provider: { S: "garmin" }, revision: { S: "rev" }, partCount: { N: "1" } } }),
    artifacts: { read: async () => "encrypted" },
    encryption: { decrypt: async () => ({ date: "2026-10-25", provider: "garmin", values: { restingHeartRate: 48, sleepScore: 90 },
      sources: { import: { receivedAt: 0, values: { restingHeartRate: 60 } }, dailies: { receivedAt: 100, values: { restingHeartRate: 48, sleepScore: 90 } } } }) },
  }, "table");
  const response = await createDailyMetricEndpoint({
    session: async () => ({ userId: "user" }), connection: async () => null,
    read: async () => assert.fail("No PUSH read without permission"),
    readImported: (userId, date) => read(userId, date, true),
  })(new Request("http://localhost/api/health/daily"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { values: unknown }).values, { restingHeartRate: 60 });
});