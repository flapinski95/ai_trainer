import { EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import {
  fetchGarminProfile,
  GarminApiError,
  garminOAuth,
} from "../auth/garmin";
import type { Connection } from "../strava-worker/processor";

export class GarminRevokedError extends Error {
  constructor() {
    super("Garmin authorization revoked");
    this.name = "GarminRevokedError";
  }
}
type Dependencies = {
  decrypt: (command: DecryptCommand) => Promise<{ Plaintext?: Uint8Array }>;
  encrypt: (
    command: EncryptCommand,
  ) => Promise<{ CiphertextBlob?: Uint8Array }>;
  update: (command: UpdateItemCommand) => Promise<unknown>;
  credentials: () => Promise<{ clientId: string; clientSecret: string }>;
};
export function createGarminAccess(
  dependencies: Dependencies,
  table: string,
  keyArn: string,
  request: typeof fetch = fetch,
) {
  return async (original: Connection): Promise<Connection> => {
    let connection = original;
    const context = { userId: connection.userId, provider: "garmin" };
    const decoded = await dependencies.decrypt(
      new DecryptCommand({
        KeyId: keyArn,
        CiphertextBlob: Buffer.from(connection.encryptedTokens, "base64"),
        EncryptionContext: context,
      }),
    );
    if (!decoded.Plaintext)
      throw new Error("Garmin credential decryption unavailable");
    let tokens = z
      .object({
        accessToken: z.string().min(1),
        refreshToken: z.string().min(1),
      })
      .parse(JSON.parse(Buffer.from(decoded.Plaintext).toString("utf8")));
    const key = marshall({
      PK: `USER#${connection.userId}`,
      SK: "CONNECTION#GARMIN",
    });
    let refreshed = false;
    const refresh = async () => {
      if (refreshed) throw new GarminRevokedError();
      const client = await dependencies.credentials();
      const response = await request(garminOAuth.token, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(6000),
        headers: {
          authorization: `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
        }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const error = z.object({ error: z.string() }).safeParse(data);
        if (
          response.status === 400 &&
          error.success &&
          error.data.error === "invalid_grant"
        )
          throw new GarminRevokedError();
        throw new GarminApiError(response.status);
      }
      const renewed = z
        .object({
          access_token: z.string().min(1),
          refresh_token: z.string().min(1),
          expires_in: z.number().int().positive(),
        })
        .parse(data);
      tokens = {
        accessToken: renewed.access_token,
        refreshToken: renewed.refresh_token,
      };
      const encrypted = await dependencies.encrypt(
        new EncryptCommand({
          KeyId: keyArn,
          EncryptionContext: context,
          Plaintext: Buffer.from(JSON.stringify(tokens)),
        }),
      );
      if (!encrypted.CiphertextBlob?.length)
        throw new Error("Garmin credential encryption unavailable");
      const encryptedTokens = Buffer.from(encrypted.CiphertextBlob).toString(
        "base64",
      );
      const expiresAt = Math.floor(Date.now() / 1000) + renewed.expires_in;
      await dependencies.update(
        new UpdateItemCommand({
          TableName: table,
          Key: key,
          UpdateExpression: "SET encryptedTokens = :next, expiresAt = :expiry",
          ConditionExpression:
            "encryptedTokens = :previous AND #status = :active",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: marshall({
            ":next": encryptedTokens,
            ":expiry": expiresAt,
            ":previous": connection.encryptedTokens,
            ":active": "ACTIVE",
          }),
        }),
      );
      connection = { ...connection, encryptedTokens, expiresAt };
      refreshed = true;
    };
    if (connection.expiresAt < Date.now() / 1000 + 600) await refresh();
    let profile;
    try {
      profile = await fetchGarminProfile(tokens.accessToken, request);
    } catch (error) {
      if (!(error instanceof GarminApiError) || error.status !== 401)
        throw error;
      await refresh();
      try {
        profile = await fetchGarminProfile(tokens.accessToken, request);
      } catch (retried) {
        if (retried instanceof GarminApiError && retried.status === 401)
          throw new GarminRevokedError();
        throw retried;
      }
    }
    if (profile.userId !== connection.athleteId)
      throw new Error("Garmin account identity mismatch");
    await dependencies.update(
      new UpdateItemCommand({
        TableName: table,
        Key: key,
        UpdateExpression: profile.permissions.length
          ? "SET scopes = :permissions, permissionsCheckedAt = :now"
          : "SET permissionsCheckedAt = :now REMOVE scopes",
        ConditionExpression:
          "encryptedTokens = :previous AND #status = :active",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: marshall({
          ":previous": connection.encryptedTokens,
          ":active": "ACTIVE",
          ":now": new Date().toISOString(),
          ...(profile.permissions.length
            ? { ":permissions": new Set(profile.permissions) }
            : {}),
        }),
      }),
    );
    return { ...connection, scopes: profile.permissions };
  };
}
