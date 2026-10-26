import assert from "node:assert/strict";
import { test } from "node:test";
import { createDailyMetricStore } from "./daily-store";
import { ArtifactRevisionConflict } from "./artifacts";
import type { Connection } from "../strava-worker/processor";

const connection: Connection = { userId: "app-user", athleteId: "garmin-user", active: true, scopes: ["HEALTH_EXPORT"], encryptedTokens: "cipher", expiresAt: 4102444800, authorizedAt: "2026-10-25T00:00:00Z" };
const record = { userId: "garmin-user", calendarDate: "2026-10-25", restingHeartRateInBeatsPerMinute: 49 };

test("daily metrics use METRIC#calendarDate, encrypted values and transaction-time Garmin consent", async () => {
  const store = createDailyMetricStore({ get: async () => ({}), artifacts: {
    read: async () => assert.fail("New metrics need no old ciphertext"),
    put: async (PK, SK, value, encrypt, metadata, receivedAt, ttl, consent, expected) => {
      assert.equal(PK, "USER#app-user"); assert.equal(SK, "METRIC#2026-10-25");
      assert.equal(metadata.entityType, "GARMIN_METRIC"); assert.equal(metadata.restingHeartRate, undefined);
      assert.deepEqual(consent, { encryptedTokens: "cipher", permission: "HEALTH_EXPORT" });
      assert.deepEqual(expected, { revision: null }); assert.equal(ttl, undefined);
      assert.equal(await encrypt(), "encrypted-values"); return true;
    },
  }, encryption: {
    encrypt: async (value, context) => { assert.equal(context.userId, "app-user"); assert.equal(context.purpose, "daily-metrics"); assert.equal((value as { values: { restingHeartRate: number } }).values.restingHeartRate, 49); return "encrypted-values"; },
    decrypt: async () => assert.fail("No old metric"),
  } }, "table");
  assert.equal(await store.save(connection, "dailies", record, 100), true);
});

test("daily metric writes reject women's-only consent and foreign provider identities", async () => {
  const store = createDailyMetricStore({ get: async () => assert.fail("Must not read without consent"), artifacts: { read: async () => "", put: async () => false }, encryption: { encrypt: async () => "", decrypt: async () => ({}) } }, "table");
  await assert.rejects(store.save({ ...connection, scopes: ["MCT_EXPORT"] }, "dailies", record, 100));
  await assert.rejects(store.save(connection, "dailies", { ...record, userId: "other" }, 100));
});

test("concurrent daily-source updates retry against the new manifest instead of overwriting blindly", async () => {
  let reads = 0; let attempts = 0;
  const store = createDailyMetricStore({ get: async () => { reads += 1; return {}; }, artifacts: {
    read: async () => "", put: async () => { attempts += 1; if (attempts === 1) throw new ArtifactRevisionConflict(); return true; },
  }, encryption: { encrypt: async () => "cipher", decrypt: async () => ({}) } }, "table");
  assert.equal(await store.save(connection, "dailies", record, 100), true);
  assert.equal(reads, 2); assert.equal(attempts, 2);
});

test("manual health import uses the authenticated user and KMS without fabricated OAuth consent", async () => {
  const store = createDailyMetricStore({ get: async () => ({}), artifacts: {
    read: async () => assert.fail("No previous metric"),
    put: async (PK, SK, value, encrypt, metadata, _receivedAt, _ttl, consent) => {
      assert.equal(PK, "USER#app-user"); assert.equal(SK, "METRIC#2026-10-25");
      assert.equal(metadata.imported, true); assert.equal(consent, undefined);
      assert.equal(await encrypt(), "encrypted"); return true;
    },
  }, encryption: {
    encrypt: async (_value, context) => { assert.equal(context.userId, "app-user"); return "encrypted"; },
    decrypt: async () => assert.fail("No old metric"),
  } }, "table");
  assert.equal(await store.import("app-user", { date: "2026-10-25", values: { bodyBattery: 72 } }), true);
});