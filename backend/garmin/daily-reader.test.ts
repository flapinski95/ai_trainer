import assert from "node:assert/strict";
import { test } from "node:test";
import { createDailyMetricReader } from "./daily-reader";
import { createDailyMetricEndpoint } from "./daily-endpoint";

test("daily metric DTO decrypts only the user's own date and excludes raw source records", async () => {
  const read = createDailyMetricReader({ query: async () => ({ Items: [{ PK: { S: "USER#user" }, SK: { S: "METRIC#2026-10-25" } }] }),
    get: async (command) => { assert.equal(command.input.Key?.PK?.S, "USER#user"); return { Item: { entityType: { S: "GARMIN_METRIC" }, provider: { S: "garmin" }, revision: { S: "rev" }, partCount: { N: "1" } } }; },
    artifacts: { read: async (PK) => { assert.equal(PK, "USER#user"); return "encrypted"; } },
    encryption: { decrypt: async (_value, context) => { assert.equal(context.userId, "user"); return { date: "2026-10-25", provider: "garmin", values: { restingHeartRate: 48 }, sources: { dailies: { receivedAt: 100, values: { restingHeartRate: 48 }, summaryId: "private-source-reference" } } }; } },
  }, "table");
  const result = await read("user");
  assert.equal(result?.values.restingHeartRate, 48);
  assert.equal(JSON.stringify(result).includes("private-source-reference"), false);
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