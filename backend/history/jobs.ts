import { randomUUID } from "node:crypto";
import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  ConditionalCheckFailedException,
  type GetItemCommandOutput,
  type QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import { summarySchema, syncWindow } from "./model";
import { userIdSchema } from "../auth/identity";

export const jobSchema = z.object({
  userId: userIdSchema,
  jobId: z.string(),
  state: z.enum(["QUEUED", "RUNNING", "WAITING", "SUCCEEDED", "FAILED"]),
  after: z.number(),
  before: z.number(),
  page: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  pending: z.array(summarySchema).max(200).optional(),
  endPage: z.boolean().default(false),
  processed: z.number().default(0),
  changed: z.number().default(0),
  failures: z.number().default(0),
  readAll: z.boolean(),
  lastSuccess: z.number().optional(),
  successReadAll: z.boolean().optional(),
  fullBackfill: z.boolean().optional(),
  requestedAt: z.number(),
  dueAt: z.number(),
  leaseId: z.string().optional(),
  leaseUntil: z.number().optional(),
  errorCode: z.enum(["RATE_LIMIT", "TEMPORARY", "AUTHORIZATION"]).optional(),
});
export type SyncJob = z.infer<typeof jobSchema>;
type Dependencies = {
  get: (command: GetItemCommand) => Promise<Pick<GetItemCommandOutput, "Item">>;
  query: (command: QueryCommand) => Promise<Pick<QueryCommandOutput, "Items">>;
  put: (command: PutItemCommand) => Promise<unknown>;
  update: (command: UpdateItemCommand) => Promise<unknown>;
};
const indexKey = (dueAt: number, userId: string) =>
  `SYNC#${String(Math.floor(dueAt)).padStart(12, "0")}#${userId}`;
export function createJobStore(
  dependencies: Dependencies,
  table: string,
  clock: () => number = Date.now,
) {
  const key = (userId: string) =>
    marshall({ PK: `USER#${userId}`, SK: "SYNC#STRAVA" });
  const item = (job: SyncJob) =>
    marshall(
      {
        ...job,
        PK: `USER#${job.userId}`,
        SK: "SYNC#STRAVA",
        entityType: "STRAVA_SYNC_JOB",
        ...(["QUEUED", "RUNNING", "WAITING"].includes(job.state)
          ? {
              GSI1PK: "STRAVA#SYNC#PENDING",
              GSI1SK: indexKey(job.dueAt, job.userId),
            }
          : {}),
      },
      { removeUndefinedValues: true },
    );
  async function load(userId: string) {
    const response = await dependencies.get(
      new GetItemCommand({
        TableName: table,
        Key: key(userId),
        ConsistentRead: true,
      }),
    );
    if (!response.Item) return null;
    const job = jobSchema.parse(unmarshall(response.Item));
    if (job.userId !== userId)
      throw new Error("History job ownership mismatch");
    return job;
  }
  return {
    load,
    async request(userId: string, readAll: boolean, manual = false, fullBackfill = false) {
      userIdSchema.parse(userId);
      const previous = await load(userId);
      const now = Math.floor(clock() / 1000);
      if (previous && ["QUEUED", "RUNNING", "WAITING"].includes(previous.state))
        return false;
      if (previous && now - previous.requestedAt < (manual ? 60 : 900))
        return false;
      const window = syncWindow(
        clock(),
        fullBackfill ? undefined : previous?.lastSuccess,
        readAll && !previous?.successReadAll,
      );
      const resume =
        previous?.state === "FAILED" && (!readAll || previous.readAll) &&
        (!fullBackfill || previous.fullBackfill === true);
      const job = jobSchema.parse({
        ...previous,
        ...window,
        jobId: randomUUID(),
        userId,
        state: "QUEUED",
        readAll,
        fullBackfill: fullBackfill || (resume && previous.fullBackfill) || undefined,
        page: resume ? previous.page : 1,
        offset: resume ? previous.offset : 0,
        pending: resume ? previous.pending : undefined,
        endPage: resume ? previous.endPage : false,
        after: resume ? previous.after : window.after,
        before: resume ? previous.before : window.before,
        processed: resume ? previous.processed : 0,
        changed: resume ? previous.changed : 0,
        failures: 0,
        requestedAt: now,
        dueAt: now,
        leaseId: undefined,
        leaseUntil: undefined,
        errorCode: undefined,
      });
      try {
        await dependencies.put(
          new PutItemCommand({
            TableName: table,
            Item: item(job),
            ConditionExpression: previous
              ? "jobId = :previous"
              : "attribute_not_exists(PK)",
            ...(previous
              ? {
                  ExpressionAttributeValues: marshall({
                    ":previous": previous.jobId,
                  }),
                }
              : {}),
          }),
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }
      return true;
    },
    async claim(userId: string) {
      const job = await load(userId);
      const now = Math.floor(clock() / 1000);
      if (
        !job ||
        ["SUCCEEDED", "FAILED"].includes(job.state) ||
        job.dueAt > now ||
        (job.leaseUntil ?? 0) > now
      )
        return null;
      const leaseId = randomUUID();
      try {
        await dependencies.update(
          new UpdateItemCommand({
            TableName: table,
            Key: key(userId),
            UpdateExpression:
              "SET leaseId = :lease, leaseUntil = :until, #state = :running, GSI1SK = :due",
            ConditionExpression:
              "jobId = :job AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :now)",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: marshall({
              ":lease": leaseId,
              ":until": now + 60,
              ":running": "RUNNING",
              ":job": job.jobId,
              ":now": now,
              ":due": indexKey(now + 60, userId),
            }),
          }),
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return null;
        throw error;
      }
      return {
        ...job,
        state: "RUNNING" as const,
        leaseId,
        leaseUntil: now + 60,
      };
    },
    async checkpoint(job: SyncJob) {
      const saved = { ...job, leaseId: undefined, leaseUntil: undefined };
      await dependencies.put(
        new PutItemCommand({
          TableName: table,
          Item: item(saved),
          ConditionExpression: "jobId = :job AND leaseId = :lease",
          ExpressionAttributeValues: marshall({
            ":job": job.jobId,
            ":lease": job.leaseId,
          }),
        }),
      );
    },
    async nextDue() {
      const response = await dependencies.query(
        new QueryCommand({
          TableName: table,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pending AND GSI1SK <= :due",
          Limit: 1,
          ExpressionAttributeValues: marshall({
            ":pending": "STRAVA#SYNC#PENDING",
            ":due": `${indexKey(Math.floor(clock() / 1000), "~")}`,
          }),
        }),
      );
      const partition = response.Items?.[0]?.PK?.S;
      return partition?.startsWith("USER#")
        ? userIdSchema.parse(partition.slice(5))
        : null;
    },
  };
}
