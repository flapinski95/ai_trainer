import { createHash } from "node:crypto";
import { Decoder, Stream } from "@garmin/fitsdk";
import { unzipSync } from "fflate";
import { workoutMetricsSchema, type WorkoutMetrics } from "../history/model";
import { parseGarminHealthFile, type ImportedDailyMetric } from "./import-health";
import { fitZoneDistribution } from "../workouts/telemetry";

export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 1000;
const MAX_FIT_BYTES = 10 * 1024 * 1024;

export class GarminImportError extends Error {}
export type ImportedWorkout = {
  id: string;
  metrics: WorkoutMetrics;
  fit: Uint8Array;
  sessionIndex: number;
};

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function decodeFit(bytes: Uint8Array): ImportedWorkout[] {
  const decoder = new Decoder(Stream.fromBuffer(Buffer.from(bytes)));
  if (!decoder.isFIT() || !decoder.checkIntegrity())
    throw new GarminImportError("Uszkodzony plik FIT lub nieprawidlowa suma kontrolna.");
  const { messages, errors } = decoder.read({ mergeHeartRates: false,
    mesgListener: (messageNumber, message) => {
      if (![0, 18, 34].includes(messageNumber)) {
        for (const key of Object.keys(message)) delete message[key];
      }
    },
  });
  if (errors.length) throw new GarminImportError("Nie mozna odczytac pliku FIT.");
  if (messages.fileIdMesgs?.[0]?.type !== "activity") return [];
  return (messages.sessionMesgs ?? []).map((session, sessionIndex) => {
    const start = session.startTime;
    if (!(start instanceof Date) || !Number.isFinite(start.getTime()))
      throw new GarminImportError("Brak daty treningu w pliku FIT.");
    const sport = String(session.sport ?? "Workout");
    const elapsed = finite(session.totalElapsedTime);
    const timer = finite(session.totalTimerTime);
    if (elapsed === undefined && timer === undefined)
      throw new GarminImportError("Brak czasu treningu w pliku FIT.");
    const metrics = workoutMetricsSchema.parse({
      name: typeof session.sportProfileName === "string" && session.sportProfileName.trim()
        ? session.sportProfileName.slice(0, 512) : sport === "cycling" ? "Kolarstwo" : sport === "running" ? "Bieganie" : sport,
      sport_type: sport === "cycling" ? "Ride" : sport === "running" ? "Run" : sport,
      start_date: start.toISOString(),
      distance: finite(session.totalDistance) ?? 0,
      moving_time: Math.round(timer ?? elapsed!),
      elapsed_time: Math.round(elapsed ?? timer!),
      total_elevation_gain: finite(session.totalAscent),
      average_heartrate: finite(session.avgHeartRate) || undefined,
      max_heartrate: finite(session.maxHeartRate) || undefined,
      average_watts: finite(session.avgPower),
      max_watts: finite(session.maxPower),
      heart_rate_zones: fitZoneDistribution(session.timeInHrZone),
      power_zones: fitZoneDistribution(session.timeInPowerZone),
      average_speed: finite(session.enhancedAvgSpeed) ?? finite(session.avgSpeed),
      average_cadence: finite(session.avgCadence),
    });
    const id = `fit-${createHash("sha256").update(`${metrics.start_date}:${metrics.sport_type}`).digest("hex").slice(0, 40)}`;
    return { id, metrics, fit: bytes, sessionIndex };
  });
}

export function decodeWorkoutTelemetry(workout: ImportedWorkout) {
  const decoder = new Decoder(Stream.fromBuffer(Buffer.from(workout.fit)));
  const { messages, errors } = decoder.read({ mergeHeartRates: true });
  if (errors.length) throw new GarminImportError("Nie mozna odczytac telemetrii FIT.");
  const session = messages.sessionMesgs?.[workout.sessionIndex];
  if (!session) throw new GarminImportError("Brak sesji w telemetrii FIT.");
  const start = Date.parse(workout.metrics.start_date);
  const end = session.timestamp instanceof Date ? session.timestamp.getTime()
    : start + workout.metrics.elapsed_time * 1000;
  const inSession = (record: Record<string, unknown>) => record.timestamp instanceof Date
    && record.timestamp.getTime() >= start && record.timestamp.getTime() <= end;
  return {
    format: "garmin-fit-v1",
    session,
    records: (messages.recordMesgs ?? []).filter(inSession),
    laps: (messages.lapMesgs ?? []).filter(inSession),
    zones: {
      heartRate: messages.hrZoneMesgs ?? [],
      power: messages.powerZoneMesgs ?? [],
      targets: messages.zonesTargetMesgs ?? [],
      timeInZone: messages.timeInZoneMesgs ?? [],
    },
    messages,
    originalFit: Buffer.from(workout.fit).toString("base64"),
  };
}

export function parseGarminImport(bytes: Uint8Array, filename: string) {
  if (!bytes.length || bytes.length > MAX_IMPORT_BYTES)
    throw new GarminImportError("Maksymalny rozmiar pliku to 25 MB.");
  const workouts = new Map<string, ImportedWorkout>();
  const dailyMetrics = new Map<string, ImportedDailyMetric>();
  let expanded = 0;
  let files = 0;
  let skipped = 0;
  const visit = (data: Uint8Array, name: string, depth: number) => {
    const path = name.replace(/\\/g, "/");
    if (/\.(csv|json)$/i.test(path)) {
      if (depth > 0 && !/(?:^|\/)DI-Connect-(?:User|Wellness)(?:\/|$)/i.test(path)) return;
      const metrics = parseGarminHealthFile(data, path);
      if (!metrics.length) skipped += 1;
      for (const metric of metrics) {
        const previous = dailyMetrics.get(metric.date)?.values;
        const preserveBattery = (previous?.bodyBatteryMeasuredAt ?? -Infinity) > (metric.values.bodyBatteryMeasuredAt ?? -Infinity);
        dailyMetrics.set(metric.date, { date: metric.date, values: {
          ...previous, ...metric.values,
          ...(preserveBattery ? { bodyBattery: previous?.bodyBattery, bodyBatteryMeasuredAt: previous?.bodyBatteryMeasuredAt } : {}),
        } });
      }
      return;
    }
    if (/\.fit$/i.test(name)) {
      if (data.length > MAX_FIT_BYTES) throw new GarminImportError("Plik FIT przekracza 10 MB.");
      const decoded = decodeFit(data);
      if (!decoded.length) skipped += 1;
      for (const workout of decoded) {
        workouts.set(workout.id, workout);
        if (workouts.size > MAX_FILES) throw new GarminImportError("Maksymalnie 1000 treningow w jednym imporcie.");
      }
      return;
    }
    if (!/\.zip$/i.test(name)) return;
    if (depth > 3) throw new GarminImportError("Zbyt wiele poziomow archiwum ZIP.");
    const archive = unzipSync(data, { filter: (entry) => {
      files += 1;
      expanded += entry.originalSize;
      if (files > MAX_FILES || expanded > MAX_EXPANDED_BYTES)
        throw new GarminImportError("Archiwum przekracza limit 1000 plikow lub 100 MB po rozpakowaniu.");
      if (/\.fit$/i.test(entry.name) && entry.originalSize > MAX_FIT_BYTES)
        throw new GarminImportError("Plik FIT przekracza 10 MB.");
      return /\.(fit|zip|csv|json)$/i.test(entry.name);
    } });
    const parent = path.slice(0, path.lastIndexOf("/") + 1);
    for (const [entry, content] of Object.entries(archive)) visit(content, `${parent}${entry}`, depth + 1);
  };
  if (!/\.(zip|fit|csv|json)$/i.test(filename)) throw new GarminImportError("Wybierz plik ZIP, FIT, CSV lub JSON.");
  try {
    visit(bytes, filename, 0);
  } catch (error) {
    if (error instanceof GarminImportError) throw error;
    throw new GarminImportError("Nieprawidlowy plik ZIP/FIT/CSV/JSON. Sprawdz format eksportu Garmin Connect.");
  }
  if (!workouts.size && !dailyMetrics.size) throw new GarminImportError("Nie znaleziono aktywnosci FIT ani rozpoznanych pomiarow zdrowotnych w eksporcie.");
  return { workouts: [...workouts.values()].sort((left, right) => Date.parse(right.metrics.start_date) - Date.parse(left.metrics.start_date)),
    dailyMetrics: [...dailyMetrics.values()].sort((left, right) => right.date.localeCompare(left.date)), skipped };
}