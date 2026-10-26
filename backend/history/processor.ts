import { z } from "zod";
import { normalizeSummary, needsDetails, PAGE_SIZE } from "./model";
import { RateLimitError } from "./rate-limit";
import type { SyncJob } from "./jobs";
import {
  activitySchema,
  StravaRequestError,
  type Activity,
  type Connection,
  type Tokens,
} from "../strava-worker/processor";

type Dependencies = {
  claim: (userId: string) => Promise<SyncJob | null>;
  checkpoint: (job: SyncJob) => Promise<void>;
  connection: (athleteId: number) => Promise<Connection | null>;
  connectionByUser?: (userId: string) => Promise<Connection | null>;
  decrypt: (connection: Connection) => Promise<Tokens>;
  refresh: (refreshToken: string) => Promise<Tokens & { expiresAt: number }>;
  saveTokens: (
    connection: Connection,
    tokens: Tokens & { expiresAt: number },
  ) => Promise<Connection>;
  listActivities: (
    access: string,
    after: number,
    before: number,
    page: number,
  ) => Promise<unknown>;
  fetchActivity: (id: number, access: string) => Promise<unknown>;
  saveHistory: (
    connection: Connection,
    activity: Activity,
    detailed: boolean,
  ) => Promise<boolean>;
  revoke: (connection: Connection) => Promise<void>;
  clock?: () => number;
  remaining?: () => number;
};

export function createHistoryProcessor(dependencies: Dependencies) {
  const clock = dependencies.clock ?? Date.now;
  return async (userId: string) => {
    const job = await dependencies.claim(userId);
    if (!job) return;
    let connection: Connection | null = null;
    try {
      connection = dependencies.connectionByUser
        ? await dependencies.connectionByUser(userId)
        : await dependencies.connection(Number(userId.replace(/^strava-/, "")));
      const athleteId = connection?.athleteId ?? "";
      if (
        !connection ||
        connection.userId !== userId ||
        connection.athleteId !== athleteId ||
        !connection.active ||
        !connection.scopes.some((scope) =>
          ["activity:read", "activity:read_all"].includes(scope),
        )
      ) {
        job.state = "FAILED";
        job.errorCode = "AUTHORIZATION";
        await dependencies.checkpoint(job);
        return;
      }
      let tokens = await dependencies.decrypt(connection);
      let refreshed = false;
      const refresh = async () => {
        if (refreshed) throw new StravaRequestError(401);
        const next = await dependencies.refresh(tokens.refreshToken);
        connection = await dependencies.saveTokens(connection!, next);
        tokens = next;
        refreshed = true;
      };
      const read = async (operation: (access: string) => Promise<unknown>) => {
        try {
          return await operation(tokens.accessToken);
        } catch (error) {
          if (!(error instanceof StravaRequestError) || error.status !== 401)
            throw error;
          await refresh();
          return operation(tokens.accessToken);
        }
      };
      if (connection.expiresAt <= clock() / 1000 + 60) await refresh();
      if (!job.pending) {
        const payload = await read((access) =>
          dependencies.listActivities(access, job.after, job.before, job.page),
        );
        const rows = z.array(z.unknown()).max(PAGE_SIZE).parse(payload);
        job.pending = rows.map((row) => normalizeSummary(row, athleteId));
        job.offset = 0;
        job.endPage = rows.length < PAGE_SIZE;
      }
      let handled = 0;
      const started = clock();
      while (
        job.offset < job.pending.length &&
        handled < 10 &&
        clock() - started < 15000 &&
        (dependencies.remaining?.() ?? 30000) > 9000
      ) {
        const summary = job.pending[job.offset]!;
        let activity: Activity = summary;
        const detailed = needsDetails(summary, job.before);
        if (detailed) {
          try {
            activity = activitySchema.parse(
              await read((access) =>
                dependencies.fetchActivity(summary.id, access),
              ),
            );
            if (
              activity.id !== summary.id ||
              String(activity.athlete.id) !== athleteId
            )
              throw new Error("Activity ownership mismatch");
          } catch (error) {
            if (
              !(error instanceof StravaRequestError) ||
              ![403, 404].includes(error.status)
            )
              throw error;
            job.offset += 1;
            job.processed += 1;
            handled += 1;
            continue;
          }
        }
        if (await dependencies.saveHistory(connection, activity, detailed))
          job.changed += 1;
        job.offset += 1;
        job.processed += 1;
        handled += 1;
      }
      if (job.offset >= job.pending.length) {
        job.pending = undefined;
        job.offset = 0;
        if (job.endPage) {
          job.state = "SUCCEEDED";
          job.lastSuccess = job.before;
          job.successReadAll = job.readAll;
        } else {
          job.page += 1;
          job.state = "QUEUED";
        }
      } else job.state = "QUEUED";
      job.errorCode = undefined;
      job.failures = 0;
      job.dueAt = Math.floor(clock() / 1000) + 1;
      await dependencies.checkpoint(job);
    } catch (error) {
      job.failures += error instanceof RateLimitError ? 0 : 1;
      if (
        error instanceof StravaRequestError &&
        [400, 401].includes(error.status) &&
        connection
      ) {
        await dependencies.revoke(connection);
        job.state = "FAILED";
        job.errorCode = "AUTHORIZATION";
      } else {
        job.state = job.failures >= 8 ? "FAILED" : "WAITING";
        job.errorCode =
          error instanceof RateLimitError ? "RATE_LIMIT" : "TEMPORARY";
        job.dueAt =
          error instanceof RateLimitError
            ? error.retryAt
            : Math.floor(clock() / 1000) +
              Math.min(3600, 60 * 2 ** job.failures);
      }
      await dependencies.checkpoint(job);
      console.error("strava_history_paused", { reason: job.errorCode });
    }
  };
}
