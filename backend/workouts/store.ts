import {
  QueryCommand,
  BatchGetItemCommand,
  type QueryCommandOutput,
  type BatchGetItemCommandOutput,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import type { Provider } from "../providers/policy";
import { zoneDistributionSchema } from "./telemetry";

const workoutSchema = z.object({
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

type Dependencies = {
  query: (
    command: QueryCommand,
  ) => Promise<Pick<QueryCommandOutput, "Items" | "LastEvaluatedKey">>;
  batchGet: (
    command: BatchGetItemCommand,
  ) => Promise<
    Pick<BatchGetItemCommandOutput, "Responses" | "UnprocessedKeys">
  >;
};

export function createWorkoutStore(
  dependencies: Dependencies,
  tableName: string,
) {
  return {
    async recent(
      userId: string,
      provider: Provider = "strava",
    ): Promise<Workout[]> {
      const partition = `USER#${userId}`;
      const prefix = `ACTIVITY#${provider.toUpperCase()}#`;
      if (provider === "garmin") {
        const workouts: Workout[] = [];
        let cursor: QueryCommandOutput["LastEvaluatedKey"];
        do {
          const response = await dependencies.query(new QueryCommand({
            TableName: tableName, ConsistentRead: true,
            KeyConditionExpression: "PK = :user AND begins_with(SK, :activity)",
            ExpressionAttributeValues: { ":user": { S: partition }, ":activity": { S: prefix } },
            ExclusiveStartKey: cursor,
          }));
          for (const item of response.Items ?? []) {
            const parsed = workoutSchema.safeParse(unmarshall(item));
            if (!parsed.success) continue;
            const workout = parsed.data;
            if (workout.PK !== partition || workout.provider !== provider || workout.SK !== `${prefix}${workout.activityId}`) continue;
            workouts.push({ id: workout.activityId, provider, name: workout.name, sport: workout.sport_type,
              startedAt: workout.start_date, distance: workout.distance, movingTime: workout.moving_time,
              elapsedTime: workout.elapsed_time, elevationGain: workout.total_elevation_gain,
              averageHeartRate: workout.average_heartrate, maximumHeartRate: workout.max_heartrate,
              averagePower: workout.average_watts, maximumPower: workout.max_watts,
              heartRateZones: workout.heart_rate_zones, powerZones: workout.power_zones });
          }
          cursor = response.LastEvaluatedKey;
        } while (cursor);
        return workouts.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)).slice(0, 50);
      }
      const keys: Record<string, AttributeValue>[] = [];
      let cursor: Record<string, AttributeValue> | undefined;
      do {
        const response = await dependencies.query(
          new QueryCommand({
            TableName: tableName,
            IndexName: "GSI1",
            KeyConditionExpression:
              "GSI1PK = :user AND begins_with(GSI1SK, :activity)",
            ExpressionAttributeValues: {
              ":user": { S: partition },
              ":activity": { S: "ACTIVITY#" },
              ":providerKey": { S: prefix },
            },
            FilterExpression: "begins_with(SK, :providerKey)",
            ScanIndexForward: false,
            Limit: 50,
            ExclusiveStartKey: cursor,
          }),
        );
        keys.push(
          ...(response.Items ?? [])
            .filter(
              (item) =>
                item.PK?.S === partition && item.SK?.S?.startsWith(prefix),
            )
            .map((item) => ({ PK: item.PK!, SK: item.SK! })),
        );
        cursor = response.LastEvaluatedKey;
      } while (cursor && keys.length < 50);
      keys.splice(50);
      if (!keys.length) return [];
      let pending: NonNullable<BatchGetItemCommandOutput["UnprocessedKeys"]> = {
        [tableName]: {
          Keys: keys,
          ConsistentRead: true,
          ProjectionExpression:
            "PK, SK, entityType, provider, #status, activityId, #name, sport_type, start_date, distance, moving_time, elapsed_time, total_elevation_gain, average_heartrate, max_heartrate, average_watts, max_watts, heart_rate_zones, power_zones",
          ExpressionAttributeNames: { "#status": "status", "#name": "name" },
        },
      };
      const workouts: Workout[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const batch = await dependencies.batchGet(
          new BatchGetItemCommand({ RequestItems: pending }),
        );
        for (const item of batch.Responses?.[tableName] ?? []) {
          const parsed = workoutSchema.safeParse(unmarshall(item));
          if (!parsed.success) continue;
          const workout = parsed.data;
          if (
            workout.PK !== partition ||
            workout.provider !== provider ||
            workout.SK !== `${prefix}${workout.activityId}`
          )
            continue;
          workouts.push({
            id: workout.activityId,
            provider,
            name: workout.name,
            sport: workout.sport_type,
            startedAt: workout.start_date,
            distance: workout.distance,
            movingTime: workout.moving_time,
            elapsedTime: workout.elapsed_time,
            elevationGain: workout.total_elevation_gain,
            averageHeartRate: workout.average_heartrate,
            maximumHeartRate: workout.max_heartrate,
            averagePower: workout.average_watts,
            maximumPower: workout.max_watts,
            heartRateZones: workout.heart_rate_zones,
            powerZones: workout.power_zones,
          });
        }
        pending = batch.UnprocessedKeys ?? {};
        if (!Object.values(pending).some((request) => request.Keys?.length)) {
          return workouts.sort(
            (left, right) =>
              Date.parse(right.startedAt) - Date.parse(left.startedAt),
          );
        }
        if (attempt < 2)
          await new Promise((resolve) =>
            setTimeout(resolve, 40 * 2 ** attempt),
          );
      }
      throw new Error("Workout read is incomplete");
    },
  };
}
