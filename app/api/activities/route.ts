import { DynamoDBClient, DynamoDBServiceException } from "@aws-sdk/client-dynamodb";
import { z } from "zod";
import { auth } from "@/auth";
import { activityTypeSchema, type ActivitiesPage } from "@/backend/workouts/activities";
import { createActivityStore, InvalidActivityCursorError } from "@/backend/workouts/activity-store";
import { authSettings } from "@/lib/server-config";
import { workoutProvider } from "@/lib/workouts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: activityTypeSchema.default("all"),
  cursor: z.string().min(1).max(8192).optional(),
});
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  let stage = "authentication";
  try {
    const session = await auth();
    if (!session?.user.id) return Response.json({ error: "Zaloguj sie, aby odczytac treningi." }, { status: 401, headers });
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return Response.json({ error: "Nieprawidlowe parametry stronicowania." }, { status: 400, headers });
    if (query.data.page !== 1 && !query.data.cursor) {
      return Response.json({ error: "Kolejna strona wymaga kursora z poprzedniej odpowiedzi." }, { status: 400, headers });
    }
    const settings = authSettings();
    if (!settings) return Response.json({ error: "Odczyt treningow jest niedostepny." }, { status: 503, headers });
    stage = "provider";
    const provider = await workoutProvider();
    if (!provider) {
      return Response.json({ activities: [], page: query.data.page, limit: query.data.limit, nextCursor: null } satisfies ActivitiesPage, { headers });
    }
    const client = new DynamoDBClient({ region: settings.AWS_REGION, maxAttempts: 2,
      requestHandler: { connectionTimeout: 1000, requestTimeout: 5000 } });
    const store = createActivityStore({
      query: async (command) => {
        stage = "activities_query";
        const result = await client.send(command);
        stage = "activities_processing";
        return result;
      },
      batchGet: async (command) => {
        stage = "activities_batch_get";
        const result = await client.send(command);
        stage = "activities_processing";
        return result;
      },
    }, settings.DYNAMODB_TABLE_NAME);
    stage = "activities";
    const result = await store.page({ ...query.data, userId: session.user.id, provider });
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof InvalidActivityCursorError) return Response.json({ error: error.message }, { status: 400, headers });
    console.error("activities_read_failed", {
      stage,
      type: error instanceof Error ? error.name : "UnknownError",
      ...(error instanceof TypeError ? { message: error.message } : {}),
      ...(error instanceof DynamoDBServiceException ? {
        statusCode: error.$metadata.httpStatusCode,
        requestId: error.$metadata.requestId,
      } : {}),
    });
    return Response.json({ error: "Nie mozna pobrac treningow. Sprobuj ponownie." }, { status: 503, headers });
  }
}