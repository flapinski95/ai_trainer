"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { LoaderCircle, MessageCircle, Plus, Send } from "lucide-react";
import type { AIProvider } from "@/backend/ai/credentials";
import { chatModels, defaultChatModels } from "@/backend/ai/models";
import { readModelPreference, saveModelPreference } from "./ai-model-preferences";
import { ThinkingStepper, type CoachMessage } from "./chat/thinking-stepper";

type ChatSession = {
  sessionId: string;
  title: string;
  updatedAt: string;
};

type ChatMessage = {
  messageId: string;
  role: "user" | "assistant";
  content: string;
};

function toUIMessages(messages: ChatMessage[]): CoachMessage[] {
  return messages.map((message) => ({
    id: message.messageId,
    role: message.role,
    parts: [{ type: "text", text: message.content }],
  }));
}

const providerNames: Record<AIProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
};

export function ChatPanel({ providers, initialSessionId }: { providers: AIProvider[]; initialSessionId?: string }) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [provider, setProvider] = useState<AIProvider>(providers[0] ?? "openai");
  const [modelId, setModelId] = useState<string>(
    defaultChatModels[providers[0] ?? "openai"],
  );
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const endOfMessages = useRef<HTMLDivElement>(null);
  const requestOptions = useRef({ sessionId, provider, modelId });
  requestOptions.current = { sessionId, provider, modelId };
  const [transport] = useState(
    () =>
      new DefaultChatTransport<CoachMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages: outgoingMessages }) => {
          const lastMessage = outgoingMessages.at(-1);
          const content =
            lastMessage?.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("") ?? "";
          return {
            body: {
              ...(requestOptions.current.sessionId
                ? { sessionId: requestOptions.current.sessionId }
                : {}),
              provider: requestOptions.current.provider,
              modelId: requestOptions.current.modelId,
              content,
            },
          };
        },
      }),
  );
  const {
    messages,
    sendMessage: sendChatMessage,
    setMessages,
    status,
  } = useChat<CoachMessage>({
    transport,
    onError: (chatError) => {
      const message = chatError.message.toLowerCase();
      setError(
        message.includes("provider_key_missing")
          ? "Brak klucza dla wybranego dostawcy. Dodaj go w ustawieniach kluczy AI."
          : "Model jest chwilowo niedostepny. Sprobuj ponownie lub wybierz inny model.",
      );
    },
    onFinish: () => {
      void fetch("/api/chat", { cache: "no-store" })
        .then((response) => response.json())
        .then((data: { sessions?: ChatSession[] }) =>
          setSessions(data.sessions ?? []),
        )
        .catch(() => undefined);
    },
  });
  const sending = preparing || status === "submitted" || status === "streaming";

  useEffect(() => {
    const preference = readModelPreference(providers);
    setProvider(preference.provider);
    setModelId(preference.modelId);
  }, [providers]);

  useEffect(() => {
    let active = true;
    void fetch("/api/chat", { cache: "no-store" })
      .then((response) => response.json())
      .then(async (data: { sessions?: ChatSession[] }) => {
        if (!active) return;
        const savedSessions = data.sessions ?? [];
        setSessions(savedSessions);
        const selected = initialSessionId
          ? savedSessions.find((saved) => saved.sessionId === initialSessionId)
          : savedSessions[0];
        if (!selected) {
          setSessionId(null);
          setMessages([]);
          if (initialSessionId) setError("Nie mozna odnalezc tej rozmowy.");
          return;
        }
        setSessionId(selected.sessionId);
        setError("");
        const response = await fetch(
          `/api/chat?sessionId=${encodeURIComponent(selected.sessionId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error("history_unavailable");
        const history = (await response.json()) as { messages?: ChatMessage[] };
        if (active) setMessages(toUIMessages(history.messages ?? []));
      })
      .catch(() => {
        if (active) setError("Nie mozna wczytac historii rozmow.");
      });
    return () => {
      active = false;
    };
  }, [initialSessionId, setMessages]);

  useEffect(() => {
    endOfMessages.current?.scrollIntoView({ block: "end" });
  }, [messages, sending]);

  async function selectSession(nextSessionId: string) {
    setSessionId(nextSessionId);
    setError("");
    try {
      const response = await fetch(
        `/api/chat?sessionId=${encodeURIComponent(nextSessionId)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("history_unavailable");
      const data = (await response.json()) as { messages?: ChatMessage[] };
      setMessages(toUIMessages(data.messages ?? []));
    } catch {
      setError("Nie mozna wczytac tej rozmowy.");
    }
  }

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending || providers.length === 0) return;
    setDraft("");
    setError("");
    setPreparing(true);
    let activeSessionId = sessionId;
    try {
      if (!activeSessionId) {
        const response = await fetch("/api/chat/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: content.slice(0, 120) }),
        });
        if (!response.ok) throw new Error("chat_session_create_failed");
        const created = (await response.json()) as ChatSession;
        activeSessionId = created.sessionId;
        setSessionId(created.sessionId);
        setSessions((current) => [
          created,
          ...current.filter((saved) => saved.sessionId !== created.sessionId),
        ]);
      }
      requestOptions.current = { sessionId: activeSessionId, provider, modelId };
      await sendChatMessage({ text: content });
    } catch {
      setError("Nie udalo sie rozpoczac rozmowy. Sprobuj ponownie.");
    } finally {
      setPreparing(false);
    }
  }

  return (
    <section id="coach" className="coach-section">
      <div className="section-title">
        <div className="coach-heading">
          <MessageCircle size={18} />
          <h2>Trener AI</h2>
        </div>
        {providers.length > 0 && (
          <div className="coach-controls">
            <label className="coach-provider">
              <span className="sr-only">Dostawca modelu AI</span>
              <select
                value={provider}
                onChange={(event) => {
                  const nextProvider = event.target.value as AIProvider;
                  const nextModel = defaultChatModels[nextProvider];
                  setProvider(nextProvider);
                  setModelId(nextModel);
                  saveModelPreference(nextProvider, nextModel);
                }}
                disabled={sending}
              >
                {providers.map((availableProvider) => (
                  <option key={availableProvider} value={availableProvider}>
                    {providerNames[availableProvider]}
                  </option>
                ))}
              </select>
            </label>
            <label className="coach-model">
              <span className="sr-only">Model AI</span>
              <select
                value={modelId}
                onChange={(event) => {
                  setModelId(event.target.value);
                  saveModelPreference(provider, event.target.value);
                }}
                disabled={sending}
              >
                {chatModels[provider].map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      {providers.length === 0 ? (
        <p className="coach-empty">
          Dodaj klucz dostawcy w <a href="/settings#ai-keys">ustawieniach AI</a>, aby rozpoczac rozmowe.
        </p>
      ) : (
        <div className="chat-layout">
          <aside className="chat-history" aria-label="Historia rozmow">
            <button
              className="chat-new"
              type="button"
              onClick={() => {
                setSessionId(null);
                setMessages([]);
                setError("");
              }}
              disabled={sending}
            >
              <Plus size={16} /> Nowa rozmowa
            </button>
            <div className="chat-session-list">
              {sessions.map((savedSession) => (
                <button
                  className={savedSession.sessionId === sessionId ? "chat-session active" : "chat-session"}
                  key={savedSession.sessionId}
                  type="button"
                  onClick={() => void selectSession(savedSession.sessionId)}
                  disabled={sending}
                >
                  <span>{savedSession.title}</span>
                </button>
              ))}
            </div>
          </aside>
          <div className="chat-main">
            <div className="chat-messages" role="log" aria-live="polite">
              {messages.length === 0 && !sending && (
                <div className="chat-welcome">
                  <MessageCircle size={22} />
                  <p>Jak sie dzis czujesz na trening?</p>
                </div>
              )}
              {messages.map((message) => {
                const text = message.parts
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("");
                const progress = message.parts.find((part) => part.type === "data-thinking");
                if (!text && !progress) return null;
                return (
                  <article className={`chat-message ${message.role}`} key={message.id}>
                    <span>{message.role === "user" ? "Ty" : "Trener"}</span>
                    {message.role === "assistant" && progress && (
                      <ThinkingStepper progress={progress.data} complete={Boolean(text)}
                        failed={status === "error" && message.id === messages.at(-1)?.id} />
                    )}
                    {text && <p>{text}</p>}
                  </article>
                );
              })}
              {sending && messages.at(-1)?.role !== "assistant" && (
                <article className="chat-message assistant">
                  <span>Trener</span>
                  <ThinkingStepper progress={{ stage: "telemetry" }} />
                </article>
              )}
              <div ref={endOfMessages} />
            </div>
            <form className="chat-compose" onSubmit={sendMessage}>
              <label className="sr-only" htmlFor="coach-message">Wiadomosc do trenera</label>
              <textarea
                id="coach-message"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Zapytaj o trening lub regeneracje"
                maxLength={4000}
                rows={2}
                disabled={sending}
              />
              <button
                className="chat-send"
                type="submit"
                aria-label="Wyslij wiadomosc"
                title="Wyslij wiadomosc"
                disabled={sending || !draft.trim()}
              >
                {sending ? <LoaderCircle className="pending-icon" size={18} /> : <Send size={18} />}
              </button>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}