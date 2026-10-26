import { randomUUID } from "node:crypto";
import {
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
  type GetItemCommandOutput,
  type QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { chunks, garminHash } from "./payload";

type Dependencies = {
  get: (command: GetItemCommand) => Promise<Pick<GetItemCommandOutput, "Item">>;
  query: (
    command: QueryCommand,
  ) => Promise<Pick<QueryCommandOutput, "Items" | "LastEvaluatedKey">>;
  transact: (command: TransactWriteItemsCommand) => Promise<unknown>;
};
export class ArtifactRevisionConflict extends Error {
  constructor() { super("Encrypted artifact revision changed"); this.name = "ArtifactRevisionConflict"; }
}
export function createArtifactStore(dependencies: Dependencies, table: string) {
  return {
    async put(
      PK: string,
      SK: string,
      value: unknown,
      encrypt: () => Promise<string>,
      metadata: Record<string, unknown>,
      receivedAt: number,
      ttlEpoch?: number,
      consent?: { encryptedTokens: string; permission: string },
      expected?: { revision: string | null },
    ) {
      const existing = await dependencies.get(
        new GetItemCommand({
          TableName: table,
          Key: marshall({ PK, SK }),
          ConsistentRead: true,
        }),
      );
      const previous = existing.Item;
      if (expected && (previous?.revision?.S ?? null) !== expected.revision) throw new ArtifactRevisionConflict();
      const contentHash = garminHash(value);
      if (
        previous?.contentHash?.S === contentHash ||
        Number(previous?.receivedAt?.N ?? 0) > receivedAt
      )
        return false;
      const parts = chunks(await encrypt());
      const revision = randomUUID();
      const oldRevision = previous?.revision?.S;
      const oldCount = Number(previous?.partCount?.N ?? 0);
      if (oldCount > 48) throw new Error("Invalid Garmin chunk manifest");
      await dependencies.transact(
        new TransactWriteItemsCommand({
          TransactItems: [
            ...(consent
              ? [
                  {
                    ConditionCheck: {
                      TableName: table,
                      Key: marshall({ PK, SK: "CONNECTION#GARMIN" }),
                      ConditionExpression:
                        "#status = :active AND encryptedTokens = :tokens AND contains(scopes, :permission)",
                      ExpressionAttributeNames: { "#status": "status" },
                      ExpressionAttributeValues: marshall({
                        ":active": "ACTIVE",
                        ":tokens": consent.encryptedTokens,
                        ":permission": consent.permission,
                      }),
                    },
                  },
                ]
              : []),
            {
              Put: {
                TableName: table,
                Item: marshall(
                  {
                    ...metadata,
                    PK,
                    SK,
                    contentHash,
                    revision,
                    partCount: parts.length,
                    receivedAt,
                    ttlEpoch,
                  },
                  { removeUndefinedValues: true },
                ),
                ConditionExpression: oldRevision
                  ? "revision = :revision"
                  : "attribute_not_exists(PK)",
                ...(oldRevision
                  ? {
                      ExpressionAttributeValues: marshall({
                        ":revision": oldRevision,
                      }),
                    }
                  : {}),
              },
            },
            ...parts.map((encryptedPart, index) => ({
              Put: {
                TableName: table,
                Item: marshall(
                  {
                    PK,
                    SK: `${SK}#PART#${revision}#${String(index).padStart(3, "0")}`,
                    encryptedPart,
                    ttlEpoch,
                  },
                  { removeUndefinedValues: true },
                ),
              },
            })),
            ...Array.from({ length: oldCount }, (_, index) => ({
              Delete: {
                TableName: table,
                Key: marshall({
                  PK,
                  SK: `${SK}#PART#${oldRevision}#${String(index).padStart(3, "0")}`,
                }),
              },
            })),
          ],
        }),
      );
      return true;
    },
    async read(PK: string, SK: string, revision: string, count: number) {
      if (count < 1 || count > 48)
        throw new Error("Invalid Garmin chunk count");
      const rows: { SK: string; value: string }[] = [];
      let cursor: QueryCommandOutput["LastEvaluatedKey"];
      do {
        const response = await dependencies.query(
          new QueryCommand({
            TableName: table,
            ConsistentRead: true,
            KeyConditionExpression:
              "PK = :partition AND begins_with(SK, :prefix)",
            ExpressionAttributeValues: marshall({
              ":partition": PK,
              ":prefix": `${SK}#PART#${revision}#`,
            }),
            ExclusiveStartKey: cursor,
          }),
        );
        for (const item of response.Items ?? [])
          if (item.SK?.S && item.encryptedPart?.S)
            rows.push({ SK: item.SK.S, value: item.encryptedPart.S });
        cursor = response.LastEvaluatedKey;
      } while (cursor);
      if (rows.length !== count)
        throw new Error("Incomplete Garmin encrypted payload");
      return rows
        .sort((left, right) => left.SK.localeCompare(right.SK))
        .map((row) => row.value)
        .join("");
    },
  };
}
