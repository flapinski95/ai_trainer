import assert from "node:assert/strict";
import { test } from "node:test";
import { createGarminProcessor } from "./processor";
import { normalizeGarminActivity } from "./activity";
import type { Connection } from "../strava-worker/processor";

const connection: Connection = {
  userId: "application-user",
  athleteId: "garmin-1",
  active: true,
  scopes: ["ACTIVITY_EXPORT", "HEALTH_EXPORT", "MCT_EXPORT"],
  encryptedTokens: "cipher",
  expiresAt: 4102444800,
  authorizedAt: "2026-10-25T00:00:00Z",
};
test("Garmin worker initializes AWS clients at module scope", async () => {
  const worker = await import("./worker");
  assert.equal(typeof worker.handler, "function");
});

test("Garmin-only users preserve all health data without any Strava lookup", async () => {
  const record = {
    userId: "garmin-1",
    summaryId: "health-1",
    undocumentedFutureField: { allValues: [1, 2] },
  };
  let saved = false;
  await createGarminProcessor({
    connection: async () => connection,
    verify: async (value) => value,
    revoke: async () => {},
    saveRecord: async (value, category, type, payload) => {
      assert.equal(value.userId, "application-user");
      assert.equal(category, "health");
      assert.equal(type, "hrv");
      assert.deepEqual(payload, record);
      saved = true;
    },
    saveActivity: async () => assert.fail("Health is not a workout"),
  })("health", "hrv", record);
  assert.equal(saved, true);
});
test("denied women's-health permission prevents medical data persistence", async () => {
  await createGarminProcessor({
    connection: async () => connection,
    verify: async (value) => ({ ...value, scopes: ["HEALTH_EXPORT"] }),
    revoke: async () => {},
    saveRecord: async () => assert.fail("No women's health consent"),
    saveActivity: async () => {},
  })("womens-health", "futureSummary", { userId: "garmin-1", summaryId: "1" });
});
test("documented activity details normalize summary fields without retaining GPS in workout rows", () => {
  const result = normalizeGarminActivity({
    userId: "garmin-1",
    summaryId: "123-detail",
    activityId: 123,
    summary: {
      startTimeInSeconds: 1792886400,
      durationInSeconds: 3600,
      activityType: "CYCLING",
      activityName: "Ride",
      distanceInMeters: 20000,
    },
    samples: [{ latitudeInDegree: 50 }],
  });
  assert.equal(result.id, "123");
  assert.equal(result.metrics.sport_type, "Ride");
  assert.equal(JSON.stringify(result.metrics).includes("latitude"), false);
});

test("daily projection follows complete Health persistence and cannot receive women's-health records", async () => {
  const calls: string[] = [];
  const processor = createGarminProcessor({ connection: async () => connection, verify: async (value) => value, revoke: async () => {},
    saveRecord: async () => { calls.push("full-record"); },
    saveDailyMetric: async () => { calls.push("daily-metric"); }, saveActivity: async () => {},
  });
  await processor("health", "hrv", { userId: "garmin-1", calendarDate: "2026-10-25", lastNightAvg: 60 });
  assert.deepEqual(calls, ["full-record", "daily-metric"]);
  calls.length = 0;
  await processor("womens-health", "futureSummary", { userId: "garmin-1", summaryId: "1" });
  assert.deepEqual(calls, ["full-record"]);
});

test("raw Health persistence failures do not create a false daily success", async () => {
  const processor = createGarminProcessor({ connection: async () => connection, verify: async (value) => value, revoke: async () => {},
    saveRecord: async () => { throw new Error("Storage unavailable"); },
    saveDailyMetric: async () => assert.fail("Must retain the complete record first"), saveActivity: async () => {},
  });
  await assert.rejects(processor("health", "hrv", { userId: "garmin-1", calendarDate: "2026-10-25", lastNightAvg: 60 }));
});

test("Garmin activity summaries and details request push but manual updates do not", async () => {
  const requested: boolean[] = [];
  const processor = createGarminProcessor({
    connection: async () => connection, verify: async (value) => value, revoke: async () => {},
    saveRecord: async () => {},
    saveActivity: async (_connection, _id, _metrics, notify) => { requested.push(notify === true); },
  });
  const record = {
    userId: "garmin-1", activityId: 123, summaryId: "123",
    startTimeInSeconds: 1792886400, durationInSeconds: 3600,
    activityType: "CYCLING", activityName: "Ride", distanceInMeters: 20000,
  };
  for (const type of ["activities", "activityDetails", "manuallyUpdatedActivities"]) {
    await processor("activity", type, record);
  }
  assert.deepEqual(requested, [true, true, false]);
});
