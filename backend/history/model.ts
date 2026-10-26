import { z } from "zod";
import { createHash } from "node:crypto";
import { activitySchema, type Activity } from "../strava-worker/processor";

export const DAY = 86400;
export const PAGE_SIZE = 200;
export const summarySchema = activitySchema.extend({
  has_heartrate: z.boolean().optional(),
  device_watts: z.boolean().optional(),
});
export type ActivitySummary = z.infer<typeof summarySchema>;
export const workoutMetricsSchema = activitySchema.omit({
  id: true,
  athlete: true,
}).extend({
  average_speed: z.number().finite().nonnegative().optional(),
  average_cadence: z.number().finite().nonnegative().optional(),
});
export type WorkoutMetrics = z.infer<typeof workoutMetricsSchema>;

export function normalizeSummary(
  payload: unknown,
  athleteId: string,
): ActivitySummary {
  const parsed = summarySchema.parse(payload);
  if (String(parsed.athlete.id) !== athleteId)
    throw new Error("Activity ownership mismatch");
  return {
    ...parsed,
    name: parsed.name.slice(0, 200),
    start_date: new Date(parsed.start_date).toISOString(),
  };
}

export function isWithinDetailWindow(startDate: string, cutoff: number): boolean {
  return Date.parse(startDate) / 1000 >= cutoff - 90 * DAY;
}

export function needsDetails(
  activity: ActivitySummary,
  cutoff: number,
): boolean {
  return (
    isWithinDetailWindow(activity.start_date, cutoff) &&
    ((activity.has_heartrate === true &&
      activity.average_heartrate === undefined) ||
      (activity.device_watts === true && activity.average_watts === undefined))
  );
}

export function syncWindow(
  now: number,
  lastSuccess?: number,
  scopeExpanded = false,
) {
  const before = Math.floor(now / 1000);
  return {
    before,
    after:
      !scopeExpanded && lastSuccess ? Math.max(0, lastSuccess - 7 * DAY) : 0,
  };
}

export function metrics(activity: WorkoutMetrics) {
  return {
    name: activity.name,
    sport_type: activity.sport_type,
    start_date: new Date(activity.start_date).toISOString(),
    distance: activity.distance,
    moving_time: activity.moving_time,
    elapsed_time: activity.elapsed_time,
    total_elevation_gain: activity.total_elevation_gain,
    average_heartrate: activity.average_heartrate,
    max_heartrate: activity.max_heartrate,
    average_watts: activity.average_watts,
    max_watts: activity.max_watts,
    heart_rate_zones: activity.heart_rate_zones,
    power_zones: activity.power_zones,
    average_speed: activity.average_speed,
    average_cadence: activity.average_cadence,
  };
}

export function fingerprint(activity: WorkoutMetrics): string {
  return createHash("sha256")
    .update(JSON.stringify(metrics(activity)))
    .digest("hex");
}

export function contributions(activity: WorkoutMetrics) {
  const start = new Date(activity.start_date);
  const monday = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const sport = activity.sport_type.includes("Ride")
    ? "CYCLING"
    : activity.sport_type.includes("Run")
      ? "RUNNING"
      : "OTHER";
  const values = {
    count: 1,
    distance: activity.distance,
    movingTime: activity.moving_time,
    elapsedTime: activity.elapsed_time,
    elevation: activity.total_elevation_gain ?? 0,
  };
  return [
    {
      key: `SUMMARY#WEEK#${monday.toISOString().slice(0, 10)}#${sport}`,
      ...values,
    },
    {
      key: `SUMMARY#MONTH#${start.toISOString().slice(0, 7)}#${sport}`,
      ...values,
    },
    { key: `SUMMARY#LIFETIME#${sport}`, ...values },
  ];
}

export type Contribution = ReturnType<typeof contributions>[number];
