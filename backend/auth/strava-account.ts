import { z } from "zod";

const accountSchema = z.object({
  provider: z.literal("strava"),
  providerAccountId: z.string().regex(/^[1-9]\d*$/),
  access_token: z.string().min(1).max(1024),
  refresh_token: z.string().min(1).max(1024),
  expires_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  scope: z.string().optional(),
});

const profileSchema = z.object({
  id: z
    .union([
      z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      z.string().regex(/^[1-9]\d*$/),
    ])
    .transform(String),
  firstname: z.string().max(100).default(""),
  lastname: z.string().max(100).default(""),
});

export class StravaAuthorizationError extends Error {
  constructor() {
    super("Strava authorization is incomplete");
    this.name = "StravaAuthorizationError";
  }
}

export function parseStravaAuthorization(
  account: unknown,
  profile: unknown,
  callbackScope?: string | null,
) {
  const parsedAccount = accountSchema.safeParse(account);
  const parsedProfile = profileSchema.safeParse(profile);
  if (!parsedAccount.success || !parsedProfile.success)
    throw new StravaAuthorizationError();
  const credentials = parsedAccount.data;
  const athlete = parsedProfile.data;
  const scopes = [
    ...new Set(
      (credentials.scope ?? callbackScope ?? "")
        .split(/[,\s]+/)
        .filter(Boolean),
    ),
  ].sort();
  if (
    credentials.providerAccountId !== athlete.id ||
    credentials.expires_at <= Math.floor(Date.now() / 1000) ||
    !scopes.some(
      (scope) => scope === "activity:read" || scope === "activity:read_all",
    )
  )
    throw new StravaAuthorizationError();

  return {
    userId: `strava-${athlete.id}`,
    athleteId: athlete.id,
    name:
      [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") ||
      "Zawodnik",
    scopes,
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token,
    expiresAt: credentials.expires_at,
  };
}

export type StravaAuthorization = ReturnType<typeof parseStravaAuthorization>;
