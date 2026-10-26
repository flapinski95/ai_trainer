import type { AIProvider } from "@/backend/ai/credentials";
import { defaultChatModels, isChatModelForProvider } from "@/backend/ai/models";

const preferenceKey = "ai-trainer.chat-model";

export function readModelPreference(providers: AIProvider[]) {
  const fallbackProvider = providers[0] ?? "openai";
  const fallback = {
    provider: fallbackProvider,
    modelId: defaultChatModels[fallbackProvider],
  };
  if (typeof window === "undefined") return fallback;

  try {
    const stored = JSON.parse(window.localStorage.getItem(preferenceKey) ?? "null") as {
      provider?: AIProvider;
      modelId?: string;
    } | null;
    if (
      stored?.provider &&
      stored.modelId &&
      providers.includes(stored.provider) &&
      isChatModelForProvider(stored.provider, stored.modelId)
    ) {
      return { provider: stored.provider, modelId: stored.modelId };
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export function saveModelPreference(provider: AIProvider, modelId: string) {
  try {
    window.localStorage.setItem(preferenceKey, JSON.stringify({ provider, modelId }));
  } catch {
    return;
  }
}