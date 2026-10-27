import { z } from "zod";
import type { Workout } from "./store";

export const activityTypeSchema = z.enum(["all", "cycling", "running"]);
export type ActivityType = z.infer<typeof activityTypeSchema>;

export type ActivitiesPage = {
  activities: Workout[];
  page: number;
  limit: number;
  nextCursor: string | null;
};

export function activityDiscipline(sport: string): Exclude<ActivityType, "all"> | "other" {
  if (/ride|gravel|cycl|bike/i.test(sport)) return "cycling";
  if (/run/i.test(sport)) return "running";
  return "other";
}