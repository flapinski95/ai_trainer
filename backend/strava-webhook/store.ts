import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { eventIdentity, type StravaEvent } from "./events";

const client = new DynamoDBClient({
  maxAttempts: 1,
  requestHandler: { connectionTimeout: 400, requestTimeout: 1200 },
});

export function createEventStore(
  send: (command: PutItemCommand) => Promise<unknown>,
) {
  return async (event: StravaEvent, tableName: string): Promise<void> => {
    const command = new PutItemCommand({
      TableName: tableName,
      Item: {
        PK: { S: `STRAVA#ATHLETE#${event.owner_id}` },
        SK: { S: `WEBHOOK#${eventIdentity(event)}` },
        entityType: { S: "STRAVA_WEBHOOK_EVENT" },
        status: { S: "RECEIVED" },
        receivedAt: { S: new Date().toISOString() },
        payload: { S: JSON.stringify(event) },
        GSI1PK: { S: "STRAVA#WEBHOOK#PENDING" },
        GSI1SK: {
          S: `RETRY#${String(Math.floor(Date.now() / 1000)).padStart(12, "0")}#${eventIdentity(event)}`,
        },
      },
      ConditionExpression:
        "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    });
    try {
      await send(command);
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
  };
}

export const saveEvent = createEventStore((command) => client.send(command));
