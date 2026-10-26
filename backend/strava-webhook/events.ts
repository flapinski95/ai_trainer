import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const stravaEventSchema = z
  .object({
    object_type: z.enum(["activity", "athlete"]),
    object_id: identifier,
    aspect_type: z.enum(["create", "update", "delete"]),
    owner_id: identifier,
    subscription_id: identifier,
    event_time: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    updates: z
      .record(z.string().max(128), z.union([z.string().max(2048), z.boolean()]))
      .default({}),
  })
  .refine(
    (event) =>
      event.object_type !== "athlete" ||
      (event.aspect_type === "update" &&
        event.object_id === event.owner_id &&
        (event.updates.authorized === "false" ||
          event.updates.authorized === false)),
    { message: "Unsupported athlete event" },
  );

export type StravaEvent = z.infer<typeof stravaEventSchema>;

export function eventIdentity(event: StravaEvent): string {
  const canonical = JSON.stringify([
    event.subscription_id,
    event.owner_id,
    event.object_type,
    event.object_id,
    event.aspect_type,
    event.event_time,
    Object.entries(event.updates).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}
