"use client";

import { useEffect, useState } from "react";
import type { AIProvider } from "@/backend/ai/credentials";
import { chatModels, defaultChatModels } from "@/backend/ai/models";
import { readModelPreference, saveModelPreference } from "./ai-model-preferences";

const providerNames: Record<AIProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
};

export function ModelPreferences({ providers }: { providers: AIProvider[] }) {
  const [provider, setProvider] = useState<AIProvider>(providers[0] ?? "openai");
  const [modelId, setModelId] = useState(defaultChatModels[providers[0] ?? "openai"]);

  useEffect(() => {
    const preference = readModelPreference(providers);
    setProvider(preference.provider);
    setModelId(preference.modelId);
  }, [providers]);

  if (providers.length === 0) {
    return <p className="settings-empty">Dodaj klucz AI, aby wybrać model.</p>;
  }

  return (
    <section className="settings-panel model-settings">
      <div className="section-title">
        <h2>Domyślny model</h2>
      </div>
      <div className="model-preference-fields">
        <label>
          <span>Dostawca</span>
          <select
            value={provider}
            onChange={(event) => {
              const nextProvider = event.target.value as AIProvider;
              const nextModel = defaultChatModels[nextProvider];
              setProvider(nextProvider);
              setModelId(nextModel);
              saveModelPreference(nextProvider, nextModel);
            }}
          >
            {providers.map((availableProvider) => (
              <option key={availableProvider} value={availableProvider}>
                {providerNames[availableProvider]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Model</span>
          <select
            value={modelId}
            onChange={(event) => {
              setModelId(event.target.value);
              saveModelPreference(provider, event.target.value);
            }}
          >
            {chatModels[provider].map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}