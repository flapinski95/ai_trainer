import assert from "node:assert/strict";
import { test } from "node:test";
import { activityProvider, healthProvider } from "./policy";

test("Garmin-only users receive Garmin workouts and health without Strava", () => {
  const connections = { strava: null, garmin: { active: true } };
  assert.equal(activityProvider(connections), "garmin");
  assert.equal(healthProvider(connections), "garmin");
});

test("both providers select Strava workouts and Garmin health", () => {
  const connections = { strava: { active: true }, garmin: { active: true } };
  assert.equal(activityProvider(connections), "strava");
  assert.equal(healthProvider(connections), "garmin");
});

test("revoked Strava falls back to Garmin while revoked Garmin contributes no health", () => {
  assert.equal(
    activityProvider({ strava: { active: false }, garmin: { active: true } }),
    "garmin",
  );
  assert.equal(
    healthProvider({ strava: { active: true }, garmin: { active: false } }),
    null,
  );
  assert.equal(activityProvider({ strava: null, garmin: null }), null);
});

test("a live connection without category consent cannot contribute that data", () => {
  assert.equal(activityProvider({ strava: { active: true, scopes: ["read"] }, garmin: { active: true, scopes: ["ACTIVITY_EXPORT"] } }), "garmin");
  assert.equal(activityProvider({ strava: null, garmin: { active: true, scopes: ["HEALTH_EXPORT"] } }), null);
  assert.equal(healthProvider({ strava: null, garmin: { active: true, scopes: ["ACTIVITY_EXPORT"] } }), null);
});
