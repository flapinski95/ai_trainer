import { z } from "zod";

export const zoneDistributionSchema = z.array(z.object({
  zone: z.number().int().min(1).max(5),
  seconds: z.number().finite().nonnegative(),
})).length(5).refine((zones) => new Set(zones.map((zone) => zone.zone)).size === 5);

export function fitZoneDistribution(value: unknown) {
  const parsed = z.array(z.number().finite().nonnegative()).min(6).safeParse(value);
  return parsed.success
    ? parsed.data.slice(1, 6).map((seconds, index) => ({ zone: index + 1, seconds }))
    : undefined;
}

export function stravaZoneDistributions(value: unknown) {
  const parsed = z.array(z.object({
    type: z.string(),
    sensor_based: z.boolean().optional(),
    distribution_buckets: z.array(z.object({ time: z.number().finite().nonnegative() })),
  })).safeParse(value);
  const distribution = (type: string) => {
    const entry = parsed.success ? parsed.data.find((zone) => zone.type === type && zone.sensor_based !== false) : undefined;
    return entry && entry.distribution_buckets.length >= 5
      ? entry.distribution_buckets.slice(0, 5).map((bucket, index) => ({ zone: index + 1, seconds: bucket.time }))
      : undefined;
  };
  return { heart_rate_zones: distribution("heartrate"), power_zones: distribution("power") };
}