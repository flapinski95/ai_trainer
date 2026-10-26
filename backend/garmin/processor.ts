import {
  categorySchema,
  payloadSchema,
  type GarminCategory,
  type GarminRecord,
} from "./payload";
import { normalizeGarminActivity } from "./activity";
import { GarminRevokedError } from "./access";
import type { Connection } from "../strava-worker/processor";
import type { WorkoutMetrics } from "../history/model";

type Dependencies = {
  connection: (externalId: string) => Promise<Connection | null>;
  verify: (connection: Connection) => Promise<Connection>;
  revoke: (connection: Connection) => Promise<void>;
  saveRecord: (
    connection: Connection,
    category: GarminCategory,
    type: string,
    record: GarminRecord,
  ) => Promise<void>;
  saveActivity: (
    connection: Connection,
    id: string,
    metrics: WorkoutMetrics,
    notify?: boolean,
  ) => Promise<void>;
  saveDailyMetric?: (connection: Connection, type: string, record: GarminRecord) => Promise<void>;
};
export function createGarminProcessor(dependencies: Dependencies) {
  const connections = new Map<string, Connection | null>();
  return async (
    category: GarminCategory,
    type: string,
    record: GarminRecord,
  ) => {
    categorySchema.parse(category);
    let connection = connections.get(record.userId);
    if (connection === undefined) {
      const stored = await dependencies.connection(record.userId);
      if (!stored || !stored.active) {
        connections.set(record.userId, null);
        return;
      }
      try {
        connection = await dependencies.verify(stored);
      } catch (error) {
        if (!(error instanceof GarminRevokedError)) throw error;
        await dependencies.revoke(stored);
        connections.set(record.userId, null);
        return;
      }
      if (connection.athleteId !== record.userId)
        throw new Error("Garmin push ownership mismatch");
      connections.set(record.userId, connection);
    }
    if (!connection) return;
    if (category === "deregistration" || category === "permissions") return;
    const permission =
      category === "activity"
        ? "ACTIVITY_EXPORT"
        : category === "womens-health"
          ? "MCT_EXPORT"
          : "HEALTH_EXPORT";
    if (!connection.scopes.includes(permission)) return;
    await dependencies.saveRecord(connection, category, type, record);
    if (category === "health") await dependencies.saveDailyMetric?.(connection, type, record);
    if (
      category === "activity" &&
      ["activities", "activityDetails", "manuallyUpdatedActivities"].includes(
        type,
      )
    ) {
      const activity = normalizeGarminActivity(record);
      await dependencies.saveActivity(
        connection,
        activity.id,
        activity.metrics,
        type === "activities" || type === "activityDetails",
      );
    }
  };
}
