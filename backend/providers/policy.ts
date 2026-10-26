export type Provider = "strava" | "garmin";
export type ProviderConnections = {
  strava: { active: boolean; scopes?: readonly string[] } | null;
  garmin: { active: boolean; scopes?: readonly string[] } | null;
};

export function activityProvider(
  connections: ProviderConnections,
): Provider | null {
  if (connections.strava?.active && (connections.strava.scopes === undefined || connections.strava.scopes.some((scope) => scope === "activity:read" || scope === "activity:read_all"))) return "strava";
  if (connections.garmin?.active && (connections.garmin.scopes === undefined || connections.garmin.scopes.includes("ACTIVITY_EXPORT"))) return "garmin";
  return null;
}

export function healthProvider(
  connections: ProviderConnections,
): "garmin" | null {
  return connections.garmin?.active && (connections.garmin.scopes === undefined || connections.garmin.scopes.some((scope) => scope === "HEALTH_EXPORT" || scope === "MCT_EXPORT")) ? "garmin" : null;
}

export const garminCapabilities = [
  "activity",
  "health",
  "womens-health",
  "training",
  "courses",
] as const;
export type GarminCapability = (typeof garminCapabilities)[number];
