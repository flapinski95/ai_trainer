import { createHash } from "node:crypto";
import { z } from "zod";

export const categorySchema = z.enum([
  "activity",
  "health",
  "womens-health",
  "permissions",
  "deregistration",
]);
export type GarminCategory = z.infer<typeof categorySchema>;
export const recordSchema = z
  .object({
    userId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    summaryId: z.string().min(1).max(512).optional(),
  })
  .passthrough();
export const payloadSchema = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,99}$/),
    z.array(recordSchema).max(2000),
  )
  .refine(
    (value) =>
      Object.keys(value).length > 0 &&
      Object.values(value).some((records) => records.length > 0),
  );
export type GarminRecord = z.infer<typeof recordSchema>;
export const garminHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function chunks(value: string) {
  const result: string[] = [];
  for (let offset = 0; offset < value.length; offset += 60000)
    result.push(value.slice(offset, offset + 60000));
  if (result.length > 48)
    throw new Error("Garmin encrypted payload exceeds transaction limit");
  return result;
}
