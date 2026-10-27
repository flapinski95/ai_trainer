import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createEnvelopeEncryption } from "./encryption";
import { chunks, payloadSchema } from "./payload";

for (const summaryType of ["dailies", "sleeps", "activities"] as const) {
  test(`Garmin ${summaryType} payloads validate record identity before processing`, () => {
    const body = {
      [summaryType]: [{ userId: "garmin-1", summaryId: "summary-1" }],
    };
    assert.deepEqual(payloadSchema.parse(body), body);
    assert.throws(() => payloadSchema.parse({ [summaryType]: [{ userId: 123 }] }));
    assert.throws(() => payloadSchema.parse({ [summaryType]: [{ summaryId: "missing-user" }] }));
    assert.throws(() => payloadSchema.parse({ [summaryType]: { userId: "garmin-1" } }));
  });
}

test("Garmin health schemas preserve all nested and future JSON fields", () => {
  const body = {
    hrv: [
      {
        userId: "garmin-1",
        summaryId: "summary-1",
        futureMetric: { custom: [1, 2, 3] },
        sensorSamples: { "123": 44 },
      },
    ],
  };
  assert.deepEqual(payloadSchema.parse(body), body);
  assert.throws(() =>
    payloadSchema.parse({ hrv: [{ summaryId: "missing-user" }] }),
  );
});
test("large and sensitive Garmin data is encrypted, compressed, authenticated and never truncated", async () => {
  const key = randomBytes(32);
  const encryption = createEnvelopeEncryption(
    {
      generate: async () => ({
        Plaintext: Buffer.from(key),
        CiphertextBlob: Buffer.from("encrypted-key"),
      }),
      decrypt: async () => ({ Plaintext: Buffer.from(key) }),
    },
    "key",
  );
  const data = {
    privateHealth: "sensitive",
    samples: Array.from({ length: 10000 }, (_, index) => ({
      timestamp: index,
      value: index % 100,
    })),
  };
  const context = { provider: "garmin", purpose: "health", userId: "user-1" };
  const encrypted = await encryption.encrypt(data, context);
  assert.equal(encrypted.includes("sensitive"), false);
  assert.deepEqual(await encryption.decrypt(encrypted, context), data);
  await assert.rejects(
    encryption.decrypt(encrypted, { ...context, userId: "other-user" }),
  );
  assert.equal(chunks(encrypted).join(""), encrypted);
});
