import { createHash, timingSafeEqual } from "node:crypto";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { stravaEventSchema, type StravaEvent } from "./events";
import { saveEvent } from "./store";

export function createHandler(
  persist: (event: StravaEvent, tableName: string) => Promise<void> = saveEvent,
) {
  return async (
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    const respond = (statusCode: number, body: Record<string, string>) => ({
      statusCode,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify(body),
    });

    if (event.requestContext.http.method === "POST") {
      const contentType = event.headers["content-type"]
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== "application/json")
        return respond(415, { error: "Expected application/json" });
      if (!event.body) return respond(400, { error: "Missing event body" });
      if (
        Buffer.byteLength(event.body) > (event.isBase64Encoded ? 22000 : 16384)
      ) {
        return respond(413, { error: "Event body too large" });
      }

      let payload: unknown;
      try {
        const body = event.isBase64Encoded
          ? Buffer.from(event.body, "base64").toString("utf8")
          : event.body;
        if (Buffer.byteLength(body) > 16384)
          return respond(413, { error: "Event body too large" });
        payload = JSON.parse(body);
      } catch {
        return respond(400, { error: "Invalid JSON" });
      }

      const parsed = stravaEventSchema.safeParse(payload);
      if (!parsed.success)
        return respond(400, { error: "Invalid Strava event" });

      const tableName = process.env.DYNAMODB_TABLE_NAME;
      const subscriptionId = process.env.STRAVA_SUBSCRIPTION_ID;
      if (
        !tableName ||
        !subscriptionId ||
        !/^[1-9]\d*$/.test(subscriptionId) ||
        !Number.isSafeInteger(Number(subscriptionId))
      ) {
        return respond(503, { error: "Event ingestion unavailable" });
      }
      if (parsed.data.subscription_id !== Number(subscriptionId)) {
        return respond(403, { error: "Unexpected subscription" });
      }

      try {
        await persist(parsed.data, tableName);
        return respond(200, { status: "received" });
      } catch {
        console.error("strava_webhook_persistence_failed");
        return respond(503, { error: "Event persistence unavailable" });
      }
    }

    if (event.requestContext.http.method !== "GET") {
      const response = respond(405, { error: "Method not allowed" });
      return {
        ...response,
        headers: { ...response.headers, allow: "GET, POST" },
      };
    }

    const expectedToken = process.env.STRAVA_VERIFY_TOKEN;
    if (!expectedToken)
      return respond(503, { error: "Webhook verification unavailable" });

    const parameters = new URLSearchParams(event.rawQueryString);
    const mode = parameters.get("hub.mode");
    const challenge = parameters.get("hub.challenge");
    const token = parameters.get("hub.verify_token");

    if (
      ["hub.mode", "hub.challenge", "hub.verify_token"].some(
        (name) => parameters.getAll(name).length !== 1,
      ) ||
      mode !== "subscribe" ||
      !challenge ||
      !token
    ) {
      return respond(400, { error: "Invalid verification request" });
    }

    const digest = (value: string) =>
      createHash("sha256").update(value).digest();
    if (!timingSafeEqual(digest(token), digest(expectedToken))) {
      return respond(403, { error: "Verification failed" });
    }

    return respond(200, { "hub.challenge": challenge });
  };
}

export const handler = createHandler();
