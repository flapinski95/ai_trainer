import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  ConditionalCheckFailedException,
  type PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { createHandler, handler } from "./handler";
import { eventIdentity, stravaEventSchema, type StravaEvent } from "./events";
import { createEventStore } from "./store";

const originalToken = process.env.STRAVA_VERIFY_TOKEN;
const originalTable = process.env.DYNAMODB_TABLE_NAME;
const originalSubscription = process.env.STRAVA_SUBSCRIPTION_ID;
after(() => {
  if (originalToken === undefined) delete process.env.STRAVA_VERIFY_TOKEN;
  else process.env.STRAVA_VERIFY_TOKEN = originalToken;
  if (originalTable === undefined) delete process.env.DYNAMODB_TABLE_NAME;
  else process.env.DYNAMODB_TABLE_NAME = originalTable;
  if (originalSubscription === undefined)
    delete process.env.STRAVA_SUBSCRIPTION_ID;
  else process.env.STRAVA_SUBSCRIPTION_ID = originalSubscription;
});

const activity: StravaEvent = {
  object_type: "activity",
  object_id: 123,
  aspect_type: "create",
  owner_id: 456,
  subscription_id: 789,
  event_time: 1792886400,
  updates: {},
};

function post(payload: unknown = activity): APIGatewayProxyEventV2 {
  return {
    ...event("", "POST"),
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  };
}

test("Strava event ingestion", async (context) => {
  process.env.DYNAMODB_TABLE_NAME = "test-table";
  process.env.STRAVA_SUBSCRIPTION_ID = "789";
  const writes = new Map<string, PutItemCommand>();
  const store = createEventStore(async (command) => {
    assert.equal(command.input.TableName, "test-table");
    assert.equal(
      command.input.ConditionExpression,
      "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    );
    const key = JSON.stringify([
      command.input.Item?.PK,
      command.input.Item?.SK,
    ]);
    if (writes.has(key)) {
      throw new ConditionalCheckFailedException({
        message: "Duplicate",
        $metadata: {},
      });
    }
    writes.set(key, command);
  });
  const ingest = createHandler(store);

  await context.test(
    "stores an event and acknowledges concurrent duplicate deliveries",
    async () => {
      const results = await Promise.all([ingest(post()), ingest(post())]);
      assert.deepEqual(
        results.map((result) => result.statusCode),
        [200, 200],
      );
      assert.equal(writes.size, 1);
      const command = [...writes.values()][0]!;
      assert.equal(command.input.Item?.PK?.S, "STRAVA#ATHLETE#456");
      assert.equal(command.input.Item?.status?.S, "RECEIVED");
      assert.deepEqual(
        JSON.parse(command.input.Item?.payload?.S ?? ""),
        activity,
      );
    },
  );

  await context.test(
    "normalizes update field order when deduplicating",
    async () => {
      assert.equal(
        eventIdentity({
          ...activity,
          updates: { title: "Ride", type: "Ride" },
        }),
        eventIdentity({
          ...activity,
          updates: { type: "Ride", title: "Ride" },
        }),
      );
      assert.notEqual(
        eventIdentity(activity),
        eventIdentity({ ...activity, aspect_type: "delete" }),
      );
      assert.notEqual(
        eventIdentity(activity),
        eventIdentity({ ...activity, updates: { title: "Changed" } }),
      );
    },
  );

  await context.test(
    "supports create, update and delete activity events",
    async () => {
      for (const aspect_type of ["create", "update", "delete"] as const) {
        assert.equal(
          (await ingest(post({ ...activity, aspect_type }))).statusCode,
          200,
        );
      }
    },
  );

  await context.test(
    "stores deauthorization without pretending to revoke OAuth credentials",
    async () => {
      const payload = {
        ...activity,
        object_type: "athlete",
        object_id: activity.owner_id,
        aspect_type: "update",
        updates: { authorized: "false" },
      };
      assert.equal((await ingest(post(payload))).statusCode, 200);
      assert.equal(
        stravaEventSchema.safeParse({ ...payload, updates: {} }).success,
        false,
      );
    },
  );

  await context.test("decodes API Gateway base64 bodies", async () => {
    const request = post();
    request.body = Buffer.from(request.body!).toString("base64");
    request.isBase64Encoded = true;
    assert.equal((await ingest(request)).statusCode, 200);
  });

  await context.test(
    "rejects invalid events without calling persistence",
    async () => {
      let calls = 0;
      const rejectInvalid = createHandler(async () => {
        calls += 1;
      });
      for (const payload of [
        null,
        [],
        {},
        { ...activity, owner_id: -1 },
        { ...activity, object_id: 1.5 },
        { ...activity, object_id: Number.MAX_SAFE_INTEGER + 1 },
        { ...activity, object_type: "unknown" },
        { ...activity, event_time: -1 },
        { ...activity, updates: { title: {} } },
      ]) {
        assert.equal((await rejectInvalid(post(payload))).statusCode, 400);
      }
      assert.equal(calls, 0);
    },
  );

  await context.test(
    "rejects invalid JSON, missing bodies, oversized bodies and unsupported content types",
    async () => {
      assert.equal((await ingest({ ...post(), body: "{" })).statusCode, 400);
      assert.equal(
        (await ingest({ ...post(), body: undefined })).statusCode,
        400,
      );
      assert.equal(
        (await ingest({ ...post(), body: " ".repeat(16385) })).statusCode,
        413,
      );
      assert.equal(
        (await ingest({ ...post(), headers: { "content-type": "text/plain" } }))
          .statusCode,
        415,
      );
    },
  );

  await context.test(
    "rejects other subscription IDs without persistence",
    async () => {
      const rejectSubscription = createHandler(async () =>
        assert.fail("Must not persist"),
      );
      assert.equal(
        (await rejectSubscription(post({ ...activity, subscription_id: 999 })))
          .statusCode,
        403,
      );
    },
  );

  await context.test(
    "does not acknowledge until the durable write finishes",
    async () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acknowledged = false;
      const result = createHandler(async () => pending)(post()).then(
        (response) => {
          acknowledged = true;
          return response;
        },
      );
      await Promise.resolve();
      assert.equal(acknowledged, false);
      release();
      assert.equal((await result).statusCode, 200);
    },
  );

  await context.test(
    "returns 503 for database and KMS failures without leaking error details",
    async (subcontext) => {
      const logger = subcontext.mock.method(console, "error", () => {});
      const failingStore = createEventStore(async () => {
        throw new Error("private-database-error");
      });
      const response = await createHandler(failingStore)(post());
      assert.equal(response.statusCode, 503);
      assert.equal(response.body?.includes("private-database-error"), false);
      assert.deepEqual(logger.mock.calls[0]?.arguments, [
        "strava_webhook_persistence_failed",
      ]);
    },
  );

  await context.test(
    "fails closed when the table or subscription configuration is missing",
    async () => {
      delete process.env.STRAVA_SUBSCRIPTION_ID;
      assert.equal((await ingest(post())).statusCode, 503);
      process.env.STRAVA_SUBSCRIPTION_ID = "789";
      delete process.env.DYNAMODB_TABLE_NAME;
      assert.equal((await ingest(post())).statusCode, 503);
    },
  );
});

function event(rawQueryString: string, method = "GET"): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: `${method} /webhooks/strava`,
    rawPath: "/webhooks/strava",
    rawQueryString,
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      accountId: "test",
      apiId: "test",
      domainName: "test",
      domainPrefix: "test",
      http: {
        method,
        path: "/webhooks/strava",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test",
      },
      requestId: "test",
      routeKey: `${method} /webhooks/strava`,
      stage: "$default",
      time: "test",
      timeEpoch: 0,
    },
  };
}

test("Strava webhook verification", async (context) => {
  process.env.STRAVA_VERIFY_TOKEN = "test-secret";
  const query =
    "hub.mode=subscribe&hub.challenge=challenge%2B123&hub.verify_token=test-secret";

  await context.test("echoes the decoded challenge", async () => {
    const result = await handler(event(query));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body!), {
      "hub.challenge": "challenge+123",
    });
  });

  for (const invalid of [
    "",
    query.replace("subscribe", "invalid"),
    query.replace("challenge%2B123", ""),
    `${query}&hub.verify_token=other`,
  ]) {
    await context.test(`rejects malformed query: ${invalid}`, async () => {
      assert.equal((await handler(event(invalid))).statusCode, 400);
    });
  }

  await context.test(
    "rejects an incorrect token without leaking it",
    async () => {
      const result = await handler(
        event(query.replace("test-secret", "wrong")),
      );
      assert.equal(result.statusCode, 403);
      assert.equal(result.body?.includes("test-secret"), false);
    },
  );

  await context.test("rejects unsupported methods", async () => {
    assert.equal((await handler(event("", "DELETE"))).statusCode, 405);
  });

  await context.test(
    "fails closed when the verification token is missing",
    async () => {
      delete process.env.STRAVA_VERIFY_TOKEN;
      assert.equal((await handler(event(query))).statusCode, 503);
    },
  );
});
