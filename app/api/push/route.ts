import { z } from "zod";
import { auth } from "@/auth";
import { privateHeaders, pushConfiguration, removeSubscription, saveSubscription, subscriptionId, subscriptionSchema } from "./service";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user.id) return Response.json({ error: "authentication_required" }, { status: 401, headers: privateHeaders });
  try {
    return Response.json({ publicKey: pushConfiguration().publicKey }, { headers: privateHeaders });
  } catch {
    return Response.json({ error: "push_not_configured" }, { status: 503, headers: privateHeaders });
  }
}

async function updateSubscription(request: Request, remove: boolean) {
  const session = await auth();
  if (!session?.user.id) return Response.json({ error: "authentication_required" }, { status: 401, headers: privateHeaders });
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return Response.json({ error: "invalid_origin" }, { status: 403, headers: privateHeaders });
  let payload: unknown;
  try {
    const body = await request.text();
    if (body.length > 8192) return Response.json({ error: "request_too_large" }, { status: 413, headers: privateHeaders });
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: privateHeaders });
  }
  const parsed = (remove ? z.object({ endpoint: subscriptionSchema.shape.endpoint }) : subscriptionSchema).safeParse(payload);
  if (!parsed.success) return Response.json({ error: "invalid_subscription" }, { status: 400, headers: privateHeaders });
  try {
    if (remove) await removeSubscription(session.user.id, subscriptionId(parsed.data.endpoint));
    else {
      pushConfiguration();
      await saveSubscription(session.user.id, subscriptionSchema.parse(parsed.data));
    }
    return new Response(null, { status: 204, headers: privateHeaders });
  } catch (error) {
    console.error("push_subscription_failed", { type: error instanceof Error ? error.name : "UnknownError" });
    return Response.json({ error: "push_unavailable" }, { status: 503, headers: privateHeaders });
  }
}

export async function POST(request: Request) { return updateSubscription(request, false); }
export async function DELETE(request: Request) { return updateSubscription(request, true); }