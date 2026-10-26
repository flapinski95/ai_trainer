import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProcessor,
  StravaRequestError,
  type WorkerDependencies,
  type Connection,
} from "./processor";
import type { StravaEvent } from "../strava-webhook/events";

const event: StravaEvent = {
  object_type: "activity",
  object_id: 123,
  owner_id: 456,
  aspect_type: "update",
  event_time: 1792886400,
  subscription_id: 789,
  updates: {},
};
const connection: Connection = {
  userId: "strava-456",
  athleteId: "456",
  active: true,
  scopes: ["activity:read"],
  encryptedTokens: "encrypted",
  expiresAt: 4102444800,
  authorizedAt: "2026-10-24T00:00:00Z",
};
const activity = {
  id: 123,
  athlete: { id: 456 },
  name: "Evening ride",
  sport_type: "Ride",
  start_date: "2026-10-25T15:00:00Z",
  distance: 24000,
  moving_time: 3600,
  elapsed_time: 3800,
};

function setup(overrides: Partial<WorkerDependencies> = {}) {
  const calls: string[] = [];
  const dependencies: WorkerDependencies = {
    completed: async () => false,
    connection: async () => connection,
    decrypt: async () => {
      calls.push("decrypt");
      return { accessToken: "access", refreshToken: "refresh" };
    },
    refresh: async () => {
      calls.push("refresh");
      return {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: 4102444800,
      };
    },
    saveTokens: async (current, tokens) => {
      calls.push("save-tokens");
      return { ...current, expiresAt: tokens.expiresAt };
    },
    fetchActivity: async () => {
      calls.push("fetch");
      return activity;
    },
    fetchAthlete: async () => {
      calls.push("athlete");
      return { id: 456 };
    },
    saveActivity: async () => {
      calls.push("save-activity");
    },
    removeActivity: async () => {
      calls.push("remove");
    },
    revoke: async () => {
      calls.push("revoke");
    },
    finish: async (_event, outcome) => {
      calls.push(outcome);
    },
    now: () => 1792886400000,
    ...overrides,
  };
  return { calls, process: createProcessor(dependencies) };
}

test("worker persists a validated activity before completing an event", async () => {
  const worker = setup();
  await worker.process(event);
  assert.deepEqual(worker.calls, [
    "decrypt",
    "fetch",
    "save-activity",
    "PROCESSED",
  ]);
});

test("completed duplicate events do not repeat API calls", async () => {
  const worker = setup({ completed: async () => true });
  await worker.process(event);
  assert.deepEqual(worker.calls, []);
});

test("expired tokens are saved before fetching with rotated credentials", async () => {
  const worker = setup({
    connection: async () => ({ ...connection, expiresAt: 1 }),
  });
  await worker.process(event);
  assert.deepEqual(worker.calls, [
    "decrypt",
    "refresh",
    "save-tokens",
    "fetch",
    "save-activity",
    "PROCESSED",
  ]);
});

test("an expired access token response triggers only one refresh", async () => {
  let requests = 0;
  const worker = setup({
    fetchActivity: async () => {
      if (++requests === 1) throw new StravaRequestError(401);
      return activity;
    },
  });
  await worker.process(event);
  assert.equal(requests, 2);
  assert.deepEqual(worker.calls, [
    "decrypt",
    "refresh",
    "save-tokens",
    "save-activity",
    "PROCESSED",
  ]);
});

test("rate limits and server errors remain retryable and unacknowledged", async () => {
  for (const status of [429, 500, 503]) {
    const worker = setup({
      fetchActivity: async () => {
        throw new StravaRequestError(status);
      },
    });
    await assert.rejects(worker.process(event), StravaRequestError);
    assert.deepEqual(worker.calls, ["decrypt"]);
  }
});

test("revoked connections cannot decrypt or fetch", async () => {
  const worker = setup({
    connection: async () => ({ ...connection, active: false }),
  });
  await worker.process(event);
  assert.deepEqual(worker.calls, ["IGNORED"]);
});

test("delete events are confirmed by the API before removing activities", async () => {
  const removed = setup({
    fetchActivity: async () => {
      throw new StravaRequestError(404);
    },
  });
  await removed.process({ ...event, aspect_type: "delete" });
  assert.deepEqual(removed.calls, ["decrypt", "remove", "PROCESSED"]);
  const forged = setup();
  await forged.process({ ...event, aspect_type: "delete" });
  assert.deepEqual(forged.calls, [
    "decrypt",
    "fetch",
    "save-activity",
    "PROCESSED",
  ]);
});

test("deauthorization is confirmed by rejected refresh credentials", async () => {
  const revoked = setup({
    fetchAthlete: async () => {
      throw new StravaRequestError(401);
    },
    refresh: async () => {
      throw new StravaRequestError(400);
    },
  });
  await revoked.process({
    ...event,
    object_type: "athlete",
    object_id: event.owner_id,
    updates: { authorized: "false" },
  });
  assert.deepEqual(revoked.calls, ["decrypt", "revoke", "IGNORED"]);
  const forged = setup();
  await forged.process({
    ...event,
    object_type: "athlete",
    object_id: event.owner_id,
  });
  assert.deepEqual(forged.calls, ["decrypt", "athlete", "IGNORED"]);
});

test("old deauthorization events do not revoke a newer OAuth authorization", async () => {
  const worker = setup({
    connection: async () => ({
      ...connection,
      authorizedAt: "2026-10-26T00:00:00Z",
    }),
  });
  await worker.process({
    ...event,
    object_type: "athlete",
    object_id: event.owner_id,
  });
  assert.deepEqual(worker.calls, ["IGNORED"]);
});

test("missing user mapping and persistence failures remain retryable", async () => {
  await assert.rejects(setup({ connection: async () => null }).process(event));
  const worker = setup({
    saveActivity: async () => {
      throw new Error("Storage unavailable");
    },
  });
  await assert.rejects(worker.process(event));
  assert.equal(worker.calls.includes("PROCESSED"), false);
});

test("foreign athlete data is never saved", async () => {
  const worker = setup({
    fetchActivity: async () => ({ ...activity, athlete: { id: 999 } }),
  });
  await assert.rejects(worker.process(event), /ownership mismatch/);
  assert.deepEqual(worker.calls, ["decrypt"]);
});

test("invalid refresh credentials revoke the connection", async () => {
  const worker = setup({
    connection: async () => ({ ...connection, expiresAt: 1 }),
    refresh: async () => {
      throw new StravaRequestError(400);
    },
  });
  await worker.process(event);
  assert.deepEqual(worker.calls, ["decrypt", "revoke", "IGNORED"]);
});

test("a token already refreshed in this event is not refreshed repeatedly", async () => {
  const worker = setup({
    connection: async () => ({ ...connection, expiresAt: 1 }),
    fetchActivity: async () => {
      throw new StravaRequestError(401);
    },
  });
  await worker.process(event);
  assert.equal(worker.calls.filter((call) => call === "refresh").length, 1);
  assert.deepEqual(worker.calls.slice(-2), ["revoke", "IGNORED"]);
});

test("future-dated notifications cannot poison workout version ordering", async () => {
  const worker = setup();
  await assert.rejects(
    worker.process({ ...event, event_time: 4102444800 }),
    /future/,
  );
  assert.deepEqual(worker.calls, []);
});

test("missing and null optional telemetry does not prevent workout synchronization", async () => {
  const worker = setup({
    fetchActivity: async () => ({
      ...activity,
      total_elevation_gain: null,
      average_heartrate: null,
      max_heartrate: null,
      average_watts: null,
    }),
  });
  await worker.process(event);
  assert.deepEqual(worker.calls, ["decrypt", "save-activity", "PROCESSED"]);
});
