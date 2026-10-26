import { randomUUID } from "node:crypto";
import {
  GetItemCommand,
  TransactWriteItemsCommand,
  type GetItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { Connection } from "../strava-worker/processor";
import {
  contributions,
  fingerprint,
  metrics,
  workoutMetricsSchema,
  type WorkoutMetrics,
  type Contribution,
} from "../history/model";
import type { Provider } from "../providers/policy";

type Dependencies = {
  get: (command: GetItemCommand) => Promise<Pick<GetItemCommandOutput, "Item">>;
  transact: (command: TransactWriteItemsCommand) => Promise<unknown>;
};

export function createWorkoutWriter(
  dependencies: Dependencies,
  tableName: string,
) {
  return async (
    connection: Connection,
    activityId: number | string,
    eventTime: number,
    incoming: WorkoutMetrics | null,
    source: "HISTORY" | "WEBHOOK",
    detail = false,
    provider: Provider = "strava",
  ) => {
    const key = {
      PK: `USER#${connection.userId}`,
      SK: `ACTIVITY#${provider.toUpperCase()}#${activityId}`,
    };
    const response = await dependencies.get(
      new GetItemCommand({
        TableName: tableName,
        Key: marshall(key),
        ConsistentRead: true,
      }),
    );
    const previous = response.Item ? unmarshall(response.Item) : undefined;
    if (
      previous &&
      source === "WEBHOOK" &&
      Number(previous.eventTime) > eventTime
    )
      return false;
    if (previous && source === "HISTORY" && previous.status === "DELETED")
      return false;
    const oldParsed =
      previous?.status === "ACTIVE"
        ? workoutMetricsSchema.safeParse(previous)
        : null;
    const oldActivity = oldParsed?.success ? oldParsed.data : null;
    if (previous?.status === "ACTIVE" && !oldActivity)
      throw new Error("Stored workout cannot be safely aggregated");
    let activity = incoming;
    let savedSource = source;
    if (source === "HISTORY" && previous) {
      if (previous.source !== "HISTORY") {
        if (previous.summaryVersion === 1) return false;
        activity = oldActivity;
        savedSource = "WEBHOOK";
      } else if (incoming && oldActivity) {
        activity = workoutMetricsSchema.parse({
          ...oldActivity,
          ...Object.fromEntries(
            Object.entries(incoming).filter(([, value]) => value !== undefined),
          ),
        });
      }
    }
    const hash = activity ? fingerprint(activity) : "DELETED";
    if (previous?.summaryVersion === 1 && previous.metricsHash === hash)
      return false;
    const delta = new Map<string, Contribution>();
    const add = (entry: Contribution, direction: number) => {
      const current = delta.get(entry.key) ?? {
        key: entry.key,
        count: 0,
        distance: 0,
        movingTime: 0,
        elapsedTime: 0,
        elevation: 0,
      };
      for (const field of [
        "count",
        "distance",
        "movingTime",
        "elapsedTime",
        "elevation",
      ] as const)
        current[field] += direction * entry[field];
      delta.set(entry.key, current);
    };
    if (previous?.summaryVersion === 1 && oldActivity)
      for (const entry of contributions(oldActivity)) add(entry, -1);
    if (activity) for (const entry of contributions(activity)) add(entry, 1);
    const now = new Date().toISOString();
    const revision = randomUUID();
    const item = {
      ...key,
      entityType: "WORKOUT",
      provider,
      activityId: String(activityId),
      eventTime:
        source === "HISTORY" ? Number(previous?.eventTime ?? 0) : eventTime,
      source: savedSource,
      detailLevel:
        detail || previous?.detailLevel === "DETAIL" ? "DETAIL" : "SUMMARY",
      status: activity ? "ACTIVE" : "DELETED",
      summaryVersion: 1,
      metricsHash: hash,
      revision,
      updatedAt: now,
      ...(activity
        ? {
            ...metrics(activity),
            GSI1PK: key.PK,
            GSI1SK: `ACTIVITY#${new Date(activity.start_date).toISOString()}#${provider.toUpperCase()}#${activityId}`,
          }
        : {}),
    };
    const write = {
      TableName: tableName,
      Item: marshall(item, { removeUndefinedValues: true }),
      ConditionExpression: !previous
        ? "attribute_not_exists(PK)"
        : previous.revision
          ? "revision = :previous"
          : "attribute_exists(PK) AND attribute_not_exists(revision) AND eventTime = :previous",
      ...(previous
        ? {
            ExpressionAttributeValues: marshall({
              ":previous": previous.revision ?? previous.eventTime,
            }),
          }
        : {}),
    };
    await dependencies.transact(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: marshall({
                PK: key.PK,
                SK: `CONNECTION#${provider.toUpperCase()}`,
              }),
              ConditionExpression:
                "#status = :active AND encryptedTokens = :tokens",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: marshall({
                ":active": "ACTIVE",
                ":tokens": connection.encryptedTokens,
              }),
            },
          },
          { Put: write },
          ...[...delta.values()]
            .filter((entry) =>
              [
                entry.count,
                entry.distance,
                entry.movingTime,
                entry.elapsedTime,
                entry.elevation,
              ].some((value) => value !== 0),
            )
            .map((entry) => ({
              Update: {
                TableName: tableName,
                Key: marshall({
                  PK: key.PK,
                  SK:
                    provider === "garmin"
                      ? entry.key.replace("SUMMARY#", "SUMMARY#GARMIN#")
                      : entry.key,
                }),
                UpdateExpression:
                  "SET entityType = :type, updatedAt = :now ADD activityCount :count, distance :distance, movingTime :moving, elapsedTime :elapsed, elevation :elevation",
                ExpressionAttributeValues: marshall({
                  ":type": "TRAINING_SUMMARY",
                  ":now": now,
                  ":count": entry.count,
                  ":distance": entry.distance,
                  ":moving": entry.movingTime,
                  ":elapsed": entry.elapsedTime,
                  ":elevation": entry.elevation,
                }),
              },
            })),
        ],
      }),
    );
    return true;
  };
}
