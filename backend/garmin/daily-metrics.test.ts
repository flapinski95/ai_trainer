import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeDailyMetric, projectDailyMetric, calendarDateSchema } from "./daily-metrics";

const date = "2026-10-25";
test("Garmin calendarDate wins over UTC receipt and overnight sleep start", () => {
  const fragment = projectDailyMetric("sleeps", { userId: "garmin", calendarDate: date, startTimeInSeconds: 1792880000, durationInSeconds: 27000, overallSleepScore: { value: 86, qualifier: "GOOD" } }, Date.parse("2026-10-26T01:00:00Z"));
  assert.equal(fragment?.date, date);
  assert.equal(fragment?.values.sleepScore, 86);
  assert.equal(fragment?.values.sleepQualifier, "GOOD");
  assert.equal(fragment?.values.sleepDurationSeconds, 27000);
});
test("separate sleep, HRV and daily updates merge without clearing existing measurements", () => {
  const daily = projectDailyMetric("dailies", { userId: "garmin", calendarDate: date, restingHeartRateInBeatsPerMinute: 48 }, 100)!;
  const hrv = projectDailyMetric("hrv", { userId: "garmin", calendarDate: date, lastNightAvg: 62 }, 50)!;
  const metric = mergeDailyMetric(mergeDailyMetric(null, daily), hrv);
  assert.equal(metric?.values?.restingHeartRate, 48);
  assert.equal(metric?.values?.hrvLastNightAverage, 62);
});
test("Body Battery uses the last valid chronological offset, not insertion order or a qualitative estimate", () => {
  const fragment = projectDailyMetric("stressDetails", { userId: "garmin", calendarDate: date, startTimeInSeconds: 1000, durationInSeconds: 900, timeOffsetBodyBatteryValues: { "900": 41, "180": 60, "1000": -1, "bad": 99 }, bodyBatteryDynamicFeedbackEvent: { bodyBatteryLevel: "HIGH" } }, 100)!;
  assert.equal(fragment.values.bodyBattery, 41);
  assert.equal(fragment.values.bodyBatteryMeasuredAt, 1900);
});
test("late partial summaries cannot replace longer coverage from the same source", () => {
  const record = { userId: "garmin", calendarDate: date, startTimeInSeconds: 1000, lastNightAvg: 60 };
  const full = projectDailyMetric("hrv", { ...record, durationInSeconds: 600 }, 100)!;
  const partial = projectDailyMetric("hrv", { ...record, durationInSeconds: 300, lastNightAvg: 20 }, 200)!;
  assert.equal(mergeDailyMetric(mergeDailyMetric(null, full), partial)?.values?.hrvLastNightAverage, 60);
});
test("missing and invalid telemetry remains absent rather than zero or a guessed date", () => {
  assert.equal(projectDailyMetric("hrv", { userId: "garmin", calendarDate: date, lastNightAvg: null }, 1), null);
  assert.equal(projectDailyMetric("sleeps", { userId: "garmin", durationInSeconds: 20000 }, 1), null);
  assert.equal(calendarDateSchema.safeParse("2026-02-30").success, false);
  assert.equal(projectDailyMetric("futureSummary", { userId: "garmin", calendarDate: date, value: 5 }, 1), null);
});

test("archived metrics fill gaps but never replace PUSH fields in either arrival order", () => {
  const archive = { date, type: "import", receivedAt: 0, values: { restingHeartRate: 70, hrvLastNightAverage: 60 } };
  const live = projectDailyMetric("dailies", { userId: "garmin", calendarDate: date, restingHeartRateInBeatsPerMinute: 48 }, 100)!;
  for (const metric of [mergeDailyMetric(mergeDailyMetric(null, live), archive), mergeDailyMetric(mergeDailyMetric(null, archive), live)]) {
    assert.equal(metric?.values?.restingHeartRate, 48);
    assert.equal(metric?.values?.hrvLastNightAverage, 60);
  }
  const updated = projectDailyMetric("dailies", { userId: "garmin", calendarDate: date, restingHeartRateInBeatsPerMinute: 47 }, 200)!;
  assert.equal(mergeDailyMetric(mergeDailyMetric(mergeDailyMetric(null, live), archive), updated)?.values?.restingHeartRate, 47);
});