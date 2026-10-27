import { createHash, timingSafeEqual } from "node:crypto";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import {
  categorySchema,
  payloadSchema,
  garminHash,
  type GarminCategory,
  type GarminRecord,
} from "./payload";
import { createArtifactStore } from "./artifacts";
import { createEnvelopeEncryption } from "./encryption";

const callbackCategories = new Map<string, GarminCategory>([
  ["POST /api/webhooks/garmin/dailies/{token}", "health"],
  ["POST /api/webhooks/garmin/sleeps/{token}", "health"],
  ["POST /api/webhooks/garmin/activities/{token}", "activity"],
]);

function isEmptySummaryPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summaries = Object.values(value as Record<string, unknown>);
  return summaries.length === 0 || summaries.every((records) => Array.isArray(records) && records.length === 0);
}

export function createGarminIngress(
  store: (category: GarminCategory, body: unknown) => Promise<void>,
  expectedToken: string | undefined,
) {
  return async (
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    const respond = (statusCode: number) => ({
      statusCode,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify({
        status: statusCode === 200 ? "received" : "rejected",
      }),
    });
    if (!expectedToken || expectedToken.length < 43) return respond(503);
    const callbackCategory = callbackCategories.get(event.routeKey);
    const digest = (token: string) =>
      createHash("sha256").update(token).digest();
    if (
      !timingSafeEqual(
        digest((callbackCategory ? event.pathParameters?.token : event.pathParameters?.webhookToken) ?? ""),
        digest(expectedToken),
      )
    )
      return respond(403);
    if (event.requestContext.http.method !== "POST") return respond(405);
    const category = categorySchema.safeParse(callbackCategory ?? event.pathParameters?.category);
    if (!category.success) return respond(404);
    const rawBody = event.body ?? "";
    if (Buffer.byteLength(rawBody) > (event.isBase64Encoded ? 2800000 : 2 * 1024 * 1024)) return respond(413);
    const text = event.isBase64Encoded
      ? Buffer.from(rawBody, "base64").toString("utf8")
      : rawBody;
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) return respond(413);
    if (!text.trim()) {
      console.info("[GARMIN WEBHOOK] empty_ping", { category: category.data });
      return respond(200);
    }
    if (event.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") return respond(415);
    let body: Record<string, GarminRecord[]>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isEmptySummaryPayload(parsed)) {
        console.info("[GARMIN WEBHOOK] empty_ping", { category: category.data });
        return respond(200);
      }
      body = payloadSchema.parse(parsed);
    } catch {
      return respond(400);
    }
    const summaries = Object.entries(body).map(([type, records]) => ({
      type,
      count: records.length,
    }));
    console.info("[GARMIN WEBHOOK] received", {
      category: category.data,
      summaries,
    });
    try {
      await store(category.data, body);
      console.info("[GARMIN WEBHOOK] persisted", {
        category: category.data,
        summaries,
      });
      return respond(200);
    } catch {
      console.error("garmin_push_persistence_failed");
      return respond(503);
    }
  };
}

const dynamodb = new DynamoDBClient({
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 1000, requestTimeout: 5000 },
});
const kms = new KMSClient({ maxAttempts: 2 });
export async function handler(event: APIGatewayProxyEventV2) {
  const table = process.env.DYNAMODB_TABLE_NAME;
  const key = process.env.DYNAMODB_KMS_KEY_ARN;
  if (!table || !key) return { statusCode: 503, body: "Unavailable" };
  const artifacts = createArtifactStore(
    {
      get: (command) => dynamodb.send(command),
      query: (command) => dynamodb.send(command),
      transact: (command) => dynamodb.send(command),
    },
    table,
  );
  const encryption = createEnvelopeEncryption(
    {
      generate: (command) => kms.send(command),
      decrypt: (command) => kms.send(command),
    },
    key,
  );
  return createGarminIngress(async (category, body) => {
    const hash = garminHash({ category, body });
    try {
      await artifacts.put(
        `GARMIN#PUSH#${hash}`,
        "MANIFEST",
        body,
        () => encryption.encrypt(body, { provider: "garmin", purpose: "push" }),
        { entityType: "GARMIN_PUSH", status: "RECEIVED", category, offset: 0 },
        Date.now(),
        Math.floor(Date.now() / 1000) + 7 * 86400,
      );
    } catch (error) {
      if (
        !(error instanceof TransactionCanceledException) ||
        !error.CancellationReasons?.some(
          (reason) => reason.Code === "ConditionalCheckFailed",
        )
      )
        throw error;
    }
  }, process.env.GARMIN_WEBHOOK_SECRET ?? process.env.GARMIN_WEBHOOK_TOKEN)(event);
}
