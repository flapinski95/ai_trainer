import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAuthSettings } from "./config";

const base = {
  AUTH_URL: "http://localhost:3000",
  AUTH_SECRET: "test-only-secret-at-least-32-characters",
  AWS_REGION: "eu-north-1",
  DYNAMODB_TABLE_NAME: "table",
  DYNAMODB_KMS_KEY_ARN: "arn:aws:kms:eu-north-1:123456789012:key/example",
};
test("Garmin auth configuration works without any Strava credentials", () => {
  const settings = parseAuthSettings({
    ...base,
    AUTH_GARMIN_ID: "client",
    AUTH_GARMIN_SECRET: "secret",
  });
  assert.ok(settings?.garmin);
  assert.equal(settings?.strava, null);
});
test("Strava and Garmin configuration failures are independent", () => {
  const settings = parseAuthSettings({
    ...base,
    AUTH_STRAVA_ID: "123",
    AUTH_STRAVA_SECRET: "secret",
    AUTH_GARMIN_ID: "incomplete",
  });
  assert.ok(settings?.strava);
  assert.equal(settings?.garmin, null);
  assert.equal(parseAuthSettings({ ...base, AUTH_SECRET: "short" }), null);
});
