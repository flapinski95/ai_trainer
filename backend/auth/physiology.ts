import { GetItemCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { athletePhysiologySchema, physiologyFields, type AthletePhysiology } from "../../lib/athlete-zones";

type Dependencies = {
  get: (command: GetItemCommand) => Promise<{ Item?: Record<string, AttributeValue> }>;
  update: (command: UpdateItemCommand) => Promise<unknown>;
};

export function createPhysiologyStore(dependencies: Dependencies, tableName: string) {
  const key = (userId: string) => ({ PK: { S: `USER#${userId}` }, SK: { S: "METADATA" } });
  return {
    async physiology(userId: string): Promise<AthletePhysiology> {
      const result = await dependencies.get(new GetItemCommand({
        TableName: tableName, Key: key(userId), ConsistentRead: true,
        ProjectionExpression: physiologyFields.map((field) => `#${field}`).join(", "),
        ExpressionAttributeNames: Object.fromEntries(physiologyFields.map((field) => [`#${field}`, field])),
      }));
      return athletePhysiologySchema.parse(result.Item ? unmarshall(result.Item) : {});
    },
    async setPhysiology(userId: string, value: AthletePhysiology): Promise<void> {
      const settings = athletePhysiologySchema.parse(value);
      const updates = ["#updated = :now"];
      const removals: string[] = [];
      const names: Record<string, string> = { "#updated": "physiologyUpdatedAt" };
      const values: Record<string, AttributeValue> = { ":now": { S: new Date().toISOString() } };
      for (const field of physiologyFields) {
        names[`#${field}`] = field;
        if (settings[field] === undefined) removals.push(`#${field}`);
        else {
          updates.push(`#${field} = :${field}`);
          values[`:${field}`] = marshall({ value: settings[field] }).value!;
        }
      }
      await dependencies.update(new UpdateItemCommand({
        TableName: tableName, Key: key(userId),
        UpdateExpression: `SET ${updates.join(", ")}${removals.length ? ` REMOVE ${removals.join(", ")}` : ""}`,
        ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      }));
    },
  };
}