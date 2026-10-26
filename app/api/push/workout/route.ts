import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { userIdSchema } from "@/backend/auth/identity";
import { activityProvider } from "@/backend/providers/policy";
import { authStore } from "@/lib/auth-store";
import { notifyWorkout, privateHeaders, pushConfiguration } from "../service";

export const runtime = "nodejs";

const requestSchema = z.object({
  userId: userIdSchema, provider: z.enum(["strava", "garmin"]),
  activityId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});

export async function POST(request: Request) {
  const secret = process.env.WEB_PUSH_TRIGGER_SECRET;
  if (!secret || secret.length < 32)
    return Response.json({ error: "push_not_configured" }, { status: 503, headers: privateHeaders });
  const supplied = request.headers.get("authorization") ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(supplied), digest(`Bearer ${secret}`)))
    return Response.json({ error: "unauthorized" }, { status: 401, headers: privateHeaders });
  let payload: unknown;
  try {
    const body = await request.text();
    if (body.length > 2048) return Response.json({ error: "request_too_large" }, { status: 413, headers: privateHeaders });
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: privateHeaders });
  }
  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400, headers: privateHeaders });
  try {
    pushConfiguration();
    const { userId, provider, activityId } = parsed.data;
    const store = authStore();
    const [strava, garmin] = await Promise.all([store.connection(userId), store.connection(userId, "garmin")]);
    if (activityProvider({ strava, garmin }) !== provider)
      return Response.json({ sent: 0, failed: 0 }, { headers: privateHeaders });
    const result = await notifyWorkout(userId, provider, activityId);
    return Response.json(result, { status: result.failed ? 503 : 200, headers: privateHeaders });
  } catch (error) {
    console.error("workout_push_failed", { type: error instanceof Error ? error.name : "UnknownError" });
    return Response.json({ error: "push_unavailable" }, { status: 503, headers: privateHeaders });
  }
}