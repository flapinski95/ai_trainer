import assert from "node:assert/strict";
import { test } from "node:test";
import { createHistoryProcessor } from "./processor";
import { jobSchema, type SyncJob } from "./jobs";
import { RateLimitError } from "./rate-limit";
import type { Connection } from "../strava-worker/processor";

const now = Date.parse("2026-10-25T16:00:00Z");
const connection: Connection = {
  userId: "strava-456",
  athleteId: "456",
  active: true,
  scopes: ["activity:read"],
  encryptedTokens: "cipher",
  expiresAt: 4102444800,
  authorizedAt: "2026-10-25T00:00:00Z",
};
const row = {
  id: 123,
  athlete: { id: 456 },
  name: "Ride",
  sport_type: "Ride",
  start_date: "2026-10-25T15:00:00Z",
  distance: 20000,
  moving_time: 3600,
  elapsed_time: 3700,
};
const initial = () =>
  jobSchema.parse({
    userId: "strava-456",
    jobId: "job",
    state: "RUNNING",
    after: 0,
    before: now / 1000,
    page: 1,
    offset: 0,
    readAll: false,
    requestedAt: now / 1000,
    dueAt: now / 1000,
    leaseId: "lease",
  });
type Dependencies = Parameters<typeof createHistoryProcessor>[0];

function setup(overrides: Partial<Dependencies> = {}) {
  let current = initial();
  const saved: SyncJob[] = [];
  let listings = 0;
  let writes = 0;
  const process = createHistoryProcessor({
    claim: async () => structuredClone(current),
    checkpoint: async (job) => {
      current = structuredClone(job);
      saved.push(current);
    },
    connection: async () => connection,
    decrypt: async () => ({ accessToken: "access", refreshToken: "refresh" }),
    refresh: async () => ({
      accessToken: "new",
      refreshToken: "rotated",
      expiresAt: 4102444800,
    }),
    saveTokens: async (value) => value,
    revoke: async () => {},
    listActivities: async () => {
      listings += 1;
      return Array.from({ length: 12 }, (_, index) => ({
        ...row,
        id: 123 + index,
      }));
    },
    fetchActivity: async () =>
      assert.fail("Complete summaries must not request details"),
    saveHistory: async () => {
      writes += 1;
      return true;
    },
    clock: () => now,
    ...overrides,
  });
  return { process, saved, counts: () => ({ listings, writes }) };
}

test("import yields after ten activities and resumes the cached page without another API request", async () => {
  const importer = setup();
  await importer.process("strava-456");
  assert.equal(importer.saved[0]?.state, "QUEUED");
  assert.equal(importer.saved[0]?.offset, 10);
  await importer.process("strava-456");
  assert.equal(importer.saved[1]?.state, "SUCCEEDED");
  assert.equal(importer.saved[1]?.lastSuccess, now / 1000);
  assert.deepEqual(importer.counts(), { listings: 1, writes: 12 });
});

test("rate-limit waits preserve the cursor and actual reset time without failing the job", async (context) => {
  context.mock.method(console, "error", () => {});
  const importer = setup({
    listActivities: async () => {
      throw new RateLimitError(now / 1000 + 900);
    },
  });
  await importer.process("strava-456");
  assert.equal(importer.saved[0]?.state, "WAITING");
  assert.equal(importer.saved[0]?.errorCode, "RATE_LIMIT");
  assert.equal(importer.saved[0]?.dueAt, now / 1000 + 900);
  assert.equal(importer.saved[0]?.failures, 0);
});

test("lost consent and wrong-user mappings stop import before credentials or API access", async () => {
  for (const current of [
    { ...connection, active: false },
    { ...connection, userId: "strava-999" },
  ]) {
    const importer = setup({
      connection: async () => current,
      decrypt: async () =>
        assert.fail("No credentials for unauthorized imports"),
    });
    await importer.process("strava-456");
    assert.equal(importer.saved[0]?.state, "FAILED");
    assert.equal(importer.saved[0]?.errorCode, "AUTHORIZATION");
  }
});

test("an exhausted Lambda budget yields without dropping or acknowledging unprocessed activities", async () => {
  const importer = setup({ remaining: () => 8000 });
  await importer.process("strava-456");
  assert.equal(importer.saved[0]?.offset, 0);
  assert.equal(importer.saved[0]?.pending?.length, 12);
  assert.deepEqual(importer.counts(), { listings: 1, writes: 0 });
});

test("empty terminal pages complete the import without a full archive stored in the job", async () => {
  const importer = setup({ listActivities: async () => [] });
  await importer.process("strava-456");
  assert.equal(importer.saved[0]?.state, "SUCCEEDED");
  assert.equal(importer.saved[0]?.pending, undefined);
});
