import "server-only";
import { DynamoDBClient, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { createArtifactStore } from "@/backend/garmin/artifacts";
import { createDailyMetricReader } from "@/backend/garmin/daily-reader";
import { createEnvelopeEncryption } from "@/backend/garmin/encryption";
import { activityProvider } from "@/backend/providers/policy";
import { createWorkoutStore } from "@/backend/workouts/store";
import { authStore } from "@/lib/auth-store";
import { authSettings } from "@/lib/server-config";

function shiftDate(date: string, days: number) {
  const shifted = new Date(`${date}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function average(values: (number | undefined)[]) {
  const samples = values.filter((value): value is number => value !== undefined);
  return {
    value: samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : null,
    sampleCount: samples.length,
  };
}

export async function athleteChatContext(userId: string, onRecovery?: () => void) {
  const settings = authSettings();
  if (!settings) throw new Error("Authentication is not configured");
  const options = {
    region: settings.AWS_REGION,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 },
  };
  const dynamodb = new DynamoDBClient(options);
  const kms = new KMSClient(options);
  const store = authStore();
  const connections = Promise.all([
    store.connection(userId),
    store.connection(userId, "garmin"),
  ]);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const utcToday = new Date().toISOString().slice(0, 10);
  const monday = shiftDate(utcToday, -((new Date(`${utcToday}T12:00:00Z`).getUTCDay() + 6) % 7));
  const readLoad = async (provider: "strava" | "garmin") => {
    const prefix = provider === "garmin" ? "SUMMARY#GARMIN#WEEK#" : "SUMMARY#WEEK#";
    const weeks = Array.from({ length: 4 }, (_, index) => ({
      startDate: shiftDate(monday, (index - 3) * 7),
      distanceKilometers: 0,
      movingTimeSeconds: 0,
      activityCount: 0,
    }));
    let cursor: Record<string, AttributeValue> | undefined;
    do {
      const response = await dynamodb.send(new QueryCommand({
        TableName: settings.DYNAMODB_TABLE_NAME,
        ConsistentRead: true,
        KeyConditionExpression: "PK = :user AND SK BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":user": { S: `USER#${userId}` },
          ":from": { S: `${prefix}${weeks[0]!.startDate}#` },
          ":to": { S: `${prefix}${monday}#~` },
        },
        ProjectionExpression: "SK, distance, movingTime, activityCount",
        ExclusiveStartKey: cursor,
      }));
      for (const item of response.Items ?? []) {
        const week = weeks.find((entry) => item.SK?.S?.startsWith(`${prefix}${entry.startDate}#`));
        if (!week) continue;
        week.distanceKilometers += Number(item.distance?.N ?? 0) / 1000;
        week.movingTimeSeconds += Number(item.movingTime?.N ?? 0);
        week.activityCount += Number(item.activityCount?.N ?? 0);
      }
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    return {
      period: "current_calendar_week_and_three_previous",
      calendarTimeZone: "UTC",
      currentWeekIsPartial: true,
      weeks,
      totalMovingTimeSeconds: weeks.reduce((sum, week) => sum + week.movingTimeSeconds, 0),
    };
  };
  const metricReader = createDailyMetricReader(
    {
      get: (command) => dynamodb.send(command),
      query: (command) => dynamodb.send(command),
      artifacts: createArtifactStore(
        {
          get: (command) => dynamodb.send(command),
          query: (command) => dynamodb.send(command),
          transact: (command) => dynamodb.send(command),
        },
        settings.DYNAMODB_TABLE_NAME,
      ),
      encryption: createEnvelopeEncryption(
        {
          generate: (command) => kms.send(command),
          decrypt: (command) => kms.send(command),
        },
        settings.DYNAMODB_KMS_KEY_ARN,
      ),
    },
    settings.DYNAMODB_TABLE_NAME,
  );
  const [activity, dailyMetrics] = await Promise.all([
    connections.then(async ([strava, garmin]) => {
      const provider = activityProvider({ strava, garmin });
      const [workouts, trainingLoad] = await Promise.all([
        provider ? createWorkoutStore(
          {
            query: (command) => dynamodb.send(command),
            batchGet: (command) => dynamodb.send(command),
          },
          settings.DYNAMODB_TABLE_NAME,
        ).recent(userId, provider) : Promise.resolve([]),
        provider ? readLoad(provider) : Promise.resolve(null),
      ]);
      return {
        activitySource: provider,
        trainingLoad,
        recentWorkouts: workouts.slice(0, 5).map((workout) => ({
          date: workout.startedAt,
          sport: workout.sport,
          name: workout.name,
          distanceMeters: workout.distance,
          movingTimeSeconds: workout.movingTime,
          elevationGainMeters: workout.elevationGain,
          averageHeartRateBpm: workout.averageHeartRate ?? null,
          maximumHeartRateBpm: workout.maximumHeartRate ?? null,
          averagePowerWatts: workout.averagePower ?? null,
          maximumPowerWatts: workout.maximumPower ?? null,
          zoneDistributionScope: "zones_1_to_5_only",
          heartRateZones: workout.heartRateZones ?? null,
          powerZones: workout.powerZones ?? null,
        })),
      };
    }),
    connections.then(async ([, garmin]) => {
      if (!garmin?.active || !garmin.scopes.includes("HEALTH_EXPORT")) return [];
      const dates = Array.from({ length: 14 }, (_, index) => shiftDate(today, index - 13));
      const metrics: { date: string; metric: Awaited<ReturnType<typeof metricReader>>; readFailed: boolean }[] = [];
      for (let offset = 0; offset < dates.length; offset += 4) {
        metrics.push(...await Promise.all(dates.slice(offset, offset + 4).map(async (date) => {
          try {
            return { date, metric: await metricReader(userId, date), readFailed: false };
          } catch {
            return { date, metric: null, readFailed: true };
          }
        })));
      }
      return metrics;
    }),
  ]);
  onRecovery?.();
  const current = dailyMetrics.find((entry) => entry.date === today)?.metric;
  const baselineDays = dailyMetrics.filter((entry) => entry.date !== today);
  const hrvBaseline = average(baselineDays.map((entry) => entry.metric?.values.hrvLastNightAverage));
  const restingHeartRateBaseline = average(baselineDays.map((entry) => entry.metric?.values.restingHeartRate));
  return {
    ...activity,
    healthMetrics: current ? { date: current.date, ...current.values } : null,
    recoveryTrend: {
      timeZone: "Europe/Warsaw",
      startDate: shiftDate(today, -13),
      endDate: today,
      hrvBaseline,
      restingHeartRateBaseline,
      restingHeartRateDeviationBpm: current?.values.restingHeartRate !== undefined && restingHeartRateBaseline.value !== null
        ? current.values.restingHeartRate - restingHeartRateBaseline.value : null,
      days: dailyMetrics.map(({ date, metric, readFailed }) => ({ date, values: metric?.values ?? null, readFailed })),
      bodyBatterySeries: dailyMetrics.map(({ date, metric }) => ({
        date,
        value: metric?.values.bodyBattery ?? null,
        measuredAt: metric?.values.bodyBatteryMeasuredAt ?? null,
      })),
    },
  };
}