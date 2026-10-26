import { KeyRound, Trash2 } from "lucide-react";
import type { AIProvider } from "@/backend/ai/credentials";
import { deleteAIKey, saveAIKey } from "./actions";

type KeyStatus = {
  provider: AIProvider;
  configured: boolean;
  updatedAt?: string;
};

const providerNames: Record<AIProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
};

export function AIKeySettings({ keys }: { keys: KeyStatus[] }) {
  return (
    <section id="ai-keys" className="ai-key-section">
      <div className="section-title">
        <h2>Klucze do modeli AI</h2>
        <KeyRound size={18} />
      </div>
      <p className="ai-key-description">
        Klucze sa szyfrowane przed zapisem. AI Trainer nie wyswietla ich ponownie.
      </p>
      <div className="ai-key-list">
        {keys.map(({ provider, configured }) => (
          <div className="ai-key-row" key={provider}>
            <div className="ai-key-heading">
              <strong>{providerNames[provider]}</strong>
              <span className={configured ? "status connected" : "status"}>
                <span className="status-dot" />
                {configured ? "Klucz zapisany" : "Brak klucza"}
              </span>
            </div>
            <div className="ai-key-actions">
              <form action={saveAIKey} className="ai-key-form">
                <input type="hidden" name="provider" value={provider} />
                <label className="sr-only" htmlFor={`api-key-${provider}`}>
                  Klucz API: {providerNames[provider]}
                </label>
                <input
                  id={`api-key-${provider}`}
                  type="password"
                  name="apiKey"
                  minLength={8}
                  maxLength={4096}
                  required
                  autoComplete="new-password"
                  placeholder="Wklej klucz API"
                />
                <button className="ai-key-save" type="submit">
                  Zapisz
                </button>
              </form>
              {configured && (
                <form action={deleteAIKey}>
                  <input type="hidden" name="provider" value={provider} />
                  <button
                    className="ai-key-delete"
                    type="submit"
                    aria-label={`Usun klucz ${providerNames[provider]}`}
                    title="Usun klucz"
                  >
                    <Trash2 size={16} />
                  </button>
                </form>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}