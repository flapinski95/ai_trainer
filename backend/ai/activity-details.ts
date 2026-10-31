import "server-only";
import { createHash } from "node:crypto";
import { DynamoDBClient, QueryCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import { authSettings } from "../../lib/server-config";
import { createArtifactStore } from "../garmin/artifacts";
import { createEnvelopeEncryption } from "../garmin/encryption";
import { fetchStravaActivityDetail, type ActivityStreams, type ActivityStreamKey } from "../strava/detail";

export const activityDetailsInputSchema = z.object({
  activityId: z.string(),
  requestedFields: z.array(z.enum(["segment_efforts", "cadence_detail", "hr_stream", "power_stream"])).min(1).max(4),
});

type RequestedField = z.infer<typeof activityDetailsInputSchema>["requestedFields"][number];
type DataRecord = Record<string, unknown>;

function record(value: unknown): DataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as DataRecord : {};
}

function select(value: unknown, fields: string[]): DataRecord {
  const source = record(value);
  return Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function streamResult(streams: ActivityStreams, key: ActivityStreamKey, multiplier = 1) {
  const stream = streams[key];
  if (!stream?.data.length) return undefined;
  const stride = Math.max(1, Math.ceil(stream.data.length / 180));
  const indexes = Array.from({ length: Math.ceil(stream.data.length / stride) }, (_, index) => index * stride);
  const time = streams.time;
  const aligned = time?.data.length === stream.data.length && time.series_type === stream.series_type;
  return {
    ...stream,
    data: stream.data.filter((_value, index) => index % stride === 0).map((value) => value === null ? null : value * multiplier),
    time_seconds: aligned ? indexes.map((index) => time.data[index]) : undefined,
    source_samples: stream.data.length,
    stride,
    sampled: stride > 1 || (stream.original_size ?? 0) > stream.data.length,
  };
}

export async function requestActivityDetails(
  userId: string,
  focusedActivityId: string,
  input: z.infer<typeof activityDetailsInputSchema>,
  signal: AbortSignal,
) {
  if (input.activityId !== focusedActivityId || !/^[A-Za-z0-9_-]{1,64}$/.test(input.activityId))
    return { status: "activity_not_found" as const };
  const settings = authSettings();
  if (!settings) return { status: "unavailable" as const };
  const abortSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const client = new DynamoDBClient({ region: settings.AWS_REGION, maxAttempts: 1,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 } });
  const PK = `USER#${userId}`;
  const read = async (SK: string) => {
    const result = await client.send(new QueryCommand({
      TableName: settings.DYNAMODB_TABLE_NAME,
      KeyConditionExpression: "PK = :user AND SK = :key",
      ExpressionAttributeValues: marshall({ ":user": PK, ":key": SK }), ConsistentRead: true, Limit: 1,
    }), { abortSignal });
    return result.Items?.[0];
  };
  try {
    const [strava, garmin] = await Promise.all([
      read(`ACTIVITY#STRAVA#${input.activityId}`), read(`ACTIVITY#GARMIN#${input.activityId}`),
    ]);
    const stored = [strava, garmin].find((item) => item?.entityType?.S === "WORKOUT" && item.status?.S === "ACTIVE");
    if (!stored) return { status: "activity_not_found" as const };
    let data = unmarshall(stored);
    const provider = data.provider === "strava" ? "strava" : "garmin";
    const running = typeof data.sport_type === "string" && /run|jog|trail/i.test(data.sport_type);
    const keys: Record<Exclude<RequestedField, "segment_efforts">, ActivityStreamKey> = {
      cadence_detail: "cadence", hr_stream: "heartrate", power_stream: "watts",
    };
    let streams: ActivityStreams = {};
    if (provider === "strava") {
      const detail = await fetchStravaActivityDetail(userId, input.activityId, settings, abortSignal, {
        streamKeys: input.requestedFields.flatMap((field) => field === "segment_efforts" ? [] : [keys[field]]),
        requirePersistence: true,
      });
      if (!detail) return { status: "unavailable" as const };
      data = { ...data, ...detail };
      streams = detail.telemetry_streams ?? {};
    } else {
      const kms = new KMSClient({ region: settings.AWS_REGION, maxAttempts: 1 });
      const artifacts = createArtifactStore({
        get: (command) => client.send(command, { abortSignal }),
        query: (command) => client.send(command, { abortSignal }),
        transact: (command) => client.send(command, { abortSignal }),
      }, settings.DYNAMODB_TABLE_NAME);
      const encryption = createEnvelopeEncryption({
        generate: (command) => kms.send(command, { abortSignal }),
        decrypt: (command) => kms.send(command, { abortSignal }),
      }, settings.DYNAMODB_KMS_KEY_ARN);
      const decryptArtifact = async (SK: string, context: Record<string, string>) => {
        const manifest = await read(SK);
        if (!manifest?.revision?.S || !manifest.partCount?.N) return undefined;
        return encryption.decrypt(await artifacts.read(PK, SK, manifest.revision.S, Number(manifest.partCount.N)), context);
      };
      let telemetry: DataRecord = {};
      const context = { userId, provider: "garmin", purpose: "workout-telemetry", activityId: input.activityId };
      const descriptor = z.object({
        version: z.literal(1), encoding: z.literal("json-utf8-base64"), segmentPrefix: z.string(),
        segmentCount: z.number().int().min(1).max(64), hash: z.string(),
      }).safeParse(await decryptArtifact(`TELEMETRY#GARMIN#${input.activityId}`, context));
      if (descriptor.success && descriptor.data.segmentPrefix.startsWith(`TELEMETRY#GARMIN#${input.activityId}#VERSION#`)) {
        const buffers: Buffer[] = [];
        for (let index = 0; index < descriptor.data.segmentCount; index += 1) {
          abortSignal.throwIfAborted();
          const part = z.object({ data: z.string() }).parse(await decryptArtifact(`${descriptor.data.segmentPrefix}${String(index).padStart(5, "0")}`, context));
          buffers.push(Buffer.from(part.data, "base64"));
        }
        const bytes = Buffer.concat(buffers);
        if (createHash("sha256").update(bytes).digest("hex") !== descriptor.data.hash) throw new Error("telemetry_integrity_failed");
        telemetry = record(JSON.parse(bytes.toString("utf8")) as unknown);
      } else {
        const connection = await read("CONNECTION#GARMIN");
        if (connection?.status?.S === "ACTIVE" && connection.scopes?.SS?.includes("ACTIVITY_EXPORT")) {
          const candidates = await client.send(new QueryCommand({ TableName: settings.DYNAMODB_TABLE_NAME,
            KeyConditionExpression: "PK = :user AND begins_with(SK, :prefix)",
            ExpressionAttributeValues: marshall({ ":user": PK, ":prefix": "GARMIN_ACTIVITY#GARMIN#activityDetails#" }),
            ConsistentRead: true, Limit: 20,
          }), { abortSignal });
          for (const candidate of candidates.Items ?? []) {
            if (!candidate.SK?.S || candidate.entityType?.S !== "GARMIN_ACTIVITY_DATA") continue;
            const value = record(await decryptArtifact(candidate.SK.S, { userId, provider: "garmin", purpose: "activity" }));
            if (String(value.activityId ?? value.summaryId) === input.activityId) { telemetry = value; break; }
          }
        }
      }
      const samples = telemetry.records ?? telemetry.samples;
      if (Array.isArray(samples)) {
        const rows = samples.map(record);
        const fit = telemetry.format === "garmin-fit-v1";
        const session = record(telemetry.session ?? telemetry.summary);
        const cadence = fit ? session.avgCadence : running ? session.averageRunCadenceInStepsPerMinute : session.averageBikeCadenceInRoundsPerMinute;
        if (typeof cadence === "number" && Number.isFinite(cadence) && cadence >= 0)
          data.average_cadence = cadence * (fit && running ? 2 : 1);
        const time = rows.map((row) => typeof row.timestamp === "string" ? Date.parse(row.timestamp) / 1000 : row.startTimeInSeconds);
        const start = Date.parse(String(data.start_date)) / 1000;
        if (time.every((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= start))
          streams.time = { data: time.map((value) => value - start), series_type: "time" };
        for (const [key, names] of Object.entries({ heartrate: ["heartRate", "heartRateInBeatsPerMinute"],
          cadence: fit ? ["cadence"] : running ? ["runCadenceInStepsPerMinute"] : ["bikeCadenceInRPM"], watts: ["power", "powerInWatts"] })) {
          const values = rows.map((row) => names.map((name) => row[name]).find((value) => typeof value === "number"));
          if (values.some((value) => typeof value === "number" && Number.isFinite(value) && value >= 0))
            streams[key as ActivityStreamKey] = {
              data: values.map((value) => typeof value === "number" && Number.isFinite(value) && value >= 0
                ? value * (key === "cadence" && fit && running ? 2 : 1) : null),
              series_type: "time",
            };
        }
      }
    }
    const cadenceMultiplier = running && provider === "strava" ? 2 : 1;
    const telemetry: Partial<Record<RequestedField, unknown>> = {};
    const unavailableFields: RequestedField[] = [];
    for (const field of new Set(input.requestedFields)) {
      if (field === "segment_efforts" && Array.isArray(data.segment_efforts)) {
        telemetry[field] = data.segment_efforts.map((effort: unknown) => ({
          ...select(effort, ["id", "name", "elapsed_time", "moving_time", "average_heartrate", "max_heartrate", "pr_rank", "kom_rank"]),
          segment: select(record(effort).segment, ["id", "name", "distance", "average_grade", "elevation_high", "elevation_low"]),
          average_cadence: typeof record(effort).average_cadence === "number" ? Number(record(effort).average_cadence) * cadenceMultiplier : undefined,
          cadence_unit: running ? "spm" : "rpm",
          ...(data.device_watts === true ? select(effort, ["average_watts"]) : {}),
        }));
      } else if (field === "cadence_detail") {
        const average = typeof data.average_cadence === "number" ? data.average_cadence * cadenceMultiplier : undefined;
        const stream = streamResult(streams, "cadence", cadenceMultiplier);
        if (average !== undefined || stream) telemetry[field] = { average, unit: running ? "spm" : "rpm", stream };
      } else if (field === "hr_stream") {
        const stream = streamResult(streams, "heartrate");
        if (stream) telemetry[field] = { ...stream, unit: "bpm" };
      } else if (field === "power_stream" && data.device_watts === true) {
        const stream = streamResult(streams, "watts");
        if (stream) telemetry[field] = { ...stream, unit: "W", device_watts: true };
      }
      if (telemetry[field] === undefined) unavailableFields.push(field);
    }
    abortSignal.throwIfAborted();
    await client.send(new TransactWriteItemsCommand({ TransactItems: [
      { ConditionCheck: { TableName: settings.DYNAMODB_TABLE_NAME,
        Key: marshall({ PK, SK: `ACTIVITY#${provider.toUpperCase()}#${input.activityId}` }),
        ConditionExpression: "#status = :active", ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: marshall({ ":active": "ACTIVE" }),
      } },
      { Put: { TableName: settings.DYNAMODB_TABLE_NAME,
        Item: marshall({ PK, SK: `AI_TELEMETRY#${provider.toUpperCase()}#${input.activityId}`,
          entityType: "AI_ACTIVITY_TELEMETRY", updatedAt: new Date().toISOString(), telemetry }, { removeUndefinedValues: true }),
      } },
    ] }), { abortSignal });
    return { status: unavailableFields.length ? "partial" as const : "ok" as const,
      activityId: input.activityId, provider, telemetry, unavailableFields };
  } catch (error) {
    signal.throwIfAborted();
    console.warn("chat_activity_details_failed", { type: error instanceof Error ? error.name : "UnknownError" });
    return { status: "unavailable" as const, activityId: input.activityId, unavailableFields: input.requestedFields };
  }
}