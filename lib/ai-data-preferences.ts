export type AIDataPreferences = {
  recoveryMetrics: boolean;
  locationDetails: boolean;
  effortZones: boolean;
};

export const defaultAIDataPreferences: AIDataPreferences = {
  recoveryMetrics: true,
  locationDetails: false,
  effortZones: true,
};

function storageKey(userId: string) {
  return `ai-trainer:data-preferences:v1:${userId}`;
}

export function normalizeAIDataPreferences(value: unknown): AIDataPreferences {
  if (!value || typeof value !== "object") return defaultAIDataPreferences;
  const record = value as Record<string, unknown>;
  return {
    recoveryMetrics: typeof record.recoveryMetrics === "boolean"
      ? record.recoveryMetrics : defaultAIDataPreferences.recoveryMetrics,
    locationDetails: typeof record.locationDetails === "boolean"
      ? record.locationDetails : defaultAIDataPreferences.locationDetails,
    effortZones: typeof record.effortZones === "boolean"
      ? record.effortZones : defaultAIDataPreferences.effortZones,
  };
}

export function readAIDataPreferences(userId: string): AIDataPreferences {
  if (typeof window === "undefined") return defaultAIDataPreferences;
  try {
    const stored = window.localStorage.getItem(storageKey(userId));
    return stored ? normalizeAIDataPreferences(JSON.parse(stored) as unknown) : defaultAIDataPreferences;
  } catch {
    return defaultAIDataPreferences;
  }
}

export function saveAIDataPreferences(userId: string, preferences: AIDataPreferences) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(preferences));
  } catch {
    return;
  }
}