import assert from "node:assert/strict";
import { test } from "node:test";
import { createStravaClient } from "./strava";
import { StravaRequestError } from "./processor";

test("Strava activity requests use bearer headers, a deadline and no redirects", async () => {
  const request: typeof fetch = async (input, init) => {
    assert.equal(input, "https://www.strava.com/api/v3/activities/123");
    assert.deepEqual(init?.headers, { authorization: "Bearer test-access" });
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    return Response.json({ id: 123 });
  };
  const client = createStravaClient(
    async () => ({ clientId: "1", clientSecret: "secret" }),
    request,
  );
  assert.deepEqual(await client.fetchActivity(123, "test-access"), { id: 123 });
});

test("token refresh returns rotated credentials without logging responses", async () => {
  const request: typeof fetch = async (_input, init) => {
    assert.ok(init?.body instanceof URLSearchParams);
    assert.equal(init.body.get("grant_type"), "refresh_token");
    assert.equal(init.body.get("refresh_token"), "old-refresh");
    return Response.json({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_at: 4102444800,
    });
  };
  const client = createStravaClient(
    async () => ({ clientId: "1", clientSecret: "secret" }),
    request,
  );
  assert.deepEqual(await client.refresh("old-refresh"), {
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresAt: 4102444800,
  });
});

test("invalid client configuration does not look like revoked athlete consent", async () => {
  const client = createStravaClient(
    async () => ({ clientId: "1", clientSecret: "wrong" }),
    async () =>
      Response.json(
        { errors: [{ resource: "Application", code: "invalid" }] },
        { status: 401 },
      ),
  );
  await assert.rejects(
    client.refresh("refresh"),
    (error) => error instanceof Error && !(error instanceof StravaRequestError),
  );
  const revoked = createStravaClient(
    async () => ({ clientId: "1", clientSecret: "secret" }),
    async () =>
      Response.json(
        { errors: [{ resource: "RefreshToken", code: "invalid" }] },
        { status: 400 },
      ),
  );
  await assert.rejects(
    revoked.refresh("refresh"),
    (error) => error instanceof StravaRequestError && error.status === 400,
  );
});

test("rate limits are retryable and remote response text is not exposed in errors", async () => {
  const client = createStravaClient(
    async () => ({ clientId: "1", clientSecret: "secret" }),
    async () => Response.json({ private: "must-not-appear" }, { status: 429 }),
  );
  await assert.rejects(
    client.fetchActivity(123, "access"),
    (error) =>
      error instanceof StravaRequestError &&
      error.status === 429 &&
      !error.message.includes("must-not-appear"),
  );
});
