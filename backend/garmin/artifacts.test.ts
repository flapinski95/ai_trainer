import assert from "node:assert/strict";
import { test } from "node:test";
import { createArtifactStore } from "./artifacts";

test("large encrypted health artifacts are committed atomically and unchanged deliveries cost no rewrite", async () => {
  let encryptions = 0;
  const store = createArtifactStore(
    {
      get: async () => ({}),
      query: async () => ({}),
      transact: async (command) => {
        assert.equal(command.input.TransactItems?.length, 4);
        assert.equal(
          JSON.stringify(command.input).includes("sensitive-health"),
          false,
        );
      },
    },
    "table",
  );
  const body = { field: "sensitive-health" };
  await store.put(
    "USER#user",
    "HEALTH#GARMIN#test",
    body,
    async () => {
      encryptions += 1;
      return "x".repeat(130000);
    },
    { entityType: "GARMIN_HEALTH" },
    100,
  );
  assert.equal(encryptions, 1);
});
