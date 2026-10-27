import type { createJobStore } from "../history/jobs";

export { createHistoryProcessor as createStravaBackfill } from "../history/processor";

export async function requestStravaBackfill(
  jobs: Pick<ReturnType<typeof createJobStore>, "request">,
  userId: string,
  readAll: boolean,
): Promise<boolean> {
  return jobs.request(userId, readAll, true, true);
}