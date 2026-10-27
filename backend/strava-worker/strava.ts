import { z } from "zod";
import { StravaRequestError } from "./processor";
import type { RateGate } from "../history/rate-limit";
import { stravaZoneDistributions } from "../workouts/telemetry";

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export function createStravaClient(
  credentials: () => Promise<{ clientId: string; clientSecret: string }>,
  request: typeof fetch = fetch,
  rate?: RateGate,
) {
  async function read(path: string, accessToken: string) {
    await rate?.before("read");
    const response = await request(`https://www.strava.com/api/v3/${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(6000),
      redirect: "error",
    });
    await rate?.after(response.headers, response.status, "read");
    if (!response.ok) throw new StravaRequestError(response.status);
    return response.json() as Promise<unknown>;
  }

  return {
    fetchActivity: async (id: number, token: string) => {
      const activity = await read(`activities/${id}?include_all_efforts=true`, token);
      if (!activity || typeof activity !== "object") return activity;
      const hasHeartRate = "has_heartrate" in activity && activity.has_heartrate === true;
      const hasPower = "device_watts" in activity && activity.device_watts === true;
      if (!hasHeartRate && !hasPower) return activity;
      try {
        const zones = await read(`activities/${id}/zones`, token);
        return { ...activity, ...stravaZoneDistributions(zones) };
      } catch (error) {
        if (error instanceof StravaRequestError && [402, 403, 404].includes(error.status)) return activity;
        throw error;
      }
    },
    fetchAthlete: (token: string) => read("athlete", token),
    listActivities: (
      token: string,
      after: number,
      before: number,
      page: number,
    ) =>
      read(
        `athlete/activities?${new URLSearchParams({ after: String(after), before: String(before), page: String(page), per_page: "200" })}`,
        token,
      ),
    async refresh(refreshToken: string) {
      const client = await credentials();
      await rate?.before("oauth");
      const response = await request(
        "https://www.strava.com/api/v3/oauth/token",
        {
          method: "POST",
          signal: AbortSignal.timeout(6000),
          redirect: "error",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: client.clientId,
            client_secret: client.clientSecret,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
        },
      );
      await rate?.after(response.headers, response.status, "oauth");
      const payload: unknown = await response.json();
      if (!response.ok) {
        const revoked = z
          .object({
            errors: z.array(
              z.object({ resource: z.string(), code: z.string() }),
            ),
          })
          .safeParse(payload);
        if (
          response.status === 400 &&
          revoked.success &&
          revoked.data.errors.some(
            (error) =>
              error.resource.toLowerCase().replaceAll("_", "") ===
                "refreshtoken" && error.code === "invalid",
          )
        ) {
          throw new StravaRequestError(400);
        }
        if ([400, 401].includes(response.status))
          throw new Error("Strava OAuth client configuration rejected");
        throw new StravaRequestError(response.status);
      }
      const tokens = tokenResponse.parse(payload);
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_at,
      };
    },
  };
}
