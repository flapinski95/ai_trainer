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
    source: "HISTORY" | "WEBHOOK" | "IMPORT",
    detail = false,
    provider: Provider = "strava",
    notify = false,
  ) => {
    if (source === "IMPORT" && provider !== "garmin")
      throw new Error("Manual import is only supported for Garmin");
    const history = source !== "WEBHOOK";
    const timestampKey = incoming ? {
      PK: `USER#${connection.userId}`, SK: `WORKOUT_TIMESTAMP#${new Date(incoming.start_date).toISOString()}`,
    } : null;
    if (source === "IMPORT" && timestampKey) {
      const existing = await dependencies.get(new GetItemCommand({
        TableName: tableName, Key: marshall(timestampKey), ConsistentRead: true,
      }));
      if (existing.Item?.hasStrava?.BOOL || existing.Item?.hasGarminPush?.BOOL) return false;
    }
    const alias = provider === "garmin" ? {
      PK: `USER#${connection.userId}`, SK: `WORKOUT_ALIAS#GARMIN#${activityId}`,
    } : null;
    let missingLink = false;
    if (alias) {
      const existing = await dependencies.get(new GetItemCommand({
        TableName: tableName, Key: marshall(alias), ConsistentRead: true,
      }));
      if (existing.Item?.entityType?.S === "WORKOUT_ALIAS" && existing.Item.activityId?.S)
        activityId = existing.Item.activityId.S;
      else if (incoming) missingLink = true;
    }
    const identity = provider === "garmin" && incoming ? {
      PK: `USER#${connection.userId}`,
      SK: `WORKOUT_IDENTITY#GARMIN#${new Date(incoming.start_date).toISOString()}#${incoming.sport_type}`,
    } : null;
    if (identity) {
      const existing = await dependencies.get(new GetItemCommand({
        TableName: tableName, Key: marshall(identity), ConsistentRead: true,
      }));
      const canonical = existing.Item?.entityType?.S === "WORKOUT_IDENTITY" ? existing.Item.activityId?.S : undefined;
      if (canonical) activityId = canonical;
      else missingLink = true;
    }
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
    if (previous && history && previous.status === "DELETED")
      return false;
    const oldParsed =
      previous?.status === "ACTIVE"
        ? workoutMetricsSchema.safeParse(previous)
        : null;
    const oldActivity = oldParsed?.success ? oldParsed.data : null;
    if (previous?.status === "ACTIVE" && !oldActivity)
      throw new Error("Stored workout cannot be safely aggregated");
    let activity = incoming;
    let savedSource: "HISTORY" | "WEBHOOK" = history ? "HISTORY" : "WEBHOOK";
    if (history && previous) {
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
    const detailChanged = source === "IMPORT" && previous?.detailLevel !== (detail ? "DETAIL" : "SUMMARY");
    if (previous?.summaryVersion === 1 && previous.metricsHash === hash && !missingLink && !detailChanged)
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
        history ? Number(previous?.eventTime ?? 0) : eventTime,
      source: savedSource,
      detailLevel:
        source === "IMPORT" ? detail ? "DETAIL" : "SUMMARY"
          : detail || previous?.detailLevel === "DETAIL" ? "DETAIL" : "SUMMARY",
      ...(source === "IMPORT" || previous?.manualImport ? { manualImport: true } : {}),
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
          ...(source === "IMPORT" && timestampKey ? [{ ConditionCheck: {
            TableName: tableName, Key: marshall(timestampKey),
            ConditionExpression: "attribute_not_exists(hasStrava) AND attribute_not_exists(hasGarminPush)",
          } }] : []),
          ...(source === "IMPORT" ? [] : [{
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
          }]),
          ...(alias && incoming ? [{ Put: {
            TableName: tableName,
            Item: marshall({ ...alias, entityType: "WORKOUT_ALIAS", activityId: String(activityId) }),
            ConditionExpression: "attribute_not_exists(PK) OR activityId = :activityId",
            ExpressionAttributeValues: marshall({ ":activityId": String(activityId) }),
          } }] : []),
          ...(identity ? [{ Put: {
            TableName: tableName,
            Item: marshall({ ...identity, entityType: "WORKOUT_IDENTITY", activityId: String(activityId) }),
            ConditionExpression: "attribute_not_exists(PK) OR activityId = :activityId",
            ExpressionAttributeValues: marshall({ ":activityId": String(activityId) }),
          } }] : []),
          { Put: write },
          ...(notify && source === "WEBHOOK" && !previous && activity ? [{ Put: {
            TableName: tableName,
            Item: marshall({
              PK: key.PK,
              SK: `PUSH_JOB#${provider.toUpperCase()}#${activityId}`,
              entityType: "PUSH_WORKOUT_JOB",
              userId: connection.userId,
              provider,
              activityId: String(activityId),
              state: "QUEUED",
              createdAt: now,
            }),
            ConditionExpression: "attribute_not_exists(PK)",
          } }] : []),
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
          ...(timestampKey && (provider === "strava" || source === "WEBHOOK") ? [{ Update: {
            TableName: tableName, Key: marshall(timestampKey),
            UpdateExpression: "SET entityType = :type, #provider = :present",
            ExpressionAttributeNames: { "#provider": provider === "strava" ? "hasStrava" : "hasGarminPush" },
            ExpressionAttributeValues: marshall({ ":type": "WORKOUT_TIMESTAMP", ":present": true }),
          } }] : []),
        ],
      }),
    );
    return true;
  };
}
