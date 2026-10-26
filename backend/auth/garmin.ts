import { z } from "zod";

export const garminOAuth = {
  authorization: "https://connect.garmin.com/oauth2Confirm",
  token: "https://diauth.garmin.com/di-oauth2-service/oauth/token",
  userId: "https://apis.garmin.com/partner-gateway/rest/user/id",
  permissions: "https://apis.garmin.com/partner-gateway/rest/user/permissions",
} as const;

export function garminAuthorizationRedirect(value: string) {
  const url = new URL(value);
  const endpoint = new URL(garminOAuth.authorization);
  if (url.origin === endpoint.origin && url.pathname === endpoint.pathname) url.searchParams.delete("scope");
  return url.toString();
}

export function garminAuthorizationResponse(response: Response) {
  const location = response.headers.get("location");
  if (!location) return response;
  const destination = garminAuthorizationRedirect(location);
  if (destination === location) return response;
  const headers = new Headers(response.headers);
  headers.set("location", destination);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export const garminProfileSchema = z.object({
  userId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  permissions: z.array(z.string().min(1).max(100)).max(100),
});

export class GarminApiError extends Error {
  constructor(public readonly status: number) {
    super(`Garmin API request failed (${status})`);
    this.name = "GarminApiError";
  }
}

export async function fetchGarminProfile(
  accessToken: string,
  request: typeof fetch = fetch,
) {
  const read = async (url: string) => {
    const response = await request(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(6000),
      redirect: "error",
    });
    if (!response.ok) throw new GarminApiError(response.status);
    return response.json() as Promise<unknown>;
  };
  const identity = z
    .object({ userId: z.string() })
    .parse(await read(garminOAuth.userId));
  const permissions = z
    .object({ permissions: z.array(z.string()) })
    .parse(await read(garminOAuth.permissions));
  return garminProfileSchema.parse({ ...identity, ...permissions });
}

export function parseGarminAuthorization(account: unknown, profile: unknown) {
  const credentials = z
    .object({
      provider: z.literal("garmin"),
      providerAccountId: z.string(),
      access_token: z.string().min(1).max(8192),
      refresh_token: z.string().min(1).max(8192),
      expires_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .parse(account);
  const identity = garminProfileSchema.parse(profile);
  if (
    credentials.providerAccountId !== identity.userId ||
    credentials.expires_at <= Date.now() / 1000
  )
    throw new Error("Invalid Garmin authorization");
  return {
    provider: "garmin" as const,
    athleteId: identity.userId,
    name: "Uzytkownik Garmin",
    scopes: identity.permissions,
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token,
    expiresAt: credentials.expires_at,
  };
}
