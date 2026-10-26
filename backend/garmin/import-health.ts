import { parse } from "csv-parse/sync";
import { calendarDateSchema, dailyValuesSchema, type DailyValues } from "./daily-metrics";

export type ImportedDailyMetric = { date: string; values: DailyValues };
const keyOf = (key: string) => key.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const numeric = (value: unknown): number | undefined => {
  if (typeof value === "string" && /^-?\d+(?:[.,]\d+)?$/.test(value.trim())) value = Number(value.trim().replace(",", "."));
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};
function dateOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    const date = value.trim().slice(0, 10);
    if (calendarDateSchema.safeParse(date).success) return date;
  }
  const number = numeric(value);
  if (number !== undefined && number > 100000000) {
    const date = new Date(number < 100000000000 ? number * 1000 : number);
    if (Number.isFinite(date.getTime())) return date.toISOString().slice(0, 10);
  }
  return undefined;
}

function csvRows(text: string): unknown {
  let delimiter = ",";
  let columns = 0;
  for (const candidate of [",", ";", "\t"]) {
    try {
      const header = parse(text, { bom: true, delimiter: candidate, to: 1, skip_empty_lines: true }) as string[][];
      if ((header[0]?.length ?? 0) > columns) {
        columns = header[0]!.length;
        delimiter = candidate;
      }
    } catch {}
  }
  return parse(text, { columns: true, bom: true, delimiter, skip_empty_lines: true, trim: true, max_record_size: 1024 * 1024 }) as unknown;
}

export function parseGarminHealthFile(bytes: Uint8Array, filename: string): ImportedDailyMetric[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  const content: unknown = /\.csv$/i.test(filename) ? csvRows(text) : JSON.parse(text);
  const days = new Map<string, { values: DailyValues; times: Partial<Record<keyof DailyValues, number>> }>();
  let visited = 0;
  const apply = (date: string | undefined, field: keyof DailyValues, value: unknown, measuredAt: number) => {
    const number = numeric(value);
    if (!date || number === undefined) return;
    const parsed = dailyValuesSchema.safeParse({ [field]: number });
    if (!parsed.success) return;
    const day = days.get(date) ?? { values: {}, times: {} };
    if ((day.times[field] ?? -Infinity) <= measuredAt) {
      Object.assign(day.values, parsed.data);
      day.times[field] = measuredAt;
    }
    days.set(date, day);
  };
  const walk = (value: unknown, inheritedDate: string | undefined, path: string, depth: number) => {
    if (++visited > 1000000 || depth > 32) throw new Error("Health export nesting limit exceeded");
    if (Array.isArray(value)) {
      if (/bodybattery/.test(path) && value.length >= 2 && !object(value[0]) && !Array.isArray(value[0])) {
        const timestamp = numeric(value[0]);
        const battery = numeric(value[1]);
        if (timestamp !== undefined && dateOf(timestamp) && battery !== undefined && battery >= 0 && battery <= 100) {
          const measuredAt = timestamp < 100000000000 ? timestamp * 1000 : timestamp;
          apply(inheritedDate ?? dateOf(timestamp), "bodyBattery", battery, measuredAt);
          apply(inheritedDate ?? dateOf(timestamp), "bodyBatteryMeasuredAt", measuredAt / 1000, measuredAt);
        }
      }
      for (const entry of value) walk(entry, inheritedDate, path, depth + 1);
      return;
    }
    const record = object(value);
    if (!record) return;
    const fields = new Map(Object.entries(record).map(([key, field]) => [keyOf(key), field]));
    const explicitDate = ["calendardate", "calendardatestring", "date", "day", "reportdate", "sleepdate"]
      .map((key) => dateOf(fields.get(key))).find(Boolean);
    const timestampValue = fields.get("timestamp") ?? fields.get("measurementtime") ?? fields.get("starttimeinseconds") ?? fields.get("sleepstarttimestampgmt");
    const date = explicitDate ?? inheritedDate ?? dateOf(timestampValue);
    const timestampNumber = numeric(timestampValue);
    const measuredAt = timestampNumber !== undefined ? timestampNumber < 100000000000 ? timestampNumber * 1000 : timestampNumber
      : typeof timestampValue === "string" && Number.isFinite(Date.parse(timestampValue)) ? Date.parse(timestampValue) : 0;
    for (const [key, raw] of fields) {
      if (["restingheartrate", "restingheartrateinbeatsperminute", "restinghr", "restinghrbpm", "restingheartratebpm"].includes(key))
        apply(date, "restingHeartRate", raw, measuredAt);
      if (["hrvlastnightaverage", "lastnightavg", "lastnightaverage", "nightlyhrv", "hrv", "hrvms"].includes(key))
        apply(date, "hrvLastNightAverage", raw, measuredAt);
      if (["bodybattery", "bodybatterylevel", "bodybatteryvalue", "currentbodybattery", "bodybatterymostrecentvalue"].includes(key)) {
        apply(date, "bodyBattery", raw, measuredAt);
        const battery = numeric(raw);
        if (measuredAt && battery !== undefined && battery >= 0 && battery <= 100) apply(date, "bodyBatteryMeasuredAt", measuredAt / 1000, measuredAt);
      }
      if (["sleepscore", "sleepscorevalue", "overallsleepscore"].includes(key))
        apply(date, "sleepScore", object(raw)?.value ?? raw, measuredAt);
      if (["sleepdurationseconds", "sleeptimeseconds", "totalsleepseconds"].includes(key) || key === "durationinseconds" && /sleep/.test(path))
        apply(date, "sleepDurationSeconds", raw, measuredAt);
      if (["value", "level", "score", "overall", "average"].includes(key)) {
        if (/bodybattery/.test(path)) {
          apply(date, "bodyBattery", raw, measuredAt);
          const battery = numeric(raw);
          if (measuredAt && battery !== undefined && battery >= 0 && battery <= 100) apply(date, "bodyBatteryMeasuredAt", measuredAt / 1000, measuredAt);
        }
        if (/sleep.*(?:score|overall)/.test(path)) apply(date, "sleepScore", raw, measuredAt);
        if (/hrv/.test(path)) apply(date, "hrvLastNightAverage", raw, measuredAt);
        if (/restingheartrate/.test(path)) apply(date, "restingHeartRate", raw, measuredAt);
      }
    }
    for (const [key, child] of Object.entries(record)) walk(child, calendarDateSchema.safeParse(key).success ? key : date, `${path}/${keyOf(key)}`, depth + 1);
  };
  walk(content, undefined, keyOf(filename), 0);
  return [...days].map(([date, day]) => ({ date, values: dailyValuesSchema.parse(day.values) }));
}