import { z } from "zod";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { auth } from "@/auth";
import { chatStore } from "@/lib/chat-store";

const requestSchema = z.object({ title: z.string().trim().min(1).max(120) });
const archiveSchema = z.object({ sessionId: z.string().uuid(), archived: z.boolean() });
const privateHeaders = { "cache-control": "private, no-store", vary: "Cookie" };

export async function PATCH(request: Request) {
  const session = await auth();
  if (!session?.user.id)
    return Response.json({ error: "authentication_required" }, { status: 401, headers: privateHeaders });
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: privateHeaders });
  }
  const parsed = archiveSchema.safeParse(payload);
  if (!parsed.success)
    return Response.json({ error: "invalid_request" }, { status: 400, headers: privateHeaders });
  try {
    const result = await chatStore().setSessionArchived(session.user.id, parsed.data.sessionId, parsed.data.archived);
    return Response.json(result, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof TransactionCanceledException && error.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed"))
      return Response.json({ error: "session_not_found" }, { status: 404, headers: privateHeaders });
    console.error("chat_archive_failed", { type: error instanceof Error ? error.name : "UnknownError" });
    return Response.json({ error: "chat_unavailable" }, { status: 503, headers: privateHeaders });
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user.id)
    return Response.json(
      { error: "authentication_required" },
      { status: 401, headers: privateHeaders },
    );
  try {
    const body = await request.json();
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success)
      return Response.json(
        { error: "invalid_request" },
        { status: 400, headers: privateHeaders },
      );
    const created = await chatStore().createSession(
      session.user.id,
      parsed.data.title,
    );
    return Response.json(created, { headers: privateHeaders });
  } catch (error) {
    console.error("chat_session_create_failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return Response.json(
      { error: "chat_unavailable" },
      { status: 503, headers: privateHeaders },
    );
  }
}