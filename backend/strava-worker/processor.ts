import { z } from "zod";
import { type StravaEvent } from "../strava-webhook/events";

const identifier = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const activitySchema = z.object({
  id: identifier,
  athlete: z.object({ id: identifier }),
  name: z.string().min(1).max(512),
  sport_type: z.string().min(1).max(100),
  start_date: z.string().datetime({ offset: true }),
  distance: z.number().nonnegative().finite(),
  moving_time: z.number().int().nonnegative(),
  elapsed_time: z.number().int().nonnegative(),
  total_elevation_gain: z
    .number()
    .nonnegative()
    .finite()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  average_heartrate: z
    .number()
    .positive()
    .finite()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  max_heartrate: z
    .number()
    .positive()
    .finite()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  average_watts: z
    .number()
    .nonnegative()
    .finite()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
});

export type Activity = z.infer<typeof activitySchema>;
export type Connection = {
  userId: string;
  athleteId: string;
  active: boolean;
  scopes: string[];
  encryptedTokens: string;
  expiresAt: number;
  authorizedAt: string;
};
export type Tokens = { accessToken: string; refreshToken: string };
export type Outcome = "PROCESSED" | "IGNORED";

export class StravaRequestError extends Error {
  constructor(public readonly status: number) {
    super(`Strava request failed (${status})`);
    this.name = "StravaRequestError";
  }
}

export type WorkerDependencies = {
  completed: (event: StravaEvent) => Promise<boolean>;
  connection: (athleteId: number) => Promise<Connection | null>;
  decrypt: (connection: Connection) => Promise<Tokens>;
  refresh: (refreshToken: string) => Promise<Tokens & { expiresAt: number }>;
  saveTokens: (
    connection: Connection,
    tokens: Tokens & { expiresAt: number },
  ) => Promise<Connection>;
  fetchActivity: (activityId: number, accessToken: string) => Promise<unknown>;
  fetchAthlete: (accessToken: string) => Promise<unknown>;
  saveActivity: (
    event: StravaEvent,
    connection: Connection,
    activity: Activity,
  ) => Promise<void>;
  removeActivity: (event: StravaEvent, connection: Connection) => Promise<void>;
  revoke: (event: StravaEvent, connection: Connection) => Promise<void>;
  finish: (event: StravaEvent, outcome: Outcome) => Promise<void>;
  now?: () => number;
};

export function createProcessor(dependencies: WorkerDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (event: StravaEvent): Promise<void> => {
    if (event.event_time > Math.floor(now() / 1000) + 300)
      throw new Error("Event timestamp is in the future");
    if (await dependencies.completed(event)) return;
    let connection = await dependencies.connection(event.owner_id);
    if (!connection) throw new Error("Strava connection is not available yet");
    if (connection.athleteId !== String(event.owner_id))
      throw new Error("Strava identity mismatch");

    if (
      event.object_type === "athlete" &&
      event.event_time < Math.floor(Date.parse(connection.authorizedAt) / 1000)
    ) {
      await dependencies.finish(event, "IGNORED");
      return;
    }

    if (
      !connection.active ||
      !connection.scopes.some(
        (scope) => scope === "activity:read" || scope === "activity:read_all",
      )
    ) {
      await dependencies.finish(event, "IGNORED");
      return;
    }

    let tokens = await dependencies.decrypt(connection);
    let refreshed = false;
    const refresh = async () => {
      if (refreshed) throw new StravaRequestError(401);
      const updated = await dependencies.refresh(tokens.refreshToken);
      connection = await dependencies.saveTokens(connection!, updated);
      tokens = updated;
      refreshed = true;
    };

    try {
      if (connection.expiresAt <= Math.floor(now() / 1000) + 60)
        await refresh();
      const request = () =>
        event.object_type === "athlete"
          ? dependencies.fetchAthlete(tokens.accessToken)
          : dependencies.fetchActivity(event.object_id, tokens.accessToken);
      let payload: unknown;
      try {
        payload = await request();
      } catch (error) {
        if (!(error instanceof StravaRequestError) || error.status !== 401)
          throw error;
        await refresh();
        payload = await request();
      }
      if (event.object_type === "athlete") {
        const athlete = z.object({ id: identifier }).parse(payload);
        if (athlete.id !== event.owner_id)
          throw new Error("Strava athlete ownership mismatch");
        await dependencies.finish(event, "IGNORED");
        return;
      }
      const activity = activitySchema.parse(payload);
      if (
        activity.id !== event.object_id ||
        activity.athlete.id !== event.owner_id
      ) {
        throw new Error("Strava activity ownership mismatch");
      }
      await dependencies.saveActivity(event, connection, activity);
      await dependencies.finish(event, "PROCESSED");
    } catch (error) {
      if (
        error instanceof StravaRequestError &&
        [400, 401].includes(error.status)
      ) {
        await dependencies.revoke(event, connection);
        await dependencies.finish(event, "IGNORED");
        return;
      }
      if (
        event.object_type === "activity" &&
        error instanceof StravaRequestError &&
        [403, 404].includes(error.status)
      ) {
        await dependencies.removeActivity(event, connection);
        await dependencies.finish(event, "PROCESSED");
        return;
      }
      throw error;
    }
  };
}
