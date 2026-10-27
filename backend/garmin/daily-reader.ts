import { GetItemCommand, QueryCommand, type GetItemCommandOutput, type QueryCommandOutput } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { calendarDateSchema, dailyMetricSchema } from "./daily-metrics";
import type { createArtifactStore } from "./artifacts";
import type { createEnvelopeEncryption } from "./encryption";

type Dependencies = {
  get: (command: GetItemCommand) => Promise<Pick<GetItemCommandOutput, "Item">>;
  query: (command: QueryCommand) => Promise<Pick<QueryCommandOutput, "Items" | "LastEvaluatedKey">>;
  artifacts: Pick<ReturnType<typeof createArtifactStore>, "read">;
  encryption: Pick<ReturnType<typeof createEnvelopeEncryption>, "decrypt">;
};
export function createDailyMetricReader(dependencies: Dependencies, table: string) {
  return async (userId: string, requestedDate?: string, importOnly = false) => {
    const PK = `USER#${userId}`;
    let date = requestedDate === undefined ? undefined : calendarDateSchema.parse(requestedDate);
    if (!date) {
      const now = Date.now();
      const cutoff = now - 36 * 60 * 60 * 1000;
      const localDateRangeStart = new Date(cutoff - 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const localDateRangeEnd = new Date(now + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
      let cursor: QueryCommandOutput["LastEvaluatedKey"];
      let latestReceivedAt = 0;
      do {
        const latest = await dependencies.query(new QueryCommand({ TableName: table, ConsistentRead: true,
          KeyConditionExpression: importOnly
            ? "PK = :user AND begins_with(SK, :metric)"
            : "PK = :user AND SK BETWEEN :from AND :to",
          FilterExpression: importOnly
            ? "entityType = :type AND imported = :imported"
            : "entityType = :type AND receivedAt BETWEEN :cutoff AND :now",
          ExpressionAttributeValues: marshall({
            ":user": PK,
            ":type": "GARMIN_METRIC",
            ...(importOnly
              ? { ":metric": "METRIC#", ":imported": true }
              : {
                ":from": `METRIC#${localDateRangeStart}`,
                ":to": `METRIC#${localDateRangeEnd}#~`,
                ":cutoff": cutoff,
                ":now": now,
              }),
          }),
          ScanIndexForward: false, Limit: 25, ExclusiveStartKey: cursor,
        }));
        for (const item of latest.Items ?? []) {
          if (item.PK?.S !== PK || !item.SK?.S?.startsWith("METRIC#")) throw new Error("Metric ownership mismatch");
          const itemDate = calendarDateSchema.parse(item.SK.S.slice("METRIC#".length));
          if (importOnly) {
            if (!date || itemDate > date) date = itemDate;
            continue;
          }
          const receivedAt = Number(item.receivedAt?.N ?? 0);
          if (receivedAt >= cutoff && receivedAt <= now && receivedAt > latestReceivedAt) {
            latestReceivedAt = receivedAt;
            date = itemDate;
          }
        }
        cursor = latest.LastEvaluatedKey;
      } while (cursor);
      if (!date) return null;
    }
    const SK = `METRIC#${date}`;
    const response = await dependencies.get(new GetItemCommand({ TableName: table, Key: marshall({ PK, SK }), ConsistentRead: true }));
    const manifest = response.Item;
    if (!manifest) return null;
    if (importOnly && !manifest.imported?.BOOL) return null;
    if (manifest.entityType?.S !== "GARMIN_METRIC" || manifest.provider?.S !== "garmin" || !manifest.revision?.S) throw new Error("Invalid daily metric manifest");
    const encrypted = await dependencies.artifacts.read(PK, SK, manifest.revision.S, Number(manifest.partCount?.N));
    const metric = dailyMetricSchema.parse(await dependencies.encryption.decrypt(encrypted, { userId, provider: "garmin", purpose: "daily-metrics" }));
    if (metric.date !== date) throw new Error("Daily metric date mismatch");
    return { date: metric.date, provider: metric.provider, values: importOnly ? metric.sources?.import?.values ?? {} : metric.values ?? {} };
  };
}