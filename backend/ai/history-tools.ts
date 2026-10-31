import "server-only";
import { DynamoDBClient, QueryCommand, type QueryCommandOutput } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import { authSettings } from "../../lib/server-config";

export const historicalSegmentEffortsInputSchema = z.object({
  segmentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  limit: z.number().int().min(1).max(20).default(10),
});

export const trainingLoadHistoryInputSchema = z.object({
  days: z.number().int().min(1).max(365),
});

type DataRecord = Record<string, unknown>;
type HistoricalActivity = { data: DataRecord; timestamp: number };
type History = {
  provider: "strava" | "garmin";
  before: number;
  activities: HistoricalActivity[];
};

function record(value: unknown): DataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as DataRecord : {};
}

function numeric(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

export function createActivityHistoryTools(userId: string, activityId: string, signal: AbortSignal) {
  let history: Promise<History | null> | undefined;
  const load = (): Promise<History | null> => {
    history ??= (async (): Promise<History | null> => {
      const settings = authSettings();
      if (!settings) return null;
      const abortSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      const client = new DynamoDBClient({ region: settings.AWS_REGION, maxAttempts: 1,
        requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 } });
      const partition = `USER#${userId}`;
      const readFocus = async (provider: "strava" | "garmin"): Promise<DataRecord | null> => {
        const result = await client.send(new QueryCommand({
          TableName: settings.DYNAMODB_TABLE_NAME,
          KeyConditionExpression: "PK = :user AND SK = :key",
          ExpressionAttributeValues: marshall({ ":user": partition, ":key": `ACTIVITY#${provider.toUpperCase()}#${activityId}` }),
          ConsistentRead: true, Limit: 1,
        }), { abortSignal });
        const data = result.Items?.[0] ? unmarshall(result.Items[0]) : null;
        return data?.entityType === "WORKOUT" && data.status === "ACTIVE" ? data : null;
      };
      const [stravaFocus, garminFocus] = await Promise.all([readFocus("strava"), readFocus("garmin")]);
      const focus = stravaFocus ?? garminFocus;
      const before = typeof focus?.start_date === "string" ? Date.parse(focus.start_date) : NaN;
      if (!Number.isFinite(before)) return null;
      const activities: HistoricalActivity[] = [];
      let cursor: QueryCommandOutput["LastEvaluatedKey"];
      let pages = 0;
      do {
        const result = await client.send(new QueryCommand({
          TableName: settings.DYNAMODB_TABLE_NAME,
          KeyConditionExpression: "PK = :user AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: marshall({ ":user": partition, ":prefix": "ACTIVITY#" }),
          ConsistentRead: true, ExclusiveStartKey: cursor, Limit: 100,
        }), { abortSignal });
        for (const item of result.Items ?? []) {
          const data = unmarshall(item);
          if (data.PK !== partition || data.entityType !== "WORKOUT" || data.status !== "ACTIVE"
            || (data.provider !== "strava" && data.provider !== "garmin")) continue;
          const timestamp = typeof data.start_date === "string" ? Date.parse(data.start_date) : NaN;
          if (Number.isFinite(timestamp)) activities.push({ data, timestamp });
        }
        cursor = result.LastEvaluatedKey;
        pages += 1;
        if (cursor && pages >= 20) return null;
      } while (cursor);
      const provider = activities.some(({ data }) => data.provider === "strava") ? "strava" : "garmin";
      return { provider, before, activities: activities.filter(({ data, timestamp }) =>
        data.provider === provider && String(data.activityId) !== activityId && timestamp < before)
        .sort((left, right) => right.timestamp - left.timestamp) };
    })().catch((error: unknown) => {
      signal.throwIfAborted();
      console.warn("chat_activity_history_failed", { type: error instanceof Error ? error.name : "UnknownError" });
      return null;
    });
    return history;
  };

  return {
    async getHistoricalSegmentEfforts(input: z.infer<typeof historicalSegmentEffortsInputSchema>) {
      const result = await load();
      if (!result) return { status: "unavailable" as const, segmentId: input.segmentId };
      let activitiesWithSegmentData = 0;
      const efforts = result.activities.flatMap(({ data }) => {
        const segments: unknown = data.segment_efforts ?? data.segmentEfforts;
        if (!Array.isArray(segments)) return [];
        activitiesWithSegmentData += 1;
        const running = typeof data.sport_type === "string" && /run|jog|trail/i.test(data.sport_type);
        return segments.flatMap((entry: unknown) => {
          const effort = record(entry);
          const segment = record(effort.segment);
          if (String(segment.id ?? effort.segment_id) !== input.segmentId) return [];
          const cadence = numeric(effort.average_cadence, effort.avg_cadence);
          return [{ activityId: String(data.activityId), date: data.start_date,
            elapsed_time_s: numeric(effort.elapsed_time, effort.elapsed_time_s),
            moving_time_s: numeric(effort.moving_time, effort.moving_time_s),
            avg_hr_bpm: numeric(effort.average_heartrate, effort.avg_hr),
            max_hr_bpm: numeric(effort.max_heartrate, effort.max_hr),
            avg_cadence: cadence === undefined ? undefined : cadence * (running && result.provider === "strava" ? 2 : 1),
            cadence_unit: running ? "spm" as const : "rpm" as const }];
        });
      });
      return { status: activitiesWithSegmentData === result.activities.length ? "ok" as const : "partial" as const,
        provider: result.provider, segmentId: input.segmentId, before: new Date(result.before).toISOString(),
        activitiesChecked: result.activities.length, activitiesWithSegmentData,
        totalStoredEfforts: efforts.length, efforts: efforts.slice(0, input.limit),
        truncated: efforts.length > input.limit, coverage: "stored_segment_efforts_only" as const };
    },
    async getAthleteTrainingLoadHistory(input: z.infer<typeof trainingLoadHistoryInputSchema>) {
      const result = await load();
      if (!result) return { status: "unavailable" as const, days: input.days };
      const since = result.before - input.days * 86400000;
      const activities = result.activities.filter(({ timestamp }) => timestamp >= since);
      const distances = activities.flatMap(({ data }) => {
        const value = numeric(data.distance, data.distanceInMeters);
        return value === undefined ? [] : [value];
      });
      const elevations = activities.flatMap(({ data }) => {
        const value = numeric(data.total_elevation_gain, data.elevationGain, data.totalElevationGainInMeters, data.elevationGainInMeters);
        return value === undefined ? [] : [value];
      });
      const activeDays = new Set(activities.map(({ timestamp }) => new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(timestamp))).size;
      return { status: distances.length === activities.length && elevations.length === activities.length ? "ok" as const : "partial" as const,
        provider: result.provider, days: input.days, since: new Date(since).toISOString(),
        before: new Date(result.before).toISOString(), activityCount: activities.length, activeDays,
        activitiesPerWeek: Math.round(activities.length * 7 / input.days * 100) / 100,
        recordedDistance_m: distances.reduce((total, value) => total + value, 0),
        recordedElevationGain_m: elevations.reduce((total, value) => total + value, 0),
        activitiesWithDistance: distances.length, activitiesWithElevation: elevations.length,
        coverage: "stored_activities_only" as const };
    },
  };
}