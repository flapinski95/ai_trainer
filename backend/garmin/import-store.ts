import { createHash, randomUUID } from "node:crypto";
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, TransactionCanceledException,
  type GetItemCommandOutput, type QueryCommandOutput } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeWorkoutTelemetry, GarminImportError, type ImportedWorkout, type parseGarminImport } from "./import";
import { isWithinDetailWindow } from "../history/model";
import type { createArtifactStore } from "./artifacts";
import type { createEnvelopeEncryption } from "./encryption";
import type { createDailyMetricStore } from "./daily-store";
import { createWorkoutWriter } from "../workouts/persist";

type Dependencies = {
  get: (command: GetItemCommand) => Promise<Pick<GetItemCommandOutput, "Item">>;
  query: (command: QueryCommand) => Promise<Pick<QueryCommandOutput, "Items" | "LastEvaluatedKey">>;
  transact: (command: TransactWriteItemsCommand) => Promise<unknown>;
  artifacts: ReturnType<typeof createArtifactStore>;
  encryption: ReturnType<typeof createEnvelopeEncryption>;
  daily: Pick<ReturnType<typeof createDailyMetricStore>, "import">;
};
export type StoredImportWorkout = {
  id: string; provider: string; timestamp: string; source: string;
  manual: boolean; detailLevel: string;
};
export class GarminImportBusyError extends Error {}

export function planGarminImport(existing: StoredImportWorkout[], workouts: ImportedWorkout[], cutoff = Math.floor(Date.now() / 1000)) {
  const protectedTimes = new Set(existing.filter((entry) => entry.provider === "strava" || entry.source === "WEBHOOK").map((entry) => entry.timestamp));
  const importedIds = new Map(existing.filter((entry) => entry.provider === "garmin" && entry.manual).map((entry) => [entry.timestamp, entry.id]));
  const seen = new Set<string>();
  let duplicates = 0;
  const accepted = workouts.filter((workout) => {
    const timestamp = new Date(workout.metrics.start_date).toISOString();
    if (protectedTimes.has(timestamp) || seen.has(timestamp)) { duplicates += 1; return false; }
    seen.add(timestamp);
    return true;
  }).map((workout) => ({ workout, id: importedIds.get(new Date(workout.metrics.start_date).toISOString()) ?? workout.id }));
  const detailedTimes = new Set([...existing.map((entry) => entry.timestamp), ...accepted.map(({ workout }) => new Date(workout.metrics.start_date).toISOString())]
    .filter((timestamp) => isWithinDetailWindow(timestamp, cutoff)));
  return { accepted, duplicates, detailedTimes };
}

export function createGarminImportStore(dependencies: Dependencies, table: string) {
  const writer = createWorkoutWriter(dependencies, table);
  return async (userId: string, parsed: ReturnType<typeof parseGarminImport>, progress: (count: number) => void = () => {}) => {
    const PK = `USER#${userId}`;
    const lock = { PK, SK: "LOCK#GARMIN_IMPORT" };
    const token = randomUUID();
    try {
      await dependencies.transact(new TransactWriteItemsCommand({ TransactItems: [{ Put: {
        TableName: table, Item: marshall({ ...lock, token, expiresAt: Math.floor(Date.now() / 1000) + 600 }),
        ConditionExpression: "attribute_not_exists(PK) OR expiresAt < :now",
        ExpressionAttributeValues: marshall({ ":now": Math.floor(Date.now() / 1000) }),
      } }] }));
    } catch (error) {
      if (error instanceof TransactionCanceledException && error.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed")
        throw new GarminImportBusyError("Import Garmina juz trwa. Sprobuj ponownie po jego zakonczeniu.");
      throw error;
    }
    const locked = () => ({ ConditionCheck: { TableName: table, Key: marshall(lock),
      ConditionExpression: "#token = :token AND expiresAt >= :now", ExpressionAttributeNames: { "#token": "token" },
      ExpressionAttributeValues: marshall({ ":token": token, ":now": Math.floor(Date.now() / 1000) }),
    } });
    const list = async (prefix: string, projection?: string) => {
      const rows: Record<string, import("@aws-sdk/client-dynamodb").AttributeValue>[] = [];
      let cursor: QueryCommandOutput["LastEvaluatedKey"];
      do {
        const result = await dependencies.query(new QueryCommand({ TableName: table, ConsistentRead: true,
          KeyConditionExpression: "PK = :user AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: marshall({ ":user": PK, ":prefix": prefix }),
          ProjectionExpression: projection, ExclusiveStartKey: cursor,
        }));
        rows.push(...result.Items ?? []);
        cursor = result.LastEvaluatedKey;
      } while (cursor);
      return rows;
    };
    const remove = async (keys: { PK: string; SK: string }[]) => {
      for (let offset = 0; offset < keys.length; offset += 24) {
        await dependencies.transact(new TransactWriteItemsCommand({ TransactItems: [locked(),
          ...keys.slice(offset, offset + 24).map((key) => ({ Delete: { TableName: table, Key: marshall(key) } })),
        ] }));
      }
    };
    const telemetryKey = (id: string) => `TELEMETRY#GARMIN#${id}`;
    const removeTelemetry = async (id: string) => {
      const root = telemetryKey(id);
      const rows = await list(root, "PK, SK");
      await remove(rows.filter((row) => row.SK?.S === root || row.SK?.S?.startsWith(`${root}#`))
        .map((row) => ({ PK, SK: row.SK!.S! })));
      await remove([{ PK, SK: `TELEMETRY_INDEX#GARMIN#${id}` }]);
    };
    const saveTelemetry = async (id: string, workout: ImportedWorkout) => {
      const value = Buffer.from(JSON.stringify(decodeWorkoutTelemetry(workout), (_key, field: unknown) => typeof field === "bigint" ? field.toString() : field));
      if (value.length > 64 * 1024 * 1024) throw new GarminImportError("Telemetria jednego treningu przekracza 64 MB po dekodowaniu.");
      const hash = createHash("sha256").update(value).digest("hex");
      const SK = telemetryKey(id);
      const segmentPrefix = `${SK}#VERSION#${hash}#SEGMENT#`;
      await dependencies.transact(new TransactWriteItemsCommand({ TransactItems: [locked(), { Put: {
        TableName: table, Item: marshall({ PK, SK: `TELEMETRY_INDEX#GARMIN#${id}`,
          entityType: "GARMIN_TELEMETRY_INDEX", activityId: id, start_date: workout.metrics.start_date }),
      } }] }));
      const context = { userId, provider: "garmin", purpose: "workout-telemetry", activityId: id };
      const segmentCount = Math.ceil(value.length / (1024 * 1024));
      for (let segment = 0; segment < segmentCount; segment += 1) {
        const data = { data: value.subarray(segment * 1024 * 1024, (segment + 1) * 1024 * 1024).toString("base64") };
        await dependencies.artifacts.put(PK, `${segmentPrefix}${String(segment).padStart(5, "0")}`, data,
          () => dependencies.encryption.encrypt(data, context), { entityType: "GARMIN_TELEMETRY_SEGMENT", provider: "garmin" }, 0);
      }
      const descriptor = { version: 1, encoding: "json-utf8-base64", segmentPrefix, segmentCount, hash };
      await dependencies.artifacts.put(PK, SK, descriptor, () => dependencies.encryption.encrypt(descriptor, context), {
        entityType: "GARMIN_TELEMETRY", provider: "garmin", activityId: id,
        start_date: workout.metrics.start_date, segmentPrefix,
      }, 0);
      const current = await dependencies.get(new GetItemCommand({ TableName: table, Key: marshall({ PK, SK }), ConsistentRead: true }));
      const revision = current.Item?.revision?.S;
      const rows = await list(`${SK}#`, "PK, SK");
      await remove(rows.filter((row) => !row.SK?.S?.startsWith(segmentPrefix) && !row.SK?.S?.startsWith(`${SK}#PART#${revision}#`))
        .map((row) => ({ PK, SK: row.SK!.S! })));
    };
    let imported = 0;
    let unchanged = 0;
    let metricsImported = 0;
    let detailed = 0;
    let summaries = 0;
    try {
      const existing: StoredImportWorkout[] = [];
      for (const row of await list("ACTIVITY#")) {
        const item = unmarshall(row);
        if (item.entityType !== "WORKOUT" || item.status !== "ACTIVE" || typeof item.start_date !== "string" || !Number.isFinite(Date.parse(item.start_date))) continue;
        existing.push({ id: String(item.activityId), provider: String(item.provider), timestamp: new Date(item.start_date).toISOString(),
          source: String(item.source), manual: item.manualImport === true || String(item.activityId).startsWith("fit-"), detailLevel: String(item.detailLevel) });
      }
      const plan = planGarminImport(existing, parsed.workouts);
      const roots = await list("TELEMETRY_INDEX#GARMIN#");
      for (const row of roots) {
        if (row.activityId?.S && (!row.start_date?.S || !plan.detailedTimes.has(new Date(row.start_date.S).toISOString())))
          await removeTelemetry(row.activityId.S);
      }
      for (const entry of existing.filter((entry) => entry.provider === "garmin" && entry.manual && !plan.detailedTimes.has(entry.timestamp) && entry.detailLevel === "DETAIL")) {
        await dependencies.transact(new TransactWriteItemsCommand({ TransactItems: [locked(), { Update: {
          TableName: table, Key: marshall({ PK, SK: `ACTIVITY#GARMIN#${entry.id}` }),
          UpdateExpression: "SET detailLevel = :summary", ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: marshall({ ":summary": "SUMMARY" }),
        } }] }));
      }
      if (parsed.workouts.length) await dependencies.transact(new TransactWriteItemsCommand({ TransactItems: [locked(), { Put: {
        TableName: table, Item: marshall({ PK, SK: "IMPORT#GARMIN", entityType: "GARMIN_IMPORT", startedAt: new Date().toISOString() }),
      } }] }));
      const connection = { userId, athleteId: userId, active: true, scopes: [], encryptedTokens: "", expiresAt: 0, authorizedAt: new Date().toISOString() };
      for (const { workout, id } of plan.accepted) {
        const hasDetail = plan.detailedTimes.has(new Date(workout.metrics.start_date).toISOString());
        let saved: boolean;
        try {
          saved = await writer(connection, id, 0, workout.metrics, "IMPORT", hasDetail, "garmin");
        } catch (error) {
          if (error instanceof TransactionCanceledException && error.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") {
            plan.duplicates += 1;
            continue;
          }
          throw error;
        }
        if (saved) { imported += 1; progress(imported); }
        const timestamp = await dependencies.get(new GetItemCommand({ TableName: table,
          Key: marshall({ PK, SK: `WORKOUT_TIMESTAMP#${new Date(workout.metrics.start_date).toISOString()}` }), ConsistentRead: true }));
        if (timestamp.Item?.hasStrava?.BOOL || timestamp.Item?.hasGarminPush?.BOOL) {
          plan.duplicates += 1;
          continue;
        }
        const current = await dependencies.get(new GetItemCommand({ TableName: table,
          Key: marshall({ PK, SK: `ACTIVITY#GARMIN#${id}` }), ConsistentRead: true }));
        if (current.Item?.status?.S !== "ACTIVE" || current.Item?.source?.S === "WEBHOOK") {
          plan.duplicates += 1;
          continue;
        }
        if (!saved) unchanged += 1;
        if (hasDetail) { await saveTelemetry(id, workout); detailed += 1; }
        else { await removeTelemetry(id); summaries += 1; }
      }
      for (const metric of parsed.dailyMetrics) {
        if (await dependencies.daily.import(userId, metric)) metricsImported += 1;
      }
      return { imported, unchanged, duplicates: plan.duplicates, metricsImported, detailed, summaries, skipped: parsed.skipped };
    } finally {
      try {
        await dependencies.transact(new TransactWriteItemsCommand({ TransactItems: [{ Delete: {
          TableName: table, Key: marshall(lock), ConditionExpression: "#token = :token",
          ExpressionAttributeNames: { "#token": "token" }, ExpressionAttributeValues: marshall({ ":token": token }),
        } }] }));
      } catch (error) {
        console.error("garmin_import_lock_release_failed", { type: error instanceof Error ? error.name : "UnknownError" });
      }
    }
  };
}