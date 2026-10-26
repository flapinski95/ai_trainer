import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseStravaAuthorization,
  StravaAuthorizationError,
} from "./strava-account";

const account = {
  provider: "strava",
  providerAccountId: "123",
  access_token: "test-access",
  refresh_token: "test-refresh",
  expires_at: 4102444800,
  scope: "read,activity:read",
};
const profile = { id: 123, firstname: "Test", lastname: "Athlete" };

test("Strava login produces a stable internal user and records actual scopes", () => {
  const result = parseStravaAuthorization(account, profile);
  assert.equal(result.userId, "strava-123");
  assert.equal(result.athleteId, "123");
  assert.deepEqual(result.scopes, ["activity:read", "read"]);
});

test("Strava callback scopes are used only if the token response omits scopes", () => {
  assert.deepEqual(
    parseStravaAuthorization(
      { ...account, scope: undefined },
      profile,
      "read,activity:read_all",
    ).scopes,
    ["activity:read_all", "read"],
  );
  assert.throws(
    () =>
      parseStravaAuthorization(
        { ...account, scope: "read" },
        profile,
        "activity:read",
      ),
    StravaAuthorizationError,
  );
});

test("OAuth refuses missing tokens, expired access, identity mismatches and missing consent", () => {
  for (const invalid of [
    { ...account, access_token: "" },
    { ...account, refresh_token: undefined },
    { ...account, expires_at: 1 },
    { ...account, providerAccountId: "999" },
    { ...account, scope: "read" },
    { ...account, provider: "other" },
  ])
    assert.throws(
      () => parseStravaAuthorization(invalid, profile),
      StravaAuthorizationError,
    );
});
