import assert from "node:assert/strict";
import { test } from "node:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createGarminIngress } from "./ingress";

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
