import { z } from "zod";
import type { GarminRecord } from "./payload";

export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

export const dailyValuesSchema = z.object({
  restingHeartRate: z.number().positive().max(300).optional(),
  hrvLastNightAverage: z.number().positive().max(1000).optional(),
  hrvLastNightFiveMinuteHigh: z.number().positive().max(1000).optional(),
  sleepDurationSeconds: z.number().int().nonnegative().optional(),
  sleepScore: z.number().min(0).max(100).optional(),
  sleepQualifier: z.string().max(100).optional(),
  sleepValidation: z.string().max(100).optional(),
  bodyBattery: z.number().min(0).max(100).optional(),
  bodyBatteryMeasuredAt: z.number().finite().nonnegative().optional(),
  bodyBatteryCharged: z.number().nonnegative().optional(),
  bodyBatteryDrained: z.number().nonnegative().optional(),
});
export type DailyValues = z.infer<typeof dailyValuesSchema>;
const sourceSchema = z.object({
  receivedAt: z.number().finite().nonnegative(),
  coverageEnd: z.number().finite().nonnegative().optional(),
  summaryId: z.string().max(512).optional(),
  values: dailyValuesSchema,
});
export const dailyMetricSchema = z.object({
  date: calendarDateSchema,
  provider: z.literal("garmin"),
  values: dailyValuesSchema.optional(),
  sources: z.record(z.string(), sourceSchema).optional(),
});
export type DailyMetric = z.infer<typeof dailyMetricSchema>;
export type DailyFragment = { date: string; type: string } & z.infer<typeof sourceSchema>;

function numberIn(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}
const object = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function projectDailyMetric(type: string, record: GarminRecord, receivedAt: number): DailyFragment | null {
  if (!["dailies", "sleeps", "hrv", "stressDetails"].includes(type)) return null;
  const parsedDate = calendarDateSchema.safeParse(record.calendarDate);
  if (!parsedDate.success) return null;
  const values: DailyValues = {};
  if (type === "dailies") {
    values.restingHeartRate = numberIn(record.restingHeartRateInBeatsPerMinute, 1, 300);
    values.bodyBatteryCharged = numberIn(record.bodyBatteryChargedValue, 0);
    values.bodyBatteryDrained = numberIn(record.bodyBatteryDrainedValue, 0);
  }
  if (type === "hrv") {
    values.hrvLastNightAverage = numberIn(record.lastNightAvg, 1, 1000);
    values.hrvLastNightFiveMinuteHigh = numberIn(record.lastNight5MinHigh, 1, 1000);
  }
  if (type === "sleeps") {
    const score = object(record.overallSleepScore);
    const duration = numberIn(record.durationInSeconds, 0);
    values.sleepDurationSeconds = duration !== undefined && Number.isInteger(duration) ? duration : undefined;
    values.sleepScore = numberIn(score?.value, 0, 100);
    values.sleepQualifier = typeof score?.qualifier === "string" && score.qualifier.length <= 100 ? score.qualifier : undefined;
    values.sleepValidation = typeof record.validation === "string" && record.validation.length <= 100 ? record.validation : undefined;
  }
  if (type === "stressDetails") {
    const start = numberIn(record.startTimeInSeconds, 0);
    const samples = Object.entries(object(record.timeOffsetBodyBatteryValues) ?? {})
      .filter(([offset, value]) => /^\d+(\.\d+)?$/.test(offset) && Number.isFinite(Number(offset)) && numberIn(value, 0, 100) !== undefined)
      .sort(([left], [right]) => Number(right) - Number(left));
    const latest = samples[0];
    if (latest && start !== undefined) {
      values.bodyBattery = latest[1] as number;
      values.bodyBatteryMeasuredAt = start + Number(latest[0]);
    }
  }
  const defined = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
  if (!Object.keys(defined).length) return null;
  const start = numberIn(record.startTimeInSeconds, 0);
  const duration = numberIn(record.durationInSeconds, 0);
  return { date: parsedDate.data, type, receivedAt,
    ...(start !== undefined && duration !== undefined ? { coverageEnd: start + duration } : {}),
    ...(record.summaryId ? { summaryId: record.summaryId } : {}), values: dailyValuesSchema.parse(defined),
  };
}

export function mergeDailyMetric(current: DailyMetric | null, fragment: DailyFragment): DailyMetric | null {
  const previous = current ? dailyMetricSchema.parse(current) : null;
  if (previous && previous.date !== fragment.date) throw new Error("Daily metric date mismatch");
  const existing = previous?.sources?.[fragment.type];
  if (existing && ((existing.coverageEnd !== undefined && fragment.coverageEnd !== undefined && existing.coverageEnd > fragment.coverageEnd) || existing.receivedAt > fragment.receivedAt)) return previous;
  const sources = { ...previous?.sources, [fragment.type]: {
    receivedAt: fragment.receivedAt, coverageEnd: fragment.coverageEnd, summaryId: fragment.summaryId,
    values: { ...existing?.values, ...fragment.values },
  } };
  const values = Object.assign({}, sources.import?.values ?? {},
    ...Object.entries(sources).filter(([type]) => type !== "import").map(([, source]) => source.values)) as DailyValues;
  return dailyMetricSchema.parse({ date: fragment.date, provider: "garmin", sources, values });
}