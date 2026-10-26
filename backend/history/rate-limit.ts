import {
  GetItemCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
  ConditionalCheckFailedException,
  TransactionCanceledException,
  type GetItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { StravaRequestError } from "../strava-worker/processor";

export class RateLimitError extends StravaRequestError {
  constructor(public readonly retryAt: number) {
    super(429);
    this.name = "RateLimitError";
  }
}
export type RateGate = {
  before: (kind: "read" | "oauth") => Promise<void>;
  after: (
    headers: Headers,
    status: number,
    kind: "read" | "oauth",
  ) => Promise<void>;
};
type Dependencies = {
  get: (command: GetItemCommand) => Promise<Pick<GetItemCommandOutput, "Item">>;
  update: (command: UpdateItemCommand) => Promise<unknown>;
  transact: (command: TransactWriteItemsCommand) => Promise<unknown>;
};
const PK = "STRAVA#RATE_LIMIT";
const pair = (value: string | null): number[] | null => {
  if (!value) return null;
  const parts = value.split(",").map(Number);
  return parts.length === 2 &&
    parts.every((part) => Number.isFinite(part) && part >= 0)
    ? parts
    : null;
};

export function createRateGate(
  dependencies: Dependencies,
  table: string,
  priority: "HISTORY" | "WEBHOOK",
  clock: () => number = Date.now,
): RateGate {
  const key = (SK: string) => marshall({ PK, SK });
  const nextQuarter = () => (Math.floor(clock() / 900000) + 1) * 900 + 2;
  const nextDay = () => (Math.floor(clock() / 86400000) + 1) * 86400 + 2;
  const slots = (kind: "read" | "oauth", caps: Record<string, unknown>) => [
    ...["TOTAL", ...(kind === "read" ? ["READ"] : [])].flatMap((category) =>
      [900, 86400].map((window) => ({
        name: `${category}#${window}#${Math.floor(clock() / 1000 / window)}`,
        cap: Number(
          caps[`${category}${window}`] ??
            (category === "READ"
              ? window === 900
                ? 200
                : 2000
              : window === 900
                ? 400
                : 4000),
        ),
        window,
      })),
    ),
  ];
  return {
    async before(kind) {
      const state = await dependencies.get(
        new GetItemCommand({
          TableName: table,
          Key: key("STATE"),
          ConsistentRead: true,
        }),
      );
      const caps = state.Item ? unmarshall(state.Item) : {};
      if (Number(caps.blockedUntil ?? 0) > clock() / 1000)
        throw new RateLimitError(Number(caps.blockedUntil));
      const counters = slots(kind, caps);
      try {
        await dependencies.transact(
          new TransactWriteItemsCommand({
            TransactItems: counters.map((slot) => ({
              Update: {
                TableName: table,
                Key: key(slot.name),
                UpdateExpression: "SET ttlEpoch = :ttl ADD #used :one",
                ConditionExpression:
                  "attribute_not_exists(#used) OR #used < :limit",
                ExpressionAttributeNames: { "#used": "used" },
                ExpressionAttributeValues: marshall({
                  ":ttl":
                    (Math.floor(clock() / 1000 / slot.window) + 1) *
                      slot.window +
                    86400,
                  ":one": 1,
                  ":limit": Math.max(
                    1,
                    Math.floor(slot.cap * (priority === "HISTORY" ? 0.9 : 1)),
                  ),
                }),
              },
            })),
          }),
        );
      } catch (error) {
        if (
          !(error instanceof TransactionCanceledException) ||
          !error.CancellationReasons?.some(
            (reason) => reason.Code === "ConditionalCheckFailed",
          )
        )
          throw error;
        const daily = error.CancellationReasons.some(
          (reason, index) =>
            reason.Code === "ConditionalCheckFailed" &&
            counters[index]?.window === 86400,
        );
        throw new RateLimitError(daily ? nextDay() : nextQuarter());
      }
    },
    async after(headers, status, kind) {
      let blockedUntil = 0;
      for (const category of ["TOTAL", ...(kind === "read" ? ["READ"] : [])]) {
        const prefix = category === "READ" ? "x-readratelimit" : "x-ratelimit";
        const limits = pair(headers.get(`${prefix}-limit`));
        const usage = pair(headers.get(`${prefix}-usage`));
        if (!limits || !usage) continue;
        for (const [index, window] of [900, 86400].entries()) {
          const cap = limits[index]!;
          const used = usage[index]!;
          if (used >= cap)
            blockedUntil = Math.max(
              blockedUntil,
              window === 86400 ? nextDay() : nextQuarter(),
            );
          await dependencies.update(
            new UpdateItemCommand({
              TableName: table,
              Key: key("STATE"),
              UpdateExpression: "SET #cap = :cap",
              ExpressionAttributeNames: { "#cap": `${category}${window}` },
              ExpressionAttributeValues: marshall({ ":cap": cap }),
            }),
          );
          try {
            await dependencies.update(
              new UpdateItemCommand({
                TableName: table,
                Key: key(
                  `${category}#${window}#${Math.floor(clock() / 1000 / window)}`,
                ),
                UpdateExpression: "SET #used = :used, ttlEpoch = :ttl",
                ConditionExpression:
                  "attribute_not_exists(#used) OR #used < :used",
                ExpressionAttributeNames: { "#used": "used" },
                ExpressionAttributeValues: marshall({
                  ":used": used,
                  ":ttl":
                    (Math.floor(clock() / 1000 / window) + 1) * window + 86400,
                }),
              }),
            );
          } catch (error) {
            if (!(error instanceof ConditionalCheckFailedException))
              throw error;
          }
        }
      }
      if (status === 429) {
        const retry = headers.get("retry-after");
        const seconds =
          retry && /^\d+$/.test(retry)
            ? clock() / 1000 + Number(retry)
            : retry
              ? Date.parse(retry) / 1000
              : 0;
        blockedUntil = Math.max(
          blockedUntil,
          Number.isFinite(seconds) ? seconds : 0,
          nextQuarter(),
        );
      }
      if (blockedUntil) {
        try {
          await dependencies.update(
            new UpdateItemCommand({
              TableName: table,
              Key: key("STATE"),
              UpdateExpression: "SET blockedUntil = :until",
              ConditionExpression:
                "attribute_not_exists(blockedUntil) OR blockedUntil < :until",
              ExpressionAttributeValues: marshall({ ":until": blockedUntil }),
            }),
          );
        } catch (error) {
          if (!(error instanceof ConditionalCheckFailedException)) throw error;
        }
        if (status === 429) throw new RateLimitError(blockedUntil);
      }
    },
  };
}
