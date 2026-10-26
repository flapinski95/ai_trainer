import assert from "node:assert/strict";
import { test } from "node:test";
import { createGarminAccess, GarminRevokedError } from "./access";
import { garminOAuth, GarminApiError } from "../auth/garmin";
import type { Connection } from "../strava-worker/processor";
import type { UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const connection: Connection = {
  userId: "app-user",
  athleteId: "garmin-user",
  active: true,
  scopes: [],
  encryptedTokens: "old-cipher",
  expiresAt: 4102444800,
  authorizedAt: "2026-10-25T00:00:00Z",
};
function dependencies(writes: UpdateItemCommand[]) {
  return {
    decrypt: async () => ({
      Plaintext: Buffer.from(
        JSON.stringify({ accessToken: "access", refreshToken: "refresh" }),
      ),
    }),
    encrypt: async () => ({ CiphertextBlob: Buffer.from("new-cipher") }),
    update: async (command: UpdateItemCommand) => {
      writes.push(command);
    },
    credentials: async () => ({
      clientId: "client-id",
      clientSecret: "client-secret",
    }),
  };
}
test("Garmin permission checks use the verified identity and current granted categories", async () => {
  const writes: UpdateItemCommand[] = [];
  const result = await createGarminAccess(
    dependencies(writes),
    "table",
    "key",
    async (url) =>
      Response.json(
        String(url) === garminOAuth.userId
          ? { userId: "garmin-user" }
          : { permissions: ["HEALTH_EXPORT", "MCT_EXPORT"] },
      ),
  )(connection);
  assert.deepEqual(result.scopes, ["HEALTH_EXPORT", "MCT_EXPORT"]);
  assert.equal(
    writes[0]?.input.ConditionExpression,
    "encryptedTokens = :previous AND #status = :active",
  );
});
test("expired Garmin tokens rotate with HTTP Basic authentication and are encrypted before use", async () => {
  const writes: UpdateItemCommand[] = [];
  let refreshed = false;
  const result = await createGarminAccess(
    dependencies(writes),
    "table",
    "key",
    async (url, init) => {
      if (String(url) === garminOAuth.token) {
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
        );
        assert.equal(init?.redirect, "error");
        refreshed = true;
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 86400,
        });
      }
      assert.equal(refreshed, true);
      return Response.json(
        String(url) === garminOAuth.userId
          ? { userId: "garmin-user" }
          : { permissions: ["ACTIVITY_EXPORT"] },
      );
    },
  )({ ...connection, expiresAt: 1 });
  assert.equal(
    result.encryptedTokens,
    Buffer.from("new-cipher").toString("base64"),
  );
  assert.equal(JSON.stringify(writes).includes("rotated-access"), false);
  assert.equal(JSON.stringify(writes).includes("rotated-refresh"), false);
});
test("invalid client credentials do not falsely revoke Garmin users", async () => {
  await assert.rejects(
    createGarminAccess(dependencies([]), "table", "key", async () =>
      Response.json({ error: "invalid_client" }, { status: 401 }),
    )({ ...connection, expiresAt: 1 }),
    GarminApiError,
  );
  await assert.rejects(
    createGarminAccess(dependencies([]), "table", "key", async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    )({ ...connection, expiresAt: 1 }),
    GarminRevokedError,
  );
});
