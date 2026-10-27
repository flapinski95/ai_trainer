import { BatchGetItemCommand, QueryCommand, type AttributeValue, type BatchGetItemCommandInput } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import type { Provider } from "../providers/policy";
import { activityDiscipline, type ActivitiesPage, type ActivityType } from "./activities";
import { workoutSchema, type Workout } from "./model";
import type { createWorkoutStore } from "./store";

const cursorSchema = z.object({
  version: z.literal(1),
  userId: z.string().min(1),
  provider: z.enum(["strava", "garmin"]),
  type: z.enum(["all", "cycling", "running"]),
  limit: z.number().int().min(1).max(100),
  page: z.number().int().min(2).max(1000000),
  key: z.object({
    PK: z.string().max(2048),
    SK: z.string().max(1024),
    GSI1PK: z.string().max(2048),
    GSI1SK: z.string().max(1024),
  }).strict(),
}).strict();

export class InvalidActivityCursorError extends Error {}

type PageOptions = {
  userId: string;
  provider: Provider;
  type: ActivityType;
  page: number;
  limit: number;
  cursor?: string;
};

export function createActivityStore(
  dependencies: Parameters<typeof createWorkoutStore>[0],
  tableName: string,
) {
  return {
    async page(options: PageOptions): Promise<ActivitiesPage> {
      const { userId, provider, type, limit, page } = options;
      const partition = `USER#${userId}`;
      const prefix = `ACTIVITY#${provider.toUpperCase()}#`;
      let exclusiveStartKey: Record<string, AttributeValue> | undefined;
      if (options.cursor) {
        try {
          if (options.cursor.length > 8192) throw new Error();
          const cursor = cursorSchema.parse(JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")));
          if (cursor.userId !== userId || cursor.provider !== provider || cursor.type !== type
            || cursor.limit !== limit || cursor.page !== page || cursor.key.PK !== partition
            || cursor.key.GSI1PK !== partition || !cursor.key.SK.startsWith(prefix)
            || !cursor.key.GSI1SK.startsWith("ACTIVITY#")) throw new Error();
          exclusiveStartKey = marshall(cursor.key);
        } catch {
          throw new InvalidActivityCursorError("Nieprawidlowy kursor strony.");
        }
      } else if (page !== 1) {
        throw new InvalidActivityCursorError("Kolejna strona wymaga kursora.");
      }

      const activities: Workout[] = [];
      let lastIncludedKey: Record<string, AttributeValue> | undefined;
      const encodeCursor = (key: Record<string, AttributeValue> | undefined): string | null => key
        ? Buffer.from(JSON.stringify({ version: 1, userId, provider, type, limit, page: page + 1,
          key: unmarshall(key) })).toString("base64url")
        : null;

      for (let queryCount = 0; queryCount < 20; queryCount += 1) {
        const result = await dependencies.query(new QueryCommand({
          TableName: tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :user AND begins_with(GSI1SK, :activity)",
          FilterExpression: "begins_with(SK, :provider)",
          ExpressionAttributeValues: marshall({ ":user": partition, ":activity": "ACTIVITY#", ":provider": prefix }),
          ScanIndexForward: false,
          Limit: Math.min(100, (limit + 1 - activities.length) * 3),
          ExclusiveStartKey: exclusiveStartKey,
        }));
        const indexed = (result.Items ?? []).filter((item) => item.PK?.S === partition
          && item.SK?.S?.startsWith(prefix) && item.GSI1PK?.S === partition && item.GSI1SK?.S?.startsWith("ACTIVITY#"));
        const records = new Map<string, Record<string, AttributeValue>>();
        if (indexed.length) {
          let pending: NonNullable<BatchGetItemCommandInput["RequestItems"]> = { [tableName]: { Keys: indexed.map((item) => ({ PK: item.PK!, SK: item.SK! })), ConsistentRead: true } };
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const batch = await dependencies.batchGet(new BatchGetItemCommand({ RequestItems: pending }));
            for (const item of batch.Responses?.[tableName] ?? []) {
              if (item.PK?.S === partition && item.SK?.S) records.set(item.SK.S, item);
            }
            const remaining = batch.UnprocessedKeys?.[tableName]?.Keys ?? [];
            if (!remaining.length) break;
            if (attempt === 2) throw new Error("Activity read is incomplete");
            pending = { [tableName]: { Keys: remaining, ConsistentRead: true } };
            await new Promise((resolve) => setTimeout(resolve, 40 * 2 ** attempt));
          }
        }
        for (const entry of indexed) {
          const item = records.get(entry.SK!.S!);
          if (!item) continue;
          const parsed = workoutSchema.safeParse(unmarshall(item));
          if (!parsed.success) continue;
          const workout = parsed.data;
          if (workout.PK !== partition || workout.provider !== provider || workout.SK !== `${prefix}${workout.activityId}`
            || entry.GSI1SK?.S !== `ACTIVITY#${new Date(workout.start_date).toISOString()}#${provider.toUpperCase()}#${workout.activityId}`
            || (type !== "all" && activityDiscipline(workout.sport_type) !== type)) continue;
          if (activities.length === limit) {
            return { activities, page, limit, nextCursor: encodeCursor(lastIncludedKey) };
          }
          activities.push({ id: workout.activityId, provider, name: workout.name, sport: workout.sport_type,
            startedAt: workout.start_date, distance: workout.distance, movingTime: workout.moving_time,
            elapsedTime: workout.elapsed_time, elevationGain: workout.total_elevation_gain,
            averageHeartRate: workout.average_heartrate, maximumHeartRate: workout.max_heartrate,
            averagePower: workout.average_watts, maximumPower: workout.max_watts,
            heartRateZones: workout.heart_rate_zones, powerZones: workout.power_zones });
          lastIncludedKey = { PK: entry.PK!, SK: entry.SK!, GSI1PK: entry.GSI1PK!, GSI1SK: entry.GSI1SK! };
        }
        exclusiveStartKey = result.LastEvaluatedKey;
        if (!exclusiveStartKey) return { activities, page, limit, nextCursor: null };
      }
      return { activities, page, limit, nextCursor: encodeCursor(exclusiveStartKey) };
    },
  };
}