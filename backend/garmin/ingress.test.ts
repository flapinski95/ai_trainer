import assert from "node:assert/strict";
import { test } from "node:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createGarminIngress, handler } from "./ingress";

const token = "test-only-token-at-least-43-random-characters-long";
const request = (): APIGatewayProxyEventV2 => ({
  version: "2.0",
  routeKey: "POST /webhooks/garmin/{webhookToken}/{category}",
  rawPath: "/webhooks/garmin/test/health",
  rawQueryString: "",
  isBase64Encoded: false,
  headers: { "content-type": "application/json" },
  pathParameters: { webhookToken: token, category: "health" },
  body: JSON.stringify({
    hrv: [
      {
        userId: "user-1",
        summaryId: "hrv-1",
        everyField: { sample: [1, 2, 3] },
      },
    ],
  }),
  requestContext: {
    accountId: "test",
    apiId: "test",
    domainName: "test",
    domainPrefix: "test",
    requestId: "test",
    routeKey: "POST /webhooks/garmin/{webhookToken}/{category}",
    stage: "$default",
    time: "test",
    timeEpoch: 0,
    http: {
      method: "POST",
      path: "/webhooks/garmin/test/health",
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "test",
    },
  },
});
test("Garmin PUSH requires its secret and waits for durable encrypted storage before acknowledging", async () => {
  let stored = false;
  const handler = createGarminIngress(async (category, body) => {
    assert.equal(category, "health");
    assert.equal(JSON.stringify(body).includes("everyField"), true);
    stored = true;
  }, token);
  assert.equal(
    (
      await handler({
        ...request(),
        pathParameters: { ...request().pathParameters, webhookToken: "wrong" },
      })
    ).statusCode,
    403,
  );
  assert.equal(stored, false);
  assert.equal((await handler(request())).statusCode, 200);
  assert.equal(stored, true);
});

test("Garmin empty ping is acknowledged without attempting persistence", async () => {
  const handler = createGarminIngress(async () => {
    assert.fail("Empty pings must not be persisted");
  }, token);
  const emptyRequest = request();
  emptyRequest.body = "";
  emptyRequest.headers = {};
  assert.equal((await handler(emptyRequest)).statusCode, 200);

  const emptySummariesRequest = request();
  emptySummariesRequest.body = JSON.stringify({ dailies: [], sleeps: [] });
  assert.equal((await handler(emptySummariesRequest)).statusCode, 200);
});

test("Garmin storage failure is retryable and no false success is returned", async (context) => {
  context.mock.method(console, "error", () => {});
  assert.equal(
    (
      await createGarminIngress(async () => {
        throw new Error("Storage");
      }, token)(request())
    ).statusCode,
    503,
  );
});

for (const [summaryType, category] of [
  ["dailies", "health"],
  ["sleeps", "health"],
  ["activities", "activity"],
] as const) {
  test(`Garmin ${summaryType} callback authenticates pings and persists data as ${category}`, async () => {
    const stored: string[] = [];
    const ingress = createGarminIngress(async (receivedCategory, body) => {
      assert.equal(receivedCategory, category);
      assert.deepEqual(body, { [summaryType]: [{ userId: "user-1" }] });
      stored.push(receivedCategory);
    }, token);
    const event: APIGatewayProxyEventV2 = {
      ...request(),
      routeKey: `POST /api/webhooks/garmin/${summaryType}/{token}`,
      rawPath: `/api/webhooks/garmin/${summaryType}/${token}`,
      pathParameters: { token },
      body: "",
      headers: {},
    };
    assert.equal((await ingress({ ...event, pathParameters: { token: "wrong" } })).statusCode, 403);
    assert.equal((await ingress(event)).statusCode, 200);
    assert.equal((await ingress({ ...event, body: undefined })).statusCode, 200);
    assert.equal((await ingress({ ...event, body: "e30=", isBase64Encoded: true, headers: request().headers })).statusCode, 200);
    assert.equal((await ingress({ ...event, body: JSON.stringify({ [summaryType]: [] }), headers: request().headers })).statusCode, 200);
    assert.equal(stored.length, 0);
    assert.equal((await ingress({ ...event, body: JSON.stringify({ [summaryType]: [{ userId: "user-1" }] }), headers: request().headers })).statusCode, 200);
    assert.deepEqual(stored, [category]);
  });
}

test("Garmin Lambda authenticates using GARMIN_WEBHOOK_SECRET before the legacy token", async (context) => {
  const originalEnvironment = process.env;
  process.env = {
    ...originalEnvironment,
    DYNAMODB_TABLE_NAME: "test-table",
    DYNAMODB_KMS_KEY_ARN: "test-key",
    GARMIN_WEBHOOK_SECRET: token,
    GARMIN_WEBHOOK_TOKEN: "different-legacy-token-at-least-43-characters-long",
  };
  context.after(() => {
    process.env = originalEnvironment;
  });
  const event: APIGatewayProxyEventV2 = {
    ...request(),
    routeKey: "POST /api/webhooks/garmin/dailies/{token}",
    pathParameters: { token },
    body: "",
  };
  assert.equal((await handler(event)).statusCode, 200);
  assert.equal((await handler({ ...event, pathParameters: { token: process.env.GARMIN_WEBHOOK_TOKEN } })).statusCode, 403);
});
