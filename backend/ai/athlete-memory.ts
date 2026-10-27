import { randomUUID } from "node:crypto";
import { ConditionalCheckFailedException, GetItemCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";

const benchmarkSchema = z.object({
  segment_id: z.string().min(1).max(80),
  elapsed_seconds: z.number().positive(),
  achieved_at: z.string().datetime(),
  average_power: z.number().nonnegative().optional(),
  average_hr: z.number().nonnegative().optional(),
});

export const derivedMetricsSchema = z.object({
  max_hr_90d: z.number().positive().optional(),
  peak_np_90d: z.number().positive().optional(),
  key_segments_benchmarks: z.array(benchmarkSchema).max(5).optional(),
});

export const athleteMemorySchema = z.object({
  focus_goal: z.string().trim().min(1).max(160).optional(),
  preferred_tone: z.string().trim().min(1).max(80).optional(),
  derived_metrics: derivedMetricsSchema.optional(),
  coaching_notes: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
});

export type AthleteMemory = z.infer<typeof athleteMemorySchema>;
export type DerivedMetrics = z.infer<typeof derivedMetricsSchema>;

export function athleteMemoryBlock(memory: AthleteMemory): string {
  const value = athleteMemorySchema.parse(memory);
  const serialize = () => `<athlete_memory>${JSON.stringify(value).replace(/[<>&]/g,
    (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[character]!)}</athlete_memory>`;
  const encoder = new TextEncoder();
  while (encoder.encode(serialize()).length > 1100) {
    if (value.coaching_notes?.length) value.coaching_notes.shift();
    else if (value.derived_metrics?.key_segments_benchmarks?.length) value.derived_metrics.key_segments_benchmarks.pop();
    else if (value.preferred_tone) delete value.preferred_tone;
    else if (value.focus_goal) value.focus_goal = value.focus_goal.slice(0, Math.floor(value.focus_goal.length / 2)) || undefined;
    else break;
  }
  return serialize();
}

type MemoryActivity = { timestamp: number; data: Record<string, unknown> };
type Dependencies = {
  get: (command: GetItemCommand) => Promise<{ Item?: Record<string, AttributeValue> }>;
  update: (command: UpdateItemCommand) => Promise<unknown>;
};

function positive(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function deriveAthleteMetrics(activities: readonly MemoryActivity[], now: number): DerivedMetrics {
  let maxHr: number | undefined;
  let peakNp: number | undefined;
  const benchmarks = new Map<string, z.infer<typeof benchmarkSchema>>();
  const cutoff = now - 90 * 24 * 60 * 60 * 1000;
  for (const { timestamp, data } of activities) {
    if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > now) continue;
    const hr = positive(data.max_heartrate, data.maximumHeartRate, data.maxHeartRateInBeatsPerMinute);
    const np = positive(data.normalized_power, data.normalizedPower, data.normalizedPowerInWatts);
    if (hr !== undefined) maxHr = Math.max(maxHr ?? 0, hr);
    if (np !== undefined) peakNp = Math.max(peakNp ?? 0, np);
    const efforts = data.segment_efforts ?? data.segmentEfforts;
    if (!Array.isArray(efforts)) continue;
    for (const entry of efforts) {
      const effort = object(entry);
      const segment = object(effort.segment);
      const segmentId = segment.id ?? effort.segment_id ?? effort.segmentId;
      const elapsed = positive(effort.elapsed_time, effort.elapsedTimeInSeconds);
      if ((typeof segmentId !== "string" && typeof segmentId !== "number") || !elapsed) continue;
      const id = String(segmentId);
      if (!id || id.length > 80 || (benchmarks.get(id)?.elapsed_seconds ?? Infinity) <= elapsed) continue;
      benchmarks.set(id, {
        segment_id: id,
        elapsed_seconds: elapsed,
        achieved_at: new Date(timestamp).toISOString(),
        average_power: positive(effort.average_watts, effort.averagePowerInWatts),
        average_hr: positive(effort.average_heartrate, effort.averageHeartRateInBeatsPerMinute),
      });
    }
  }
  return derivedMetricsSchema.parse({
    ...(maxHr !== undefined ? { max_hr_90d: maxHr } : {}),
    ...(peakNp !== undefined ? { peak_np_90d: peakNp } : {}),
    key_segments_benchmarks: [...benchmarks.values()]
      .sort((left, right) => right.achieved_at.localeCompare(left.achieved_at) || left.segment_id.localeCompare(right.segment_id))
      .slice(0, 5),
  });
}

export function createAthleteMemoryStore(dependencies: Dependencies, tableName: string) {
  const key = (userId: string) => ({ PK: { S: `USER#${userId}` }, SK: { S: "ATHLETE_MEMORY" } });
  const read = async (userId: string) => {
    const result = await dependencies.get(new GetItemCommand({ TableName: tableName, Key: key(userId), ConsistentRead: true }));
    const raw = result.Item ? unmarshall(result.Item) : {};
    return { memory: athleteMemorySchema.parse(raw), revision: typeof raw.memoryRevision === "string" ? raw.memoryRevision : undefined };
  };
  return {
    async get(userId: string): Promise<AthleteMemory> {
      return (await read(userId)).memory;
    },
    async updateDerived(userId: string, metrics: DerivedMetrics) {
      await dependencies.update(new UpdateItemCommand({
        TableName: tableName, Key: key(userId),
        UpdateExpression: "SET derived_metrics = :metrics, derivedUpdatedAt = :now, entityType = :type",
        ExpressionAttributeValues: {
          ":metrics": marshall({ value: derivedMetricsSchema.parse(metrics) }, { removeUndefinedValues: true }).value!,
          ":now": { S: new Date().toISOString() }, ":type": { S: "ATHLETE_MEMORY" },
        },
      }));
    },
    async remember(userId: string, facts: Pick<AthleteMemory, "focus_goal" | "preferred_tone" | "coaching_notes">) {
      const parsed = athleteMemorySchema.omit({ derived_metrics: true }).parse(facts);
      if (!parsed.focus_goal && !parsed.preferred_tone && !parsed.coaching_notes?.length) return;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { memory, revision } = await read(userId);
        const updates = ["#revision = :next", "memoryUpdatedAt = :now", "entityType = :type"];
        const names: Record<string, string> = { "#revision": "memoryRevision" };
        const values: Record<string, AttributeValue> = {
          ":next": { S: randomUUID() }, ":now": { S: new Date().toISOString() }, ":type": { S: "ATHLETE_MEMORY" },
        };
        if (revision) values[":revision"] = { S: revision };
        for (const field of ["focus_goal", "preferred_tone", "coaching_notes"] as const) {
          const value = field === "coaching_notes"
            ? parsed.coaching_notes?.length ? [...new Set([...(memory.coaching_notes ?? []), ...parsed.coaching_notes])].slice(-10) : undefined
            : parsed[field];
          if (value === undefined) continue;
          names[`#${field}`] = field;
          values[`:${field}`] = marshall({ value }).value!;
          updates.push(`#${field} = :${field}`);
        }
        try {
          await dependencies.update(new UpdateItemCommand({
            TableName: tableName, Key: key(userId), UpdateExpression: `SET ${updates.join(", ")}`,
            ConditionExpression: revision ? "#revision = :revision" : "attribute_not_exists(#revision)",
            ExpressionAttributeNames: names, ExpressionAttributeValues: values,
          }));
          return;
        } catch (error) {
          if (!(error instanceof ConditionalCheckFailedException) || attempt === 2) throw error;
        }
      }
    },
  };
}