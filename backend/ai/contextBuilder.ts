import "server-only";
import { DynamoDBClient, QueryCommand, type AttributeValue, type GetItemCommand, type QueryCommandOutput } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { createArtifactStore } from "../garmin/artifacts";
import { createDailyMetricReader } from "../garmin/daily-reader";
import { createEnvelopeEncryption } from "../garmin/encryption";
import { authSettings } from "../../lib/server-config";
import { defaultAIDataPreferences, type AIDataPreferences } from "../../lib/ai-data-preferences";
import { activityDiscipline } from "../workouts/activities";
import { athleteMemoryBlock, createAthleteMemoryStore, deriveAthleteMetrics, type AthleteMemory } from "./athlete-memory";
import { athletePhysiologySchema, buildAthleteZones, classifyZone, type AthleteZones } from "../../lib/athlete-zones";
import { zoneDistributionSchema } from "../workouts/telemetry";
import { fetchStravaActivityDetail } from "../strava/detail";

type DataRecord = Record<string, unknown>;
type MetricValue = string | number | boolean | MetricValue[] | { [key: string]: MetricValue };
type Metrics = Record<string, MetricValue>;
type RecoveryDay = { date: string; values: DataRecord };
type Activity = { source: "strava" | "garmin"; timestamp: number; data: DataRecord };
type YearlySummary = {
  total_rides_count: number;
  total_cycling_distance_km: number;
  total_cycling_elevation_m: number;
  total_cycling_duration: number;
  total_runs_count: number;
  total_running_distance_km: number;
  total_running_elevation_m: number;
  total_running_duration: number;
  max_watts_recorded?: number;
  highest_avg_power?: number;
  has_power_meter: boolean;
  best_segments_count: number;
  max_elevation_ride_m?: number;
  max_heart_rate_bpm?: number;
};

const contextByteBudget = 8000;
const activityLimit = 10;
const encoder = new TextEncoder();
const wrapUserContext = (xml: string) => `<user_context>${xml}</user_context>`;
const contextSize = (xml: string) => encoder.encode(wrapUserContext(xml)).length;

function record(value: unknown): DataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as DataRecord : {};
}

function numeric(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function average(values: unknown[]): number | undefined {
  const samples = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return samples.length ? Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length * 100) / 100 : undefined;
}

function durationLabel(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const minutes = Math.floor(value / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function distanceLabel(value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${(value / 1000).toFixed(1)} km`;
}

function elevationLabel(value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${Math.round(value)} m`;
}

function exactDurationLabel(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const seconds = Math.round(value % 60 * 100) / 100;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", seconds || !hours && !minutes ? `${seconds}s` : ""].filter(Boolean).join(" ");
}

function xmlAttributes(values: DataRecord): string {
  return Object.entries(values).flatMap(([key, value]) => {
    if (typeof value !== "string" && typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value))) return [];
    const escaped = String(value).replace(/[<>&"']/g,
      (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!);
    return [` ${key}="${escaped}"`];
  }).join("");
}

function activityXml(values: Metrics, includeSegments: boolean): string {
  const { segment_efforts: segments, ...telemetry } = values;
  const attributes = xmlAttributes({
    id: values.id,
    title: values.name,
    moving_time: exactDurationLabel(numeric(values.moving_time)),
    elapsed_time: exactDurationLabel(numeric(values.elapsed_time)),
    total_rest_time: exactDurationLabel(numeric(values.stopped_time_s)),
    pr_count: values.pr_count,
    achievement_count: values.achievement_count,
    segment_efforts_total: values.segment_efforts_total,
    segment_efforts_count: values.segment_efforts_count,
  });
  const segmentXml = includeSegments ? `<segment_efforts>${(Array.isArray(segments) ? segments : []).map((entry) => {
    const segment = record(entry);
    const grade = segment.average_grade;
    return `<segment${xmlAttributes({
      id: segment.segment_id,
      name: segment.name,
      distance: distanceLabel(numeric(segment.distance_m)),
      distance_m: segment.distance_m,
      grade: typeof grade === "number" ? `${grade}%` : undefined,
      time: exactDurationLabel(numeric(segment.elapsed_time_s)),
      elapsed_time_s: segment.elapsed_time_s,
      moving_time_s: segment.moving_time_s,
      avg_hr: segment.avg_hr,
      max_hr: segment.max_hr,
      avg_cadence: segment.avg_cadence,
      avg_watts: segment.avg_watts,
      pr_rank: segment.pr_rank,
      kom_rank: segment.kom_rank,
    })}/>`;
  }).join("")}</segment_efforts>` : "";
  const averageCadence = numeric(values.avg_cadence, values.cadence);
  const maximumCadence = numeric(values.max_cadence);
  const cadenceXml = averageCadence !== undefined || maximumCadence !== undefined
    ? `<cadence${xmlAttributes({ avg: averageCadence, max: maximumCadence })}/>` : "";
  return `<activity${attributes}>${segmentXml}${cadenceXml}${xmlBlock("telemetry", telemetry)}</activity>`;
}

function compact(value: unknown, depth = 0): MetricValue | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 160);
  if (depth >= 3 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.slice(0, 10).flatMap((entry) => {
    const result = compact(entry, depth + 1);
    return result === undefined ? [] : [result];
  });
  const entries = Object.entries(record(value)).slice(0, 12).flatMap(([key, entry]) => {
    if (/gps|track|latitude|longitude|polyline|coordinate|latlng|stream|route|^(map|lat|lon|lng)$/i.test(key)) return [];
    const result = compact(entry, depth + 1);
    return result === undefined ? [] : [[key.slice(0, 60), result] as const];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function metrics(values: DataRecord): Metrics {
  return Object.fromEntries(Object.entries(values).flatMap(([key, value]) => {
    const result = compact(value);
    return result === undefined ? [] : [[key, result]];
  }));
}

function xmlBlock(name: string, value: Metrics): string {
  const escaped = JSON.stringify(value).replace(/[<>&]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[character]!);
  return `<${name}>${escaped}</${name}>`;
}

function yearlyMetrics(activities: Activity[]): Metrics {
  const summaries = new Map<string, YearlySummary>();
  const yearFormatter = new Intl.DateTimeFormat("en", { timeZone: "Europe/Warsaw", year: "numeric" });
  for (const { timestamp, data } of activities) {
    const year = yearFormatter.format(timestamp);
    const summary: YearlySummary = summaries.get(year) ?? {
      total_rides_count: 0, total_cycling_distance_km: 0, total_cycling_elevation_m: 0, total_cycling_duration: 0,
      total_runs_count: 0, total_running_distance_km: 0, total_running_elevation_m: 0, total_running_duration: 0,
      has_power_meter: false, best_segments_count: 0,
    };
    const sport = data.sport_type ?? data.activityType ?? data.type;
    const discipline = typeof sport === "string" ? activityDiscipline(sport) : "other";
    const distance = (numeric(data.distance, data.distanceInMeters) ?? 0) / 1000;
    const elevation = numeric(data.total_elevation_gain, data.elevationGain, data.totalElevationGainInMeters, data.elevationGainInMeters);
    const duration = numeric(data.moving_time, data.durationInSeconds, data.duration) ?? 0;
    if (discipline === "cycling") {
      summary.total_rides_count += 1;
      summary.total_cycling_distance_km += distance;
      summary.total_cycling_elevation_m += elevation ?? 0;
      summary.total_cycling_duration += duration;
      if (elevation !== undefined) summary.max_elevation_ride_m = Math.max(summary.max_elevation_ride_m ?? 0, elevation);
      const maxPower = numeric(data.max_watts, data.maximumPower, data.maxPowerInWatts);
      if (maxPower !== undefined) summary.max_watts_recorded = Math.max(summary.max_watts_recorded ?? 0, maxPower);
      const averagePowers = [summary.highest_avg_power,
        numeric(data.avg_watts, data.average_watts, data.averagePower, data.averagePowerInWatts),
        numeric(data.weighted_average_watts, data.weighted_avg_power, data.weightedAveragePower),
      ].filter((value): value is number => value !== undefined);
      if (averagePowers.length) summary.highest_avg_power = Math.max(...averagePowers);
      summary.has_power_meter ||= data.device_watts === true;
    } else if (discipline === "running") {
      summary.total_runs_count += 1;
      summary.total_running_distance_km += distance;
      summary.total_running_elevation_m += elevation ?? 0;
      summary.total_running_duration += duration;
    }
    const segments: unknown = data.segment_efforts ?? data.segmentEfforts;
    if (Array.isArray(segments)) {
      for (const segment of segments) {
        const effort = record(segment);
        summary.best_segments_count += Number(effort.pr_rank === 1) + Number(effort.kom_rank === 1);
      }
    }
    const heartRateValues = [summary.max_heart_rate_bpm,
      numeric(data.max_heartrate, data.maximumHeartRate, data.maxHeartRateInBeatsPerMinute),
    ].filter((value): value is number => value !== undefined);
    if (heartRateValues.length) summary.max_heart_rate_bpm = Math.max(...heartRateValues);
    summaries.set(year, summary);
  }
  const years = [...summaries.keys()].sort().reverse();
  const fields: (keyof YearlySummary)[] = [
    "total_rides_count", "total_cycling_distance_km", "total_cycling_elevation_m", "total_cycling_duration",
    "total_runs_count", "total_running_distance_km", "total_running_elevation_m", "total_running_duration",
    "max_watts_recorded", "highest_avg_power", "has_power_meter", "best_segments_count", "max_elevation_ride_m", "max_heart_rate_bpm",
  ];
  return {
    years,
    ...Object.fromEntries(fields.map((field) => [field, years.map((year) => {
      const value = summaries.get(year)?.[field];
      if (value === undefined) return "unknown";
      if (typeof value === "boolean") return value;
      if (field === "total_cycling_distance_km" || field === "total_running_distance_km") return `${value.toFixed(1)} km`;
      if (field === "total_cycling_duration" || field === "total_running_duration") return durationLabel(value) ?? "unknown";
      return Math.round(value * 100) / 100;
    })])),
  };
}

function segmentValues(entry: unknown): Metrics {
  const effort = record(entry);
  const segment = record(effort.segment);
  const prRank = numeric(effort.pr_rank);
  const komRank = numeric(effort.kom_rank);
  const name = effort.name ?? segment.name;
  const grade = effort.average_grade ?? segment.average_grade;
  const values = metrics({
    segment_id: segment.id ?? effort.segment_id,
    name,
    distance_m: numeric(effort.distance, segment.distance),
    average_grade: typeof grade === "number" && Number.isFinite(grade) ? grade : undefined,
    elapsed_time_s: numeric(effort.elapsed_time),
    moving_time_s: numeric(effort.moving_time),
    avg_hr: numeric(effort.average_heartrate),
    max_hr: numeric(effort.max_heartrate),
    avg_cadence: numeric(effort.average_cadence),
    avg_watts: numeric(effort.average_watts),
    pr_rank: prRank !== undefined && prRank > 0 ? prRank : undefined,
    kom_rank: komRank !== undefined && komRank > 0 ? komRank : undefined,
  });
  if (typeof name === "string") values.name = name.slice(0, 512);
  return values;
}

function importantSegments(value: unknown, powerAllowed: boolean): Metrics[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments = value.map(segmentValues).filter((segment) => typeof segment.name === "string" && segment.name.length > 0);
  const byHeartRate = segments.filter((segment) => numeric(segment.max_hr, segment.avg_hr) !== undefined)
    .sort((left, right) =>
    (numeric(right.max_hr, right.avg_hr) ?? 0) - (numeric(left.max_hr, left.avg_hr) ?? 0))
    .slice(0, 3);
  const byGrade = segments.filter((segment) => (numeric(segment.average_grade) ?? 0) > 0)
    .sort((left, right) => (numeric(right.average_grade) ?? 0) - (numeric(left.average_grade) ?? 0))
    .slice(0, 5);
  const byRank = [...segments].sort((left, right) => {
    const rank = (segment: Metrics) => Math.min(numeric(segment.pr_rank) ?? Infinity, numeric(segment.kom_rank) ?? Infinity);
    const leftRank = rank(left);
    const rightRank = rank(right);
    if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
    return (numeric(right.max_hr, right.avg_hr) ?? 0) - (numeric(left.max_hr, left.avg_hr) ?? 0)
      || (powerAllowed ? (numeric(right.avg_watts) ?? 0) - (numeric(left.avg_watts) ?? 0) : 0);
  });
  const selected = new Map<string, Metrics>();
  for (const segment of [...byHeartRate, ...byGrade, ...byRank]) {
    const id = String(segment.segment_id ?? segment.name ?? selected.size);
    if (!selected.has(id)) selected.set(id, segment);
    if (selected.size === 5) break;
  }
  return [...selected.values()];
}

function providerDistribution(value: unknown): Metrics[] | undefined {
  const parsed = zoneDistributionSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const total = parsed.data.reduce((sum, zone) => sum + zone.seconds, 0);
  if (total <= 0) return undefined;
  return parsed.data.map(({ zone, seconds }) => metrics({ provider_zone: `Z${zone}`, seconds, percent: seconds * 100 / total }));
}

function activityMetrics(data: DataRecord, preferences: AIDataPreferences, zones: AthleteZones): Metrics {
  const sport = typeof data.sport_type === "string" ? data.sport_type : data.activityType ?? data.type;
  const running = typeof sport === "string" && /run|jog|trail/i.test(sport);
  const duration = numeric(data.moving_time, data.durationInSeconds, data.duration);
  const movingTime = numeric(data.moving_time);
  const elapsedTime = numeric(data.elapsed_time);
  const distance = numeric(data.distance, data.distanceInMeters);
  const efforts = data.segment_efforts ?? data.segmentEfforts;
  const segments = importantSegments(efforts, data.device_watts === true && zones.settings.has_power_meter !== false);
  const athleteCount = numeric(data.athlete_count);
  const averageHr = numeric(data.average_heartrate, data.averageHeartRate, data.averageHeartRateInBeatsPerMinute);
  const averagePower = numeric(data.average_watts, data.averagePower, data.averagePowerInWatts);
  const normalizedPower = numeric(data.normalized_power, data.normalizedPower, data.normalizedPowerInWatts);
  const percent = (value: number | undefined, threshold: number | undefined) => value !== undefined && threshold !== undefined ? value / threshold * 100 : undefined;
  const powerMeasurement = data.device_watts === true ? "measured"
    : data.device_watts === false || zones.settings.has_power_meter === false ? "estimated_or_unverified"
    : zones.settings.has_power_meter === true ? "athlete_reports_meter" : "unknown";
  const values = metrics({
    id: data.activityId ?? data.id,
    name: data.name,
    pr_count: numeric(data.pr_count),
    achievement_count: numeric(data.achievement_count),
    type: sport,
    date: data.start_date ?? data.startedAt,
    duration: durationLabel(duration),
    moving_time: movingTime,
    elapsed_time: elapsedTime,
    stopped_time_s: movingTime !== undefined && elapsedTime !== undefined && elapsedTime >= movingTime ? elapsedTime - movingTime : undefined,
    distance_m: distance,
    avg_speed_kmh: numeric(data.average_speed) !== undefined ? numeric(data.average_speed)! * 3.6
      : distance !== undefined && movingTime !== undefined && movingTime > 0 ? distance / movingTime * 3.6 : undefined,
    athlete_count: athleteCount,
    companions_count: athleteCount !== undefined && athleteCount >= 1 ? athleteCount - 1 : undefined,
    segment_efforts_count: segments?.length,
    segment_efforts_total: Array.isArray(efforts) ? efforts.length : undefined,
    device_watts: data.device_watts,
    distance: distanceLabel(distance),
    elevation_gain: elevationLabel(numeric(data.total_elevation_gain, data.elevationGain, data.totalElevationGainInMeters, data.elevationGainInMeters)),
    avg_hr: averageHr,
    max_hr: numeric(data.max_heartrate, data.maximumHeartRate, data.maxHeartRateInBeatsPerMinute),
    ...(preferences.effortZones ? {
      hr_zone: classifyZone(averageHr, zones.hr),
      hr_zone_basis: classifyZone(averageHr, zones.hr) ? "average_hr" : undefined,
      hr_pct_max: percent(averageHr, zones.settings.max_hr),
      hr_pct_lthr: percent(averageHr, zones.settings.lthr),
      power_zone: classifyZone(averagePower, zones.power),
      power_zone_basis: classifyZone(averagePower, zones.power) ? "average_power" : undefined,
      power_pct_ftp: percent(averagePower, zones.settings.ftp_watts),
      np_zone: classifyZone(normalizedPower, zones.power),
      np_pct_ftp: percent(normalizedPower, zones.settings.ftp_watts),
      power_measurement: averagePower !== undefined || normalizedPower !== undefined ? powerMeasurement : undefined,
      provider_hr_zones_distribution: providerDistribution(data.heart_rate_zones ?? data.heartRateZones),
      provider_power_zones_distribution: providerDistribution(data.power_zones ?? data.powerZones),
    } : {}),
    avg_power: averagePower,
    max_power: numeric(data.max_watts, data.maximumPower, data.maxPowerInWatts),
    normalized_power: normalizedPower,
    weighted_avg_power: numeric(data.weighted_average_watts, data.weighted_avg_power, data.weightedAveragePower),
    avg_cadence: numeric(data.average_cadence, data.averageCadence, data.averageBikeCadenceInRoundsPerMinute),
    max_cadence: numeric(data.max_cadence, data.maxCadence, data.maxBikeCadenceInRoundsPerMinute),
    has_heartrate: data.has_heartrate,
    tss: numeric(data.tss, data.trainingStressScore),
    ...(running ? {
      avg_pace: numeric(data.avg_pace, data.averagePace, duration !== undefined && distance !== undefined && distance > 0 ? duration * 1000 / distance : undefined),
      gap: numeric(data.gap, data.grade_adjusted_pace, data.gradeAdjustedPace),
      cadence: numeric(data.cadence, data.average_cadence, data.averageCadence, data.averageRunCadenceInStepsPerMinute),
    } : {}),
    rpe: numeric(data.rpe, data.perceived_exertion, data.workoutRpe),
    suffer_score: numeric(data.suffer_score, data.sufferScore),
    weather: data.weather ?? data.weatherSummary,
  });
  if (typeof data.name === "string") values.name = data.name.slice(0, 512);
  if (segments !== undefined) values.segment_efforts = segments;
  return values;
}

export async function buildUserContextDetails(
  userId: string,
  preferences: AIDataPreferences = defaultAIDataPreferences,
  onRecovery?: () => void,
  signal?: AbortSignal,
): Promise<{ xml: string; recoveryDays: number; workouts: number }> {
  const settings = authSettings();
  if (!settings) throw new Error("Authentication is not configured");
  const abortSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000);
  const options = { region: settings.AWS_REGION, maxAttempts: 1, requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 } };
  const client = new DynamoDBClient(options);
  const kms = new KMSClient(options);
  const partition = `USER#${userId}`;
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const firstDate = new Date(`${today}T00:00:00Z`);
  firstDate.setUTCDate(firstDate.getUTCDate() - 13);
  const query = (command: QueryCommand) => client.send(command, { abortSignal });
  const get = async (command: GetItemCommand) => {
    const response = await query(new QueryCommand({
      TableName: settings.DYNAMODB_TABLE_NAME,
      KeyConditionExpression: "PK = :user AND SK = :key",
      ExpressionAttributeValues: { ":user": { S: partition }, ":key": command.input.Key?.SK ?? { S: "" } },
      ConsistentRead: true,
      Limit: 1,
    }));
    return { Item: response.Items?.[0] };
  };
  const memoryStore = createAthleteMemoryStore({ get, update: (command) => client.send(command, { abortSignal }) }, settings.DYNAMODB_TABLE_NAME);
  const readActivities = async (): Promise<Activity[]> => {
    const activities: Activity[] = [];
    let lastKey: QueryCommandOutput["LastEvaluatedKey"];
    do {
      const response = await query(new QueryCommand({
        TableName: settings.DYNAMODB_TABLE_NAME,
        KeyConditionExpression: "PK = :user AND begins_with(SK, :activity)",
        ExpressionAttributeValues: {
          ":user": { S: partition },
          ":activity": { S: "ACTIVITY#" },
        },
        ConsistentRead: true,
        ExclusiveStartKey: lastKey,
      }));
      for (const item of response.Items ?? []) {
        const data = record(unmarshall(item));
        if (data.PK !== partition || data.entityType !== "WORKOUT" || data.status !== "ACTIVE"
          || (data.provider !== "strava" && data.provider !== "garmin")) continue;
        const timestamp = typeof data.start_date === "string" ? Date.parse(data.start_date) : NaN;
        if (!Number.isFinite(timestamp) || timestamp > now.getTime()) continue;
        activities.push({ source: data.provider, timestamp, data });
      }
      lastKey = response.LastEvaluatedKey;
    } while (lastKey);
    return activities;
  };
  const reader = createDailyMetricReader({
    get,
    query,
    artifacts: createArtifactStore({ get, query, transact: (command) => client.send(command, { abortSignal }) }, settings.DYNAMODB_TABLE_NAME),
    encryption: createEnvelopeEncryption({ generate: (command) => kms.send(command, { abortSignal }), decrypt: (command) => kms.send(command, { abortSignal }) }, settings.DYNAMODB_KMS_KEY_ARN),
  }, settings.DYNAMODB_TABLE_NAME);
  const readRecovery = async (): Promise<RecoveryDay[]> => {
    if (!preferences.recoveryMetrics) return [];
    const days = await Promise.all(Array.from({ length: 14 }, async (_, index) => {
      const date = new Date(firstDate);
      date.setUTCDate(date.getUTCDate() + index);
      const result = await reader(userId, date.toISOString().slice(0, 10)).catch(() => null);
      return result ? { date: result.date, values: record(result.values) } : null;
    }));
    return days.filter((day): day is RecoveryDay => day !== null);
  };
  const [profile, history, recovery, storedMemory] = await Promise.all([
    query(new QueryCommand({ TableName: settings.DYNAMODB_TABLE_NAME,
      KeyConditionExpression: "PK = :user AND SK = :key",
      ExpressionAttributeValues: { ":user": { S: partition }, ":key": { S: "METADATA" } }, Limit: 1, ConsistentRead: true }))
      .then((result) => result.Items?.[0] ? record(unmarshall(result.Items[0])) : {}).catch((): DataRecord => ({})),
    readActivities().catch(() => null),
    readRecovery(),
    memoryStore.get(userId).catch((): AthleteMemory => ({})),
  ]);
  onRecovery?.();
  const strava = (history ?? []).filter((activity) => activity.source === "strava");
  const activities = (strava.length ? strava : history ?? []).sort((left, right) => right.timestamp - left.timestamp);
  const derivedMetrics = history === null ? undefined : deriveAthleteMetrics(activities, now.getTime());
  const athleteMemory: AthleteMemory = {
    ...storedMemory,
    focus_goal: storedMemory.focus_goal ?? (typeof profile.primaryGoal === "string" ? profile.primaryGoal.trim().slice(0, 160) || undefined : undefined),
    derived_metrics: derivedMetrics,
  };
  if (derivedMetrics) {
    await memoryStore.updateDerived(userId, derivedMetrics).catch((error: unknown) => {
      console.warn("athlete_memory_metrics_write_failed", { type: error instanceof Error ? error.name : "UnknownError" });
    });
  }
  const physiology = athletePhysiologySchema.safeParse(profile);
  const zones = buildAthleteZones(physiology.success ? physiology.data : {});
  const recentActivities: Metrics[] = activities.slice(0, activityLimit).map((activity) => ({
    source: activity.source, ...activityMetrics(activity.data, preferences, zones),
  }));
  const yearlySummary = xmlBlock("yearly_summary", yearlyMetrics(activities));
  const recoveryDataAvailable = recovery.some(({ values }) => numeric(values.sleepScore, values.sleepDurationSeconds, values.hrvLastNightAverage) !== undefined);
  const profileMetrics = metrics({
    recovery_data_available: recoveryDataAvailable,
    sports: profile.sports ?? profile.sportTypes ?? [...new Set(recentActivities.map((activity) => activity.type).filter((sport): sport is string => typeof sport === "string"))],
    primaryGoal: profile.primaryGoal,
    injuries: profile.injuries,
    equipment: profile.equipment,
  });
  let profileXml = xmlBlock("athlete_profile", profileMetrics);
  while (encoder.encode(profileXml).length > 600) {
    const optionalKey = Object.keys(profileMetrics).reverse().find((key) => key !== "recovery_data_available");
    if (!optionalKey) break;
    delete profileMetrics[optionalKey];
    profileXml = xmlBlock("athlete_profile", profileMetrics);
  }
  const zonesXml = xmlBlock("athlete_zones", preferences.effortZones ? metrics({
    ...zones.settings,
    hr_method: zones.hr_method,
    hr: zones.hr,
    power_method: zones.power ? "ftp_five_zones" : "insufficient_data",
    power: zones.power,
    interval_rule: "above < value <= up_to; missing up_to means unbounded",
  }) : { shared: false });
  let xml = zonesXml + profileXml + yearlySummary + athleteMemoryBlock(athleteMemory);
  const activityValues: Metrics[] = recentActivities.map((activity) => Object.fromEntries(
    Object.entries(activity).filter(([key]) => ["source", "type", "date", "duration", "distance", "elevation_gain",
      "name", "moving_time", "elapsed_time", "stopped_time_s", "distance_m", "avg_speed_kmh", "athlete_count", "companions_count",
      "id", "pr_count", "achievement_count", "segment_efforts_count", "segment_efforts_total", "segment_efforts", "device_watts",
      "hr_zone", "hr_zone_basis", "power_zone", "power_zone_basis", "power_measurement"].includes(key)),
  ));
  const recentXml = () => activityValues.length
    ? `<recent_activities>${activityValues.map((values) => activityXml(values, true)).join("")}</recent_activities>` : "";
  while (activityValues.length > 1 && contextSize(`${xml}${recentXml()}`) > contextByteBudget) activityValues.pop();
  const baselineSamples = recovery.filter((day) => day.date !== today)
    .map(({ values }) => numeric(values.hrvLastNightAverage)).filter((value): value is number => value !== undefined);
  const baseline = average(baselineSamples);
  let recoveryDays = 0;
  const recoveryLines: string[] = [];
  for (const day of [...recovery].reverse()) {
    const values = metrics({ date: day.date, sleep_score: day.values.sleepScore, sleep_duration: durationLabel(numeric(day.values.sleepDurationSeconds)),
      hrv_night: day.values.hrvLastNightAverage, stress_avg: day.values.stressAverage ?? day.values.averageStressLevel,
      body_battery: day.values.bodyBattery, resting_hr: day.values.restingHeartRate });
    if (Object.keys(values).length <= 1) continue;
    const line = xmlBlock("day", values);
    const summary = baseline === undefined ? "" : xmlBlock("baseline", { hrv_baseline: baseline, samples: baselineSamples.length });
    const recoveryXml = `<recovery_status>${summary}${[...recoveryLines, line].join("")}</recovery_status>`;
    if (encoder.encode(recoveryXml).length > 700
      || contextSize(`${xml}${recoveryXml}${recentXml()}`) > contextByteBudget) break;
    recoveryLines.push(line);
    recoveryDays += 1;
  }
  if (recoveryLines.length) {
    const summary = baseline === undefined ? "" : xmlBlock("baseline", { hrv_baseline: baseline, samples: baselineSamples.length });
    xml += `<recovery_status>${summary}${recoveryLines.join("\n")}</recovery_status>`;
  }
  const detailKeys = [...new Set(["avg_hr", "avg_power", "hr_pct_max", "hr_pct_lthr", "power_pct_ftp", "np_zone", "np_pct_ftp",
    ...recentActivities.flatMap((activity) => Object.keys(activity))])];
  for (const key of detailKeys) {
    for (const [index, activity] of recentActivities.entries()) {
      const values = activityValues[index];
      const value = activity[key];
      if (!values || values[key] !== undefined || value === undefined) continue;
      values[key] = value;
      if (contextSize(`${xml}${recentXml()}`) > contextByteBudget) delete values[key];
    }
  }
  xml += recentXml();
  return { xml: wrapUserContext(xml), recoveryDays, workouts: activityValues.length };
}

export async function buildUserContext(
  userId: string,
  preferences: AIDataPreferences = defaultAIDataPreferences,
  onRecovery?: (summary: { recoveryDays: number; workouts: number }) => void,
  signal?: AbortSignal,
): Promise<string> {
  const context = await buildUserContextDetails(userId, preferences, undefined, signal);
  onRecovery?.({ recoveryDays: context.recoveryDays, workouts: context.workouts });
  return context.xml;
}
export const singleActivityIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

export async function buildSingleActivityContext(
  userId: string,
  activityId: string,
  preferences: AIDataPreferences = defaultAIDataPreferences,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!singleActivityIdPattern.test(activityId)) return null;
  const settings = authSettings();
  if (!settings) throw new Error("Authentication is not configured");
  const abortSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000);
  const client = new DynamoDBClient({ region: settings.AWS_REGION, maxAttempts: 1, requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 } });
  const partition = `USER#${userId}`;
  const get = async (command: GetItemCommand) => {
    const sortKey = command.input.Key?.SK?.S;
    return { Item: sortKey ? (await query(sortKey))?.Item : undefined };
  };
  const query = async (sortKey: string): Promise<{ Item?: Record<string, AttributeValue> } | null> => {
    const response = await client.send(new QueryCommand({
      TableName: settings.DYNAMODB_TABLE_NAME,
      KeyConditionExpression: "PK = :user AND SK = :key",
      ExpressionAttributeValues: { ":user": { S: partition }, ":key": { S: sortKey } },
      ConsistentRead: true,
      Limit: 1,
    }), { abortSignal });
    return { Item: response.Items?.[0] };
  };
  const readItem = async (sortKey: string): Promise<DataRecord | null> => {
    const item = (await query(sortKey))?.Item;
    return item ? record(unmarshall(item)) : null;
  };
  const memoryStore = createAthleteMemoryStore({ get, update: (command) => client.send(command, { abortSignal }) }, settings.DYNAMODB_TABLE_NAME);
  const [strava, garmin, profile, storedMemory] = await Promise.all([
    readItem(`ACTIVITY#STRAVA#${activityId}`),
    readItem(`ACTIVITY#GARMIN#${activityId}`),
    readItem("METADATA").then((item) => item ?? {}).catch((): DataRecord => ({})),
    memoryStore.get(userId).catch((): AthleteMemory => ({})),
  ]);
  const stored = [strava, garmin].find((item) => item !== null && item.entityType === "WORKOUT" && item.status === "ACTIVE");
  if (!stored) return null;
  let data = record(stored);
  if (data.provider === "strava" && (data.detailLevel !== "DETAIL" || !Array.isArray(data.segment_efforts))) {
    const detailSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    const detail = await fetchStravaActivityDetail(userId, activityId, settings, detailSignal).catch((error: unknown) => {
      console.warn("strava_detail_fetch_failed", { type: error instanceof Error ? error.name : "UnknownError" });
      return null;
    });
    if (detail) data = { ...data, ...Object.fromEntries(Object.entries(detail).filter(([, value]) => value !== undefined)) };
  }
  const physiology = athletePhysiologySchema.safeParse(profile);
  const zones = buildAthleteZones(physiology.success ? physiology.data : {});
  const efforts: unknown = data.segment_efforts ?? data.segmentEfforts;
  const segments = Array.isArray(efforts) ? efforts.map(segmentValues) : [];
  const values: Metrics = {
    source: data.provider === "garmin" ? "garmin" : "strava",
    ...activityMetrics(data, preferences, zones),
    segment_efforts: segments,
    segment_efforts_count: segments.length,
    segment_efforts_total: segments.length,
  };
  const profileXml = xmlBlock("athlete_profile", metrics({
    sports: profile.sports ?? profile.sportTypes,
    primaryGoal: profile.primaryGoal,
    injuries: profile.injuries,
    equipment: profile.equipment,
  }));
  const memoryXml = athleteMemoryBlock({
    ...storedMemory,
    focus_goal: storedMemory.focus_goal ?? (typeof profile.primaryGoal === "string" ? profile.primaryGoal.trim().slice(0, 160) || undefined : undefined),
  });
  const zonesXml = xmlBlock("athlete_zones", preferences.effortZones ? metrics({
    ...zones.settings,
    hr_method: zones.hr_method,
    hr: zones.hr,
    power_method: zones.power ? "ftp_five_zones" : "insufficient_data",
    power: zones.power,
    interval_rule: "above < value <= up_to; missing up_to means unbounded",
  }) : { shared: false });
  return `<single_activity_focus>${zonesXml}${profileXml}${memoryXml}${activityXml(values, true)}</single_activity_focus>`;
}
