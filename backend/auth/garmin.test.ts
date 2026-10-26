import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchGarminProfile,
  garminOAuth,
  parseGarminAuthorization,
  garminAuthorizationRedirect,
  garminAuthorizationResponse,
} from "./garmin";

test("Garmin reads user identity and actual permissions server-to-server", async () => {
  const requested: string[] = [];
  const result = await fetchGarminProfile(
    "secret-access",
    async (input, init) => {
      requested.push(String(input));
      assert.deepEqual(init?.headers, {
        authorization: "Bearer secret-access",
      });
      assert.equal(init?.redirect, "error");
      return Response.json(
        String(input) === garminOAuth.userId
          ? { userId: "garmin-1" }
          : { permissions: ["ACTIVITY_EXPORT", "HEALTH_EXPORT", "MCT_EXPORT"] },
      );
    },
  );
  assert.equal(result.userId, "garmin-1");
  assert.deepEqual(result.permissions, [
    "ACTIVITY_EXPORT",
    "HEALTH_EXPORT",
    "MCT_EXPORT",
  ]);
  assert.deepEqual(requested, [garminOAuth.userId, garminOAuth.permissions]);
});

test("Garmin authorization does not require Strava or invent health/history permissions", () => {
  const profile = { userId: "garmin-1", permissions: ["HEALTH_EXPORT"] };
  const account = {
    provider: "garmin",
    providerAccountId: "garmin-1",
    access_token: "access",
    refresh_token: "refresh",
    expires_at: 4102444800,
  };
  assert.deepEqual(parseGarminAuthorization(account, profile).scopes, [
    "HEALTH_EXPORT",
  ]);
  assert.throws(() =>
    parseGarminAuthorization(
      { ...account, providerAccountId: "other" },
      profile,
    ),
  );
});

test("Garmin redirects remove injected scopes without weakening state or PKCE", () => {
  const url = new URL(garminAuthorizationRedirect(`${garminOAuth.authorization}?scope=openid+profile+email&state=nonce&code_challenge=challenge&code_challenge_method=S256`));
  assert.equal(url.searchParams.has("scope"), false);
  assert.equal(url.searchParams.get("state"), "nonce");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "challenge");
  assert.equal(new URL(garminAuthorizationRedirect("https://www.strava.com/oauth/authorize?scope=read")).searchParams.get("scope"), "read");
});

test("immutable callback-error redirects remain untouched and authorization cookies survive rewriting", () => {
  const error = Response.redirect("http://localhost:3000/?error=Configuration");
  assert.equal(garminAuthorizationResponse(error), error);
  const headers = new Headers({ location: `${garminOAuth.authorization}?scope=openid&state=nonce` });
  headers.append("set-cookie", "state=test; HttpOnly"); headers.append("set-cookie", "pkce=test; HttpOnly");
  const rewritten = garminAuthorizationResponse(new Response(null, { status: 302, headers }));
  assert.equal(new URL(rewritten.headers.get("location")!).searchParams.has("scope"), false);
  assert.equal(rewritten.headers.getSetCookie().length, 2);
});
