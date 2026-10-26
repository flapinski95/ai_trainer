import type { AIProvider } from "./credentials";

export const chatModels = {
  openai: [
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      description: "Najmocniejszy model do zlozonych analiz.",
    },
    {
      id: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      description: "Balans jakosci i kosztu.",
    },
    {
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      description: "Szybki i ekonomiczny wybor.",
    },
  ],
  anthropic: [
    {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      description: "Do dlugich i wymagajacych analiz.",
    },
    {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      description: "Najlepszy balans szybkosci i jakosci.",
    },
    {
      id: "claude-haiku-5-5",
      name: "Claude Haiku 5.5",
      description: "Najmniejsze opoznienie i niski koszt.",
    },
    {
      id: "claude-fable-5-1",
      name: "Claude Fable 5.1",
      description: "Zaawansowane rozumowanie i dlugi kontekst.",
    },
  ],
  google: [
    {
      id: "gemini-4-argon",
      name: "Gemini 4 Argon",
      description: "Flagowy model do zlozonego rozumowania.",
    },
    {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      description: "Szybki model do codziennego coachingu.",
    },
    {
      id: "gemini-3.6-flash",
      name: "Gemini 3.6 Flash",
      description: "Poprzednia, nadal stabilna generacja Flash.",
    },
    {
      id: "gemini-3.5-flash-lite",
      name: "Gemini 3.5 Flash-Lite",
      description: "Najbardziej ekonomiczny wariant Gemini.",
    },
  ],
} as const satisfies Record<AIProvider, readonly { id: string; name: string; description: string }[]>;

export const defaultChatModels = {
  openai: "gpt-6.1-sol",
  anthropic: "claude-sonnet-5-5",
  google: "gemini-3.8-flash",
} satisfies Record<AIProvider, string>;

export const googleFallbackModel = "gemini-3.5-flash-lite";

export function isChatModelForProvider(
  provider: AIProvider,
  modelId: string,
) {
  return chatModels[provider].some((model) => model.id === modelId);
}