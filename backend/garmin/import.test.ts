import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { parseGarminHealthFile } from "./import-health";
import { parseGarminImport, type ImportedWorkout } from "./import";
import { createGarminImportStore, planGarminImport, type StoredImportWorkout } from "./import-store";

function workout(index: number): ImportedWorkout {
  return { id: `fit-${index}`, fit: new Uint8Array(), sessionIndex: 0, metrics: {
    name: "Ride", sport_type: "Ride", start_date: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    distance: 20000, moving_time: 3600, elapsed_time: 3700, average_speed: 5.5, average_watts: 180,
  } };
}

test("GDPR User JSON and quoted BOM CSV health records are imported without any FIT activities", () => {
  const csv = '\uFEFFCalendar Date;HRV (ms);Body Battery;Resting HR;Sleep Score\r\n2026-10-25;"62,5";75;48;86\r\n';
  const rows = parseGarminHealthFile(strToU8(csv), "health.csv");
  assert.deepEqual(rows, [{ date: "2026-10-25", values: { hrvLastNightAverage: 62.5, bodyBattery: 75, restingHeartRate: 48, sleepScore: 86 } }]);
  const nested = zipSync({ "DI_CONNECT/DI-Connect-User/health.zip": zipSync({ "daily.csv": strToU8(csv),
    "sleep.json": strToU8(JSON.stringify([{ calendarDate: "2026-10-25", sleepDTO: { sleepTimeSeconds: 27000, sleepScores: { overall: { value: 86 } } } }])) }) });
  const imported = parseGarminImport(nested, "garmin.zip");
  assert.equal(imported.workouts.length, 0);
  assert.equal(imported.dailyMetrics[0]?.values.sleepDurationSeconds, 27000);
  assert.equal(imported.dailyMetrics[0]?.values.hrvLastNightAverage, 62.5);
});

test("nested Body Battery samples use the latest measurement and reject out-of-range values", () => {
  const records = [{ calendarDate: "2026-10-25", bodyBatteryValues: [[1792920000000, 35], [1792910000000, 80]],
    restingHeartRate: -1, hrvSummary: { lastNightAvg: 60 }, sleepDTO: { sleepScores: { overall: { value: 86 } } } }];
  const metrics = parseGarminHealthFile(strToU8(JSON.stringify(records)), "UDSFile.json");
  assert.equal(metrics[0]?.values.bodyBattery, 35);
  assert.equal(metrics[0]?.values.restingHeartRate, undefined);
  assert.equal(metrics[0]?.values.hrvLastNightAverage, 60);
  assert.equal(metrics[0]?.values.sleepScore, 86);
  assert.throws(() => parseGarminImport(strToU8("date,HRV\n2026-10-25,\"unfinished"), "health.csv"));
});

test("retention uses Strava's inclusive 90-day window without a workout count limit", () => {
  const now = Date.UTC(2026, 9, 26);
  const boundary = now - 90 * 86400 * 1000;
  const workouts = Array.from({ length: 120 }, (_, index) => {
    const entry = workout(index);
    return { ...entry, metrics: { ...entry.metrics, start_date: new Date(now - index * 3600000).toISOString() } };
  });
  for (const timestamp of [boundary, boundary - 1]) {
    const entry = workout(workouts.length);
    workouts.push({ ...entry, metrics: { ...entry.metrics, start_date: new Date(timestamp).toISOString() } });
  }
  const plan = planGarminImport([], workouts, now / 1000);
  assert.equal(plan.detailedTimes.size, 121);
  assert.equal(plan.detailedTimes.has(new Date(boundary).toISOString()), true);
  assert.equal(plan.detailedTimes.has(new Date(boundary - 1).toISOString()), false);
});

test("retention includes prior imports and deduplication uses timestamps across providers and sports", () => {
  const imported = workout(10);
  const pushed = workout(11);
  const existing: StoredImportWorkout[] = Array.from({ length: 90 }, (_, index) => ({
    id: `existing-${index}`, provider: "garmin", timestamp: workout(index + 100).metrics.start_date,
    source: "HISTORY", manual: true, detailLevel: "DETAIL",
  }));
  existing.push({ id: "strava-one", provider: "strava", timestamp: imported.metrics.start_date, source: "HISTORY", manual: false, detailLevel: "DETAIL" });
  existing.push({ id: "push-one", provider: "garmin", timestamp: pushed.metrics.start_date, source: "WEBHOOK", manual: false, detailLevel: "DETAIL" });
  const differentSport = { ...imported, metrics: { ...imported.metrics, sport_type: "Run" } };
  const plan = planGarminImport(existing, [differentSport, pushed, workout(12)], Date.parse(workout(190).metrics.start_date) / 1000);
  assert.equal(plan.duplicates, 2);
  assert.equal(plan.accepted.length, 1);
  assert.equal(plan.detailedTimes.has(workout(12).metrics.start_date), false);
  assert.equal(plan.detailedTimes.size, 90);
});

test("older imports evict cached telemetry but retain workouts and transactional aggregates", async () => {
  const older = workout(0);
  const existing = Array.from({ length: 91 }, (_, index) => marshall({ PK: "USER#user", SK: `ACTIVITY#STRAVA#${index}`,
    entityType: "WORKOUT", status: "ACTIVE", provider: "strava", source: "HISTORY", activityId: String(index),
    start_date: workout(index + 10).metrics.start_date, detailLevel: "DETAIL" }));
  const old = marshall({ PK: "USER#user", SK: "ACTIVITY#GARMIN#fit-old", entityType: "WORKOUT", status: "ACTIVE",
    provider: "garmin", source: "HISTORY", manualImport: true, activityId: "fit-old", start_date: workout(1).metrics.start_date, detailLevel: "DETAIL" });
  const items = new Map([["ACTIVITY#GARMIN#fit-old", old]]);
  const writes: TransactWriteItemsCommand[] = [];
  const importHistory = createGarminImportStore({
    get: async (command) => ({ Item: items.get(command.input.Key?.SK?.S ?? "") }),
    query: async (command) => {
      const prefix = command.input.ExpressionAttributeValues?.[":prefix"]?.S;
      if (prefix === "ACTIVITY#") return { Items: [...existing, old] };
      if (prefix === "TELEMETRY_INDEX#GARMIN#") return { Items: [marshall({ PK: "USER#user", SK: "TELEMETRY_INDEX#GARMIN#fit-old", activityId: "fit-old", start_date: workout(1).metrics.start_date })] };
      if (prefix === "TELEMETRY#GARMIN#fit-old") return { Items: [marshall({ PK: "USER#user", SK: "TELEMETRY#GARMIN#fit-old" }), marshall({ PK: "USER#user", SK: "TELEMETRY#GARMIN#fit-old#PART#rev#000" })] };
      return { Items: [] };
    },
    transact: async (command) => {
      writes.push(command);
      for (const operation of command.input.TransactItems ?? []) {
        if (operation.Put?.Item?.SK?.S) items.set(operation.Put.Item.SK.S, operation.Put.Item);
        if (operation.Delete?.Key?.SK?.S) items.delete(operation.Delete.Key.SK.S);
      }
    },
    artifacts: { read: async () => assert.fail("No telemetry read for summaries"), put: async () => assert.fail("No telemetry saved for summaries") },
    encryption: { encrypt: async () => assert.fail("No telemetry encryption for summaries"), decrypt: async () => assert.fail("No telemetry decryption for summaries") },
    daily: { import: async () => assert.fail("No health records") },
  }, "table");
  const result = await importHistory("user", { workouts: [older], dailyMetrics: [], skipped: 0 });
  assert.equal(result.imported, 1); assert.equal(result.summaries, 1); assert.equal(result.detailed, 0);
  assert.equal(items.get("ACTIVITY#GARMIN#fit-0")?.detailLevel?.S, "SUMMARY");
  const operations = writes.flatMap((command) => command.input.TransactItems ?? []);
  assert.ok(operations.some((operation) => operation.Delete?.Key?.SK?.S === "TELEMETRY#GARMIN#fit-old"));
  assert.equal(operations.some((operation) => operation.Delete?.Key?.SK?.S?.startsWith("ACTIVITY#")), false);
  assert.ok(operations.some((operation) => operation.Update?.Key?.SK?.S?.startsWith("SUMMARY#GARMIN#") && operation.Update.ExpressionAttributeValues?.[":count"]?.N === "1"));
});