import { GetItemCommand, TransactionCanceledException, type GetItemCommandOutput } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { ArtifactRevisionConflict, type createArtifactStore } from "./artifacts";
import { dailyMetricSchema, dailyValuesSchema, calendarDateSchema, mergeDailyMetric, projectDailyMetric, type DailyFragment } from "./daily-metrics";
import type { ImportedDailyMetric } from "./import-health";
import type { createEnvelopeEncryption } from "./encryption";
import type { GarminRecord } from "./payload";
import type { Connection } from "../strava-worker/processor";

type Dependencies = {
  get: (command: GetItemCommand) => Promise<Pick<GetItemCommandOutput, "Item">>;
  artifacts: ReturnType<typeof createArtifactStore>;
  encryption: ReturnType<typeof createEnvelopeEncryption>;
};
export function createDailyMetricStore(dependencies: Dependencies, table: string) {
  async function saveFragment(userId: string, fragment: DailyFragment, consent?: { encryptedTokens: string; permission: string }) {
      const PK = `USER#${userId}`;
      const SK = `METRIC#${fragment.date}`;
      const context = { provider: "garmin", userId, purpose: "daily-metrics" };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await dependencies.get(new GetItemCommand({ TableName: table, Key: marshall({ PK, SK }), ConsistentRead: true }));
        const manifest = response.Item;
        const revision = manifest?.revision?.S ?? null;
        const previous = manifest && revision ? dailyMetricSchema.parse(await dependencies.encryption.decrypt(await dependencies.artifacts.read(PK, SK, revision, Number(manifest.partCount?.N)), context)) : null;
        const merged = mergeDailyMetric(previous, fragment);
        if (!merged) return false;
        const receipt = Math.max(fragment.receivedAt, Number(manifest?.receivedAt?.N ?? 0));
        try {
          return await dependencies.artifacts.put(PK, SK, merged, () => dependencies.encryption.encrypt(merged, context), {
            entityType: "GARMIN_METRIC", provider: "garmin", date: fragment.date,
            GSI1PK: PK, GSI1SK: SK,
            ...(fragment.type === "import" || manifest?.imported?.BOOL ? { imported: true } : {}),
          }, receipt, undefined, consent, { revision });
        } catch (error) {
          const manifestConflict = error instanceof TransactionCanceledException && error.CancellationReasons?.[consent ? 1 : 0]?.Code === "ConditionalCheckFailed";
          if (!(error instanceof ArtifactRevisionConflict) && !manifestConflict) throw error;
          if (attempt === 2) throw error;
        }
      }
      return false;
  }
  return {
    async save(connection: Connection, type: string, record: GarminRecord, receivedAt: number) {
      const fragment = projectDailyMetric(type, record, receivedAt);
      if (!fragment) return false;
      if (!connection.active || !connection.scopes.includes("HEALTH_EXPORT") || record.userId !== connection.athleteId) throw new Error("Garmin daily metric consent is missing");
      return saveFragment(connection.userId, fragment, { encryptedTokens: connection.encryptedTokens, permission: "HEALTH_EXPORT" });
    },
    async import(userId: string, metric: ImportedDailyMetric) {
      return saveFragment(userId, { date: calendarDateSchema.parse(metric.date), type: "import",
        receivedAt: 0, values: dailyValuesSchema.parse(metric.values) });
    },
  };
}