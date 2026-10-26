import { calendarDateSchema } from "./daily-metrics";
import type { createDailyMetricReader } from "./daily-reader";

type Dependencies = {
  session: () => Promise<{ userId: string } | null>;
  connection: (userId: string) => Promise<{ active: boolean; scopes: string[] } | null>;
  read: ReturnType<typeof createDailyMetricReader>;
  readImported?: ReturnType<typeof createDailyMetricReader>;
};
export function createDailyMetricEndpoint(dependencies: Dependencies) {
  return async (request: Request) => {
    const reply = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "private, no-store", vary: "Cookie" } });
    try {
      const session = await dependencies.session();
      if (!session?.userId) return reply({ error: "Authentication required" }, 401);
      const parameters = new URL(request.url).searchParams;
      if ([...parameters.keys()].some((key) => key !== "date") || parameters.getAll("date").length > 1) return reply({ error: "Invalid query" }, 400);
      const date = parameters.get("date");
      if (date !== null && !calendarDateSchema.safeParse(date).success) return reply({ error: "Invalid calendar date" }, 400);
      const connection = await dependencies.connection(session.userId);
      if (!connection?.active || !connection.scopes.includes("HEALTH_EXPORT")) {
        if (!dependencies.readImported) return reply({ error: "Garmin Health permission required" }, 403);
        const imported = await dependencies.readImported(session.userId, date ?? undefined);
        return imported ? reply(imported, 200) : reply({ error: "No imported daily metric" }, 404);
      }
      const metric = await dependencies.read(session.userId, date ?? undefined);
      return metric ? reply(metric, 200) : reply({ error: "No daily metric received" }, 404);
    } catch (error) {
      console.error("garmin_daily_metric_read_failed", { type: error instanceof Error ? error.name : "UnknownError" });
      return reply({ error: "Daily metrics unavailable" }, 503);
    }
  };
}