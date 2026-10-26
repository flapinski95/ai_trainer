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
} from "./payload";
import { createArtifactStore } from "./artifacts";
import { createEnvelopeEncryption } from "./encryption";

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
    const digest = (token: string) =>
      createHash("sha256").update(token).digest();
    if (
      !timingSafeEqual(
        digest(event.pathParameters?.webhookToken ?? ""),
        digest(expectedToken),
      )
    )
      return respond(403);
    if (event.requestContext.http.method !== "POST") return respond(405);
    const category = categorySchema.safeParse(event.pathParameters?.category);
    if (!category.success) return respond(404);
    if (
      event.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    )
      return respond(415);
    if (
      !event.body ||
      Buffer.byteLength(event.body) >
        (event.isBase64Encoded ? 2800000 : 2 * 1024 * 1024)
    )
      return respond(413);
    let body: unknown;
    try {
      const text = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) return respond(413);
      body = payloadSchema.parse(JSON.parse(text));
    } catch {
      return respond(400);
    }
    try {
      await store(category.data, body);
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
  }, process.env.GARMIN_WEBHOOK_TOKEN)(event);
}
