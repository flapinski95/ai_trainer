import { z } from "zod";
import { garminHash, type GarminRecord } from "./payload";
import { workoutMetricsSchema } from "../history/model";

const summarySchema = z.object({
  startTimeInSeconds: z.number().int().nonnegative(),
  durationInSeconds: z.number().int().nonnegative(),
  activityType: z.string().min(1),
  activityName: z.string().optional(),
  distanceInMeters: z.number().nonnegative().optional(),
  totalElevationGainInMeters: z.number().nonnegative().optional(),
  averageHeartRateInBeatsPerMinute: z.number().positive().optional(),
  maxHeartRateInBeatsPerMinute: z.number().positive().optional(),
});
export function normalizeGarminActivity(record: GarminRecord) {
  const source = record.summary === undefined ? record : record.summary;
  const summary = summarySchema.parse(source);
  const external = record.activityId ?? record.summaryId;
  if (external === undefined)
    throw new Error("Garmin activity identity missing");
  const rawId = String(external);
  const id = /^[A-Za-z0-9_-]{1,128}$/.test(rawId) ? rawId : garminHash(rawId);
  const sport =
    summary.activityType.includes("CYCLING") ||
    summary.activityType.includes("BIKING")
      ? "Ride"
      : summary.activityType.includes("RUNNING")
        ? "Run"
        : summary.activityType;
  return {
    id,
    metrics: workoutMetricsSchema.parse({
      name: summary.activityName?.slice(0, 512) || summary.activityType,
      sport_type: sport,
      start_date: new Date(summary.startTimeInSeconds * 1000).toISOString(),
      distance: summary.distanceInMeters ?? 0,
      moving_time: summary.durationInSeconds,
      elapsed_time: summary.durationInSeconds,
      total_elevation_gain: summary.totalElevationGainInMeters,
      average_heartrate: summary.averageHeartRateInBeatsPerMinute,
      max_heartrate: summary.maxHeartRateInBeatsPerMinute,
    }),
  };
}
