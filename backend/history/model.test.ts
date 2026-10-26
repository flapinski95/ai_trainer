import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contributions,
  fingerprint,
  metrics,
  needsDetails,
  normalizeSummary,
  syncWindow,
} from "./model";

const payload = {
  id: 123,
  athlete: { id: 456 },
  name: "Ride",
  sport_type: "Ride",
  start_date: "2026-10-25T15:00:00Z",
  distance: 20000,
  moving_time: 3600,
  elapsed_time: 3700,
  map: { summary_polyline: "GPS-must-not-be-retained" },
  description: "private",
};

test("history summaries retain only bounded metrics, never GPS or raw descriptions", () => {
  const activity = normalizeSummary(payload, "456");
  assert.equal(
    JSON.stringify(activity).includes("GPS-must-not-be-retained"),
    false,
  );
  assert.equal(JSON.stringify(activity).includes("private"), false);
  assert.equal(activity.start_date, "2026-10-25T15:00:00.000Z");
  assert.throws(() => normalizeSummary(payload, "999"));
});

test("full first import and subsequent overlapping incremental windows", () => {
  const now = Date.parse("2026-10-25T16:00:00Z");
  assert.equal(syncWindow(now).after, 0);
  const lastSuccess = Math.floor(now / 1000) - 86400;
  assert.equal(syncWindow(now, lastSuccess).after, lastSuccess - 7 * 86400);
  assert.equal(syncWindow(now, lastSuccess, true).after, 0);
});

test("details are requested only for recent activities with expected missing sensor metrics", () => {
  const recent = normalizeSummary({ ...payload, has_heartrate: true }, "456");
  const cutoff = Date.parse("2026-10-25T16:00:00Z") / 1000;
  assert.equal(needsDetails(recent, cutoff), true);
  assert.equal(
    needsDetails({ ...recent, average_heartrate: 140 }, cutoff),
    false,
  );
  assert.equal(
    needsDetails({ ...recent, has_heartrate: false }, cutoff),
    false,
  );
  assert.equal(
    needsDetails({ ...recent, start_date: "2020-01-01T00:00:00Z" }, cutoff),
    false,
  );
});

test("calendar contributions use UTC Monday weeks and preserve sports separately", () => {
  const activity = normalizeSummary(payload, "456");
  const rows = contributions(activity);
  assert.deepEqual(
    rows.map((row) => row.key),
    [
      "SUMMARY#WEEK#2026-10-19#CYCLING",
      "SUMMARY#MONTH#2026-10#CYCLING",
      "SUMMARY#LIFETIME#CYCLING",
    ],
  );
  assert.equal(rows[0]?.elevation, 0);
  assert.equal(
    contributions({
      ...activity,
      sport_type: "Run",
      start_date: "2027-01-01T00:00:00Z",
    })[0]?.key,
    "SUMMARY#WEEK#2026-12-28#RUNNING",
  );
});

test("fingerprints ignore response ordering and unsupported data", () => {
  const activity = normalizeSummary(payload, "456");
  assert.equal(
    fingerprint(activity),
    fingerprint(normalizeSummary({ ...payload, map: null }, "456")),
  );
  assert.notEqual(
    fingerprint(activity),
    fingerprint({ ...activity, distance: 21000 }),
  );
  assert.equal(Object.hasOwn(metrics(activity), "athlete"), false);
});

test("even long multibyte activity labels keep a 200-row checkpoint below the item limit", () => {
  const activity = normalizeSummary(
    {
      ...payload,
      name: "\u754c".repeat(512),
      sport_type: "\u9a91".repeat(100),
    },
    "456",
  );
  assert.equal(activity.name.length, 200);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify(Array.from({ length: 200 }, () => activity)),
    ) < 300000,
  );
});
