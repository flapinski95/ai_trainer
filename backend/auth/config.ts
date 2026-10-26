import { z } from "zod";

const base = z.object({
  AUTH_URL: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname))
      );
    }),
  AUTH_SECRET: z.string().min(32),
  AWS_REGION: z.string().min(1),
  DYNAMODB_TABLE_NAME: z.string().min(1),
  DYNAMODB_KMS_KEY_ARN: z
    .string()
    .regex(/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/.+$/),
});
const strava = z.object({
  AUTH_STRAVA_ID: z.string().regex(/^[1-9]\d*$/),
  AUTH_STRAVA_SECRET: z.string().min(1),
});
const garmin = z.object({
  AUTH_GARMIN_ID: z.string().min(1).max(128),
  AUTH_GARMIN_SECRET: z.string().min(1),
});

export function parseAuthSettings(environment: Record<string, unknown>) {
  const parsed = base.safeParse(environment);
  if (!parsed.success) return null;
  const stravaSettings = strava.safeParse(environment);
  const garminSettings = garmin.safeParse(environment);
  return {
    ...parsed.data,
    strava: stravaSettings.success ? stravaSettings.data : null,
    garmin: garminSettings.success ? garminSettings.data : null,
  };
}
