import { z } from "zod";
import type { Provider } from "../providers/policy";
import { zoneDistributionSchema } from "./telemetry";

export const workoutSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  entityType: z.literal("WORKOUT"),
  provider: z.enum(["strava", "garmin"]),
  status: z.literal("ACTIVE"),
  activityId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(512),
  sport_type: z.string(),
  start_date: z.string().datetime({ offset: true }),
  distance: z.number().finite().nonnegative(),
  moving_time: z.number().int().nonnegative(),
  elapsed_time: z.number().int().nonnegative(),
  total_elevation_gain: z.number().finite().nonnegative().optional(),
  average_heartrate: z.number().finite().positive().optional(),
  max_heartrate: z.number().finite().positive().optional(),
  average_watts: z.number().finite().nonnegative().optional(),
  max_watts: z.number().finite().nonnegative().optional(),
  heart_rate_zones: zoneDistributionSchema.optional(),
  power_zones: zoneDistributionSchema.optional(),
});

export type Workout = {
  id: string;
  provider: Provider;
  name: string;
  sport: string;
  startedAt: string;
  distance: number;
  movingTime: number;
  elapsedTime: number;
  elevationGain?: number;
  averageHeartRate?: number;
  maximumHeartRate?: number;
  averagePower?: number;
  maximumPower?: number;
  heartRateZones?: z.infer<typeof zoneDistributionSchema>;
  powerZones?: z.infer<typeof zoneDistributionSchema>;
};