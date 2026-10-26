import "server-only";
import { createCipheriv, createECDH, createHash, createPrivateKey, hkdfSync, randomBytes, randomUUID, sign } from "node:crypto";
import { ConditionalCheckFailedException, DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, TransactWriteItemsCommand, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { z } from "zod";
import { authSettings } from "@/lib/server-config";

function validEndpoint(value: string) {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash && (
    url.hostname === "fcm.googleapis.com" ||
    url.hostname === "updates.push.services.mozilla.com" ||
    url.hostname.endsWith(".push.services.mozilla.com") ||
    url.hostname === "web.push.apple.com"
  );
}

export const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2048).refine(validEndpoint),
  expirationTime: z.number().finite().nonnegative().nullable().optional(),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}={0,2}$/).refine((value) => {
      try {
        const curve = createECDH("prime256v1");
        curve.generateKeys();
        curve.computeSecret(Buffer.from(value, "base64url"));
        return true;
      } catch { return false; }
    }),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}={0,2}$/),
  }),
});

type Subscription = z.infer<typeof subscriptionSchema>;

export const privateHeaders = { "cache-control": "private, no-store", vary: "Cookie" };

export function pushConfiguration() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) throw new Error("Push is not configured");
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject)) throw new Error("Invalid VAPID subject");
  const curve = createECDH("prime256v1");
  curve.setPrivateKey(Buffer.from(privateKey, "base64url"));
  const publicBytes = curve.getPublicKey();
  if (publicBytes.toString("base64url") !== publicKey) throw new Error("Invalid VAPID key pair");
  const key = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC", crv: "P-256", d: privateKey,
      x: publicBytes.subarray(1, 33).toString("base64url"),
      y: publicBytes.subarray(33).toString("base64url"),
    },
  });
  return { publicKey, key, subject };
}

function database() {
  const settings = authSettings();
  if (!settings) throw new Error("Authentication is not configured");
  const options = {
    region: settings.AWS_REGION, maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 },
  };
  return {
    client: new DynamoDBClient(options), kms: new KMSClient(options),
    table: settings.DYNAMODB_TABLE_NAME, key: settings.DYNAMODB_KMS_KEY_ARN,
  };
}

export function subscriptionId(endpoint: string) {
  return createHash("sha256").update(endpoint).digest("hex");
}

export async function saveSubscription(userId: string, subscription: Subscription) {
  const { client, kms, table, key } = database();
  const plaintext = Buffer.from(JSON.stringify(subscription));
  if (plaintext.length > 4096) throw new Error("Subscription is too large");
  const encrypted = await kms.send(new EncryptCommand({
    KeyId: key, Plaintext: plaintext, EncryptionContext: { userId, purpose: "WEB_PUSH" },
  }));
  if (!encrypted.CiphertextBlob) throw new Error("Subscription encryption failed");
  const id = subscriptionId(subscription.endpoint);
  await client.send(new TransactWriteItemsCommand({ TransactItems: [
    { Put: { TableName: table, Item: {
      PK: { S: `USER#${userId}` }, SK: { S: `PUSH#${subscriptionId(subscription.endpoint)}` },
      entityType: { S: "PUSH_SUBSCRIPTION" },
      encryptedSubscription: { B: encrypted.CiphertextBlob },
      updatedAt: { S: new Date().toISOString() },
    } } },
    { Put: { TableName: table, Item: {
      PK: { S: `PUSH_ENDPOINT#${id}` }, SK: { S: "OWNER" },
      entityType: { S: "PUSH_OWNER" }, userId: { S: userId },
    } } },
  ] }));
}

export async function removeSubscription(userId: string, id: string) {
  const { client, table } = database();
  await client.send(new DeleteItemCommand({
    TableName: table, Key: { PK: { S: `USER#${userId}` }, SK: { S: `PUSH#${id}` } },
  }));
}

async function sendNotification(subscription: Subscription, payload: string) {
  const vapid = pushConfiguration();
  const endpoint = new URL(subscription.endpoint);
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    aud: endpoint.origin, exp: Math.floor(Date.now() / 1000) + 3600, sub: vapid.subject,
  })).toString("base64url");
  const unsigned = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: vapid.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const curve = createECDH("prime256v1");
  const serverPublic = curve.generateKeys();
  const clientPublic = Buffer.from(subscription.keys.p256dh, "base64url");
  const shared = curve.computeSecret(clientPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), clientPublic, serverPublic]);
  const material = hkdfSync("sha256", shared, Buffer.from(subscription.keys.auth, "base64url"), info, 32);
  const salt = randomBytes(16);
  const contentKey = hkdfSync("sha256", material, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdfSync("sha256", material, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", Buffer.from(contentKey), Buffer.from(nonce));
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  if (plaintext.length + 16 > 4096) throw new Error("Push payload is too large");
  const recordHeader = Buffer.alloc(5);
  recordHeader.writeUInt32BE(4096, 0);
  recordHeader[4] = serverPublic.length;
  const body = Buffer.concat([salt, recordHeader, serverPublic, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const response = await fetch(subscription.endpoint, {
    method: "POST", body, redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `vapid t=${unsigned}.${signature}, k=${vapid.publicKey}`,
      "content-encoding": "aes128gcm", "content-type": "application/octet-stream", TTL: "86400", Urgency: "normal",
    },
  });
  await response.body?.cancel();
  return response.status;
}

async function debriefSession(userId: string, workoutId: string, title: string) {
  const { client, table } = database();
  const key = { PK: { S: `USER#${userId}` }, SK: { S: `PUSH_DEBRIEF#${workoutId}` } };
  const existing = await client.send(new GetItemCommand({ TableName: table, Key: key, ConsistentRead: true }));
  if (existing.Item?.sessionId?.S) return existing.Item.sessionId.S;
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  try {
    await client.send(new TransactWriteItemsCommand({ TransactItems: [
      { Put: { TableName: table, Item: { ...key, sessionId: { S: sessionId }, entityType: { S: "PUSH_DEBRIEF" } }, ConditionExpression: "attribute_not_exists(PK)" } },
      { Put: { TableName: table, Item: {
        PK: key.PK, SK: { S: `CHAT#${sessionId}` }, entityType: { S: "CHAT_SESSION" },
        sessionId: { S: sessionId }, title: { S: `Odprawa: ${title}`.slice(0, 120) },
        createdAt: { S: now }, updatedAt: { S: now }, messageCount: { N: "0" },
      }, ConditionExpression: "attribute_not_exists(PK)" } },
    ] }));
    return sessionId;
  } catch (error) {
    if (!(error instanceof TransactionCanceledException)) throw error;
    const winner = await client.send(new GetItemCommand({ TableName: table, Key: key, ConsistentRead: true }));
    if (!winner.Item?.sessionId?.S) throw error;
    return winner.Item.sessionId.S;
  }
}

export async function notifyWorkout(userId: string, provider: "strava" | "garmin", activityId: string) {
  const { client, kms, table, key } = database();
  const workoutId = `${provider.toUpperCase()}#${activityId}`;
  const workout = await client.send(new GetItemCommand({
    TableName: table, Key: { PK: { S: `USER#${userId}` }, SK: { S: `ACTIVITY#${workoutId}` } }, ConsistentRead: true,
  }));
  if (workout.Item?.entityType?.S !== "WORKOUT" || workout.Item.status?.S !== "ACTIVE" || workout.Item.source?.S !== "WEBHOOK")
    return { sent: 0, failed: 0 };
  let cursor: Record<string, import("@aws-sdk/client-dynamodb").AttributeValue> | undefined;
  let sessionId: string | undefined;
  let sent = 0;
  let failed = 0;
  do {
    const subscriptions = await client.send(new QueryCommand({
      TableName: table, KeyConditionExpression: "PK = :user AND begins_with(SK, :push)",
      ExpressionAttributeValues: { ":user": { S: `USER#${userId}` }, ":push": { S: "PUSH#" } },
      ConsistentRead: true, ExclusiveStartKey: cursor,
    }));
    for (const item of subscriptions.Items ?? []) {
      if (!item.SK?.S || !item.encryptedSubscription?.B) continue;
      const owner = await client.send(new GetItemCommand({
        TableName: table, Key: { PK: { S: `PUSH_ENDPOINT#${item.SK.S.slice(5)}` }, SK: { S: "OWNER" } }, ConsistentRead: true,
      }));
      if (owner.Item?.userId?.S !== userId) continue;
      const receipt = { PK: { S: `USER#${userId}` }, SK: { S: `PUSH_SENT#${workoutId}#${item.SK.S.slice(5)}` } };
      const delivered = await client.send(new GetItemCommand({ TableName: table, Key: receipt, ConsistentRead: true }));
      if (delivered.Item) continue;
      try {
        const decrypted = await kms.send(new DecryptCommand({ KeyId: key,
          CiphertextBlob: item.encryptedSubscription.B, EncryptionContext: { userId, purpose: "WEB_PUSH" },
        }));
        if (!decrypted.Plaintext) throw new Error("Subscription decryption failed");
        const subscription = subscriptionSchema.parse(JSON.parse(Buffer.from(decrypted.Plaintext).toString("utf8")));
        if (subscription.expirationTime && subscription.expirationTime <= Date.now()) {
          await removeSubscription(userId, item.SK.S.slice(5));
          continue;
        }
        sessionId ??= await debriefSession(userId, workoutId, workout.Item.name?.S ?? "Trening");
        const status = await sendNotification(subscription, JSON.stringify({
          title: "Czas na odprawe", body: "Twoj trening jest gotowy do omowienia z trenerem.",
          url: `/chat?sessionId=${sessionId}`, tag: `debrief-${sessionId}`,
        }));
        if (status === 404 || status === 410) {
          await removeSubscription(userId, item.SK.S.slice(5));
        } else if (status >= 200 && status < 300) {
          try {
            await client.send(new PutItemCommand({ TableName: table, Item: { ...receipt, entityType: { S: "PUSH_DELIVERY" } }, ConditionExpression: "attribute_not_exists(PK)" }));
          } catch (error) {
            if (!(error instanceof ConditionalCheckFailedException)) throw error;
          }
          sent += 1;
        } else failed += 1;
      } catch (error) {
        failed += 1;
        console.error("push_delivery_failed", { type: error instanceof Error ? error.name : "UnknownError" });
      }
    }
    cursor = subscriptions.LastEvaluatedKey;
  } while (cursor);
  return { sent, failed, sessionId };
}