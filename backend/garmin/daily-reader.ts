import { GetItemCommand, QueryCommand, type GetItemCommandOutput, type QueryCommandOutput } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { calendarDateSchema, dailyMetricSchema } from "./daily-metrics";
import type { createArtifactStore } from "./artifacts";
import type { createEnvelopeEncryption } from "./encryption";

type Dependencies = {
  get: (command: GetItemCommand) => Promise<Pick<GetItemCommandOutput, "Item">>;
  query: (command: QueryCommand) => Promise<Pick<QueryCommandOutput, "Items">>;
  artifacts: Pick<ReturnType<typeof createArtifactStore>, "read">;
  encryption: Pick<ReturnType<typeof createEnvelopeEncryption>, "decrypt">;
};
export function createDailyMetricReader(dependencies: Dependencies, table: string) {
  return async (userId: string, requestedDate?: string) => {
    const PK = `USER#${userId}`;
    let date = requestedDate === undefined ? undefined : calendarDateSchema.parse(requestedDate);
    if (!date) {
      const latest = await dependencies.query(new QueryCommand({ TableName: table, IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :user AND begins_with(GSI1SK, :metric)",
        ExpressionAttributeValues: marshall({ ":user": PK, ":metric": "METRIC#" }), ScanIndexForward: false, Limit: 1,
      }));
      const item = latest.Items?.[0];
      if (!item) return null;
      if (item.PK?.S !== PK || !item.SK?.S?.startsWith("METRIC#")) throw new Error("Metric ownership mismatch");
      date = calendarDateSchema.parse(item.SK.S.slice("METRIC#".length));
    }
    const SK = `METRIC#${date}`;
    const response = await dependencies.get(new GetItemCommand({ TableName: table, Key: marshall({ PK, SK }), ConsistentRead: true }));
    const manifest = response.Item;
    if (!manifest) return null;
    if (manifest.entityType?.S !== "GARMIN_METRIC" || manifest.provider?.S !== "garmin" || !manifest.revision?.S) throw new Error("Invalid daily metric manifest");
    const encrypted = await dependencies.artifacts.read(PK, SK, manifest.revision.S, Number(manifest.partCount?.N));
    const metric = dailyMetricSchema.parse(await dependencies.encryption.decrypt(encrypted, { userId, provider: "garmin", purpose: "daily-metrics" }));
    if (metric.date !== date) throw new Error("Daily metric date mismatch");
    return { date: metric.date, provider: metric.provider, values: metric.values ?? {} };
  };
}