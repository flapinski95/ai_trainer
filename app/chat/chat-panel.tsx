"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Archive, ArchiveRestore, ArrowUp, Brain, Check, ChevronDown, Copy, History, LoaderCircle, MessageCircle, Orbit, Plus, RotateCw, Sparkles } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AIProvider } from "@/backend/ai/credentials";
import { chatModels, defaultChatModels } from "@/backend/ai/models";
import { readModelPreference, saveModelPreference } from "../ai-model-preferences";
import { readAIDataPreferences } from "@/lib/ai-data-preferences";
import { ThinkingStepper, type CoachMessage } from "./thinking-stepper";
import styles from "./chat.module.css";

type ChatSession = { sessionId: string; title: string; updatedAt: string; archived?: boolean };
type ChatMessage = { messageId: string; role: "user" | "assistant"; content: string };

const providerNames: Record<AIProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
};

const providerIcons = { openai: Orbit, anthropic: Brain, google: Sparkles };

function chatErrorMessage(message: string) {
  const errors: Record<string, string> = {
    provider_key_missing: "Brak klucza dla wybranego dostawcy. Dodaj go w ustawieniach AI.",
    chat_message_save_failed: "Nie udało się zapisać odpowiedzi. Spróbuj ponownie.",
    provider_rate_limited: "Dostawca AI zgłosił limit zapytań lub limit konta (429). Spróbuj później albo sprawdź limity klucza.",
    provider_auth_failed: "Dostawca AI odrzucił klucz (401). Zaktualizuj go w ustawieniach AI.",
    provider_access_denied: "Klucz nie ma dostępu do wybranego modelu (403). Sprawdź uprawnienia lub wybierz inny model.",
    provider_model_not_found: "Wybrany model nie istnieje lub nie jest dostępny dla tego klucza (404). Wybierz inny model.",
    provider_invalid_request: "Dostawca AI odrzucił żądanie (400). Sprawdź model i konfigurację klucza.",
    provider_timeout: "Upłynął czas oczekiwania na model. Spróbuj ponownie później.",
    provider_unavailable: "Model jest przeciążony lub chwilowo niedostępny. Spróbuj ponownie później.",
  };
  return Object.entries(errors).find(([code]) => message.toLowerCase().includes(code))?.[1]
    ?? "Nie udało się uzyskać odpowiedzi modelu. Spróbuj ponownie lub wybierz inny model.";
}

function regenerationErrorMessage(reason: string) {
  return `${reason} Poprzednia odpowiedź została zachowana.`;
}

function ModelSelector({ providers, provider, modelId, disabled, onChange }: {
  providers: AIProvider[];
  provider: AIProvider;
  modelId: string;
  disabled: boolean;
  onChange: (provider: AIProvider, modelId: string) => void;
}) {
  return (
    <div className={styles.modelList}>
      {providers.map((available) => {
        const Icon = providerIcons[available];
        return <fieldset key={available} className={styles.providerGroup} disabled={disabled}>
          <legend>{providerNames[available]}</legend>
          {chatModels[available].map((model) => {
            const selected = provider === available && modelId === model.id;
            return <label className={styles.modelOption} key={model.id}>
              <input className="sr-only" type="radio" name="coach-model" value={`${available}:${model.id}`}
                onClick={() => { if (selected) onChange(available, model.id); }}
                checked={selected} onChange={() => onChange(available, model.id)} />
              <span className={`${styles.modelCard} ${selected ? styles.selectedModel : ""}`}>
                <span className={styles.modelGlyph}><Icon size={19} strokeWidth={1.6} /></span>
                <span className={styles.modelCopy}><strong>{model.name}</strong><span>{model.description}</span></span>
                <span className={styles.modelCheck}>{selected && <Check size={14} strokeWidth={2.5} />}</span>
              </span>
            </label>;
          })}
        </fieldset>;
      })}
    </div>
  );
}

function toUIMessages(messages: ChatMessage[]): CoachMessage[] {
  return messages.map((message) => ({
    id: message.messageId,
    role: message.role,
    parts: [{ type: "text", text: message.content }],
  }));
}

export function ChatPanel({ providers, initialSessionId, userId }: { providers: AIProvider[]; initialSessionId?: string; userId: string }) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [provider, setProvider] = useState<AIProvider>(providers[0] ?? "openai");
  const [modelId, setModelId] = useState<string>(defaultChatModels[providers[0] ?? "openai"]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState<"history" | "settings">("settings");
  const [historyView, setHistoryView] = useState<"active" | "archived">("active");
  const [pendingArchive, setPendingArchive] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState("");
  const [historyNotice, setHistoryNotice] = useState("");
  const [revealedSession, setRevealedSession] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [failedAnswers, setFailedAnswers] = useState<Set<string>>(() => new Set());
  const regeneration = useRef<{ messageId: string; snapshot: CoachMessage[] } | null>(null);
  const lastChatError = useRef<string | null>(null);
  const drawerDialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const grabberStart = useRef<{ pointerId: number; y: number } | null>(null);
  const grabberDistance = useRef(0);
  const rowSwipe = useRef<{ x: number; y: number } | null>(null);
  const suppressRowClick = useRef(false);
  const sessionMutation = useRef(0);
  const historyRequest = useRef(0);
  const messageList = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const followLatest = useRef(true);
  const requestOptions = useRef({ sessionId, provider, modelId, userId });
  requestOptions.current = { sessionId, provider, modelId, userId };
  const [transport] = useState(() => new DefaultChatTransport<CoachMessage>({
    api: "/api/chat",
    prepareSendMessagesRequest: ({ messages: outgoingMessages, trigger, messageId }) => ({
      body: {
        ...(requestOptions.current.sessionId ? { sessionId: requestOptions.current.sessionId } : {}),
        provider: requestOptions.current.provider,
        modelId: requestOptions.current.modelId,
        dataPreferences: readAIDataPreferences(requestOptions.current.userId),
        content: outgoingMessages.findLast((message) => message.role === "user")?.parts
          .filter((part) => part.type === "text").map((part) => part.text).join("") ?? "",
        ...(trigger === "regenerate-message" && messageId ? { regenerateMessageId: messageId } : {}),
      },
    }),
  }));
  const { messages, sendMessage: sendChatMessage, regenerate, clearError, setMessages, status } = useChat<CoachMessage>({
    transport,
    onError: (chatError) => {
      const reason = chatErrorMessage(chatError.message);
      lastChatError.current = reason;
      setError(regeneration.current ? regenerationErrorMessage(reason) : reason);
    },
    onFinish: ({ message, isAbort, isDisconnect, isError }) => {
      const pending = regeneration.current;
      const completed = !isAbort && !isDisconnect && !isError;
      setFailedAnswers((current) => {
        const next = new Set(current);
        if (!pending && !completed) next.add(message.id);
        else if (completed) next.delete(message.id);
        return next;
      });
      if (pending) {
        setMessages(completed ? pending.snapshot.map((saved) => saved.id === pending.messageId ? message : saved) : pending.snapshot);
        regeneration.current = null;
        if (!completed) setError(regenerationErrorMessage(lastChatError.current ?? "Nie udało się ponowić odpowiedzi."));
      }
      const version = sessionMutation.current;
      void fetch("/api/chat", { cache: "no-store" })
        .then((response) => { if (!response.ok) throw new Error("history_unavailable"); return response.json(); })
        .then((data: { sessions?: ChatSession[] }) => {
          if (version === sessionMutation.current) setSessions(data.sessions ?? []);
        })
        .catch(() => undefined);
    },
  });
  const sending = preparing || status === "submitted" || status === "streaming";
  const busy = sending || loading || pendingArchive !== null;

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => { setFeedback(null); setCopiedMessageId(null); }, 2200);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    const preference = readModelPreference(providers);
    setProvider(preference.provider);
    setModelId(preference.modelId);
  }, [providers]);

  useEffect(() => {
    const controller = new AbortController();
    const request = ++historyRequest.current;
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch("/api/chat", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("history_unavailable");
        const data = await response.json() as { sessions?: ChatSession[] };
        if (request !== historyRequest.current) return;
        const saved = data.sessions ?? [];
        setSessions(saved);
        const selected = initialSessionId ? saved.find((item) => item.sessionId === initialSessionId) : saved.find((item) => !item.archived);
        setSessionId(selected?.sessionId ?? null);
        setMessages([]);
        if (!selected) {
          if (initialSessionId) setError("Nie można odnaleźć tej rozmowy.");
          return;
        }
        const historyResponse = await fetch(`/api/chat?sessionId=${encodeURIComponent(selected.sessionId)}`, {
          cache: "no-store", signal: controller.signal,
        });
        if (!historyResponse.ok) throw new Error("history_unavailable");
        const history = await historyResponse.json() as { messages?: ChatMessage[] };
        if (request === historyRequest.current) setMessages(toUIMessages(history.messages ?? []));
      } catch {
        if (!controller.signal.aborted && request === historyRequest.current) setError("Nie można wczytać historii rozmów.");
      } finally {
        if (!controller.signal.aborted && request === historyRequest.current) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [initialSessionId, setMessages]);

  useEffect(() => {
    const container = messageList.current;
    if (container && followLatest.current) container.scrollTop = container.scrollHeight;
  }, [messages, sending, loading]);

  useEffect(() => {
    const input = textarea.current;
    if (!input) return;
    function resize() {
      if (!input) return;
      input.style.height = "0px";
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    }
    resize();
    let width = 0;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth !== width) {
        width = input.clientWidth;
        resize();
      }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [draft]);

  useEffect(() => {
    const form = composer.current;
    if (!form) return;
    const observer = new ResizeObserver(() => {
      panel.current?.style.setProperty("--composer-height", `${form.offsetHeight}px`);
      const container = messageList.current;
      if (container && followLatest.current) container.scrollTop = container.scrollHeight;
    });
    observer.observe(form);
    return () => observer.disconnect();
  }, [providers.length]);

  async function selectSession(nextSessionId: string) {
    if (busy || nextSessionId === sessionId) return;
    const request = ++historyRequest.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/chat?sessionId=${encodeURIComponent(nextSessionId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("history_unavailable");
      const data = await response.json() as { messages?: ChatMessage[] };
      if (request !== historyRequest.current) return;
      followLatest.current = true;
      setSessionId(nextSessionId);
      setMessages(toUIMessages(data.messages ?? []));
    } catch {
      if (request === historyRequest.current) setError("Nie można wczytać tej rozmowy.");
    } finally {
      if (request === historyRequest.current) setLoading(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy || providers.length === 0) return;
    setDraft("");
    setError("");
    lastChatError.current = null;
    setPreparing(true);
    followLatest.current = true;
    let activeSessionId = sessionId;
    try {
      if (!activeSessionId) {
        const response = await fetch("/api/chat/sessions", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: content.slice(0, 120) }),
        });
        if (!response.ok) throw new Error("chat_session_create_failed");
        const created = await response.json() as ChatSession;
        activeSessionId = created.sessionId;
        setSessionId(created.sessionId);
        setSessions((current) => [created, ...current.filter((saved) => saved.sessionId !== created.sessionId)]);
      }
      requestOptions.current = { sessionId: activeSessionId, provider, modelId };
      setPreparing(false);
      await sendChatMessage({ text: content });
    } catch {
      setError("Nie udało się rozpocząć rozmowy. Spróbuj ponownie.");
      setDraft(content);
    } finally {
      setPreparing(false);
    }
  }

  const lastMessage = messages.at(-1);
  const hasActiveAssistant = !preparing && sending && lastMessage?.role === "assistant";

  async function copyAnswer(messageId: string, text: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(messageId);
      setFeedback({ text: "Skopiowano odpowiedź", error: false });
    } catch {
      setCopiedMessageId(null);
      setFeedback({ text: "Nie udało się skopiować odpowiedzi. Sprawdź uprawnienia schowka.", error: true });
    }
  }

  async function regenerateAnswer(messageId: string) {
    if (busy || !sessionId || regeneration.current) return;
    const index = messages.findIndex((message) => message.id === messageId && message.role === "assistant");
    const prompt = messages.slice(0, index).findLast((message) => message.role === "user");
    if (index < 0 || !prompt) {
      setError("Nie można odnaleźć pytania do tej odpowiedzi.");
      return;
    }
    const snapshot = [...messages];
    regeneration.current = { messageId, snapshot };
    requestOptions.current = { sessionId, provider, modelId };
    setError("");
    lastChatError.current = null;
    clearError();
    followLatest.current = true;
    try {
      await regenerate({ messageId });
    } catch (retryError) {
      setMessages(snapshot);
      regeneration.current = null;
      setError(regenerationErrorMessage(lastChatError.current ?? chatErrorMessage(retryError instanceof Error ? retryError.message : "")));
    }
  }

  function openDrawer(nextDrawer: "history" | "settings") {
    setDrawer(nextDrawer);
    setArchiveError("");
    setHistoryNotice("");
    setRevealedSession(null);
    drawerDialog.current?.style.setProperty("--sheet-offset", "0px");
    drawerDialog.current?.showModal();
  }

  function startNewConversation() {
    if (busy || providers.length === 0) return;
    setSessionId(null);
    setMessages([]);
    setError("");
    setDraft("");
    followLatest.current = true;
    drawerDialog.current?.close();
    textarea.current?.focus();
  }

  async function changeArchived(saved: ChatSession) {
    if (busy) return;
    const archived = !saved.archived;
    sessionMutation.current += 1;
    setPendingArchive(saved.sessionId);
    setArchiveError("");
    setHistoryNotice("");
    try {
      const response = await fetch("/api/chat/sessions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: saved.sessionId, archived }),
      });
      if (!response.ok) throw new Error("archive_failed");
      setSessions((current) => current.map((item) => item.sessionId === saved.sessionId ? { ...item, archived } : item));
      if (archived && sessionId === saved.sessionId) {
        setSessionId(null);
        setMessages([]);
        setDraft("");
        followLatest.current = true;
      }
      setRevealedSession(null);
      setHistoryNotice(archived ? "Rozmowa przeniesiona do archiwum." : "Rozmowa przywrócona.");
    } catch {
      setArchiveError("Nie udało się zapisać zmiany. Spróbuj ponownie.");
    } finally {
      setPendingArchive(null);
    }
  }

  const modelName = chatModels[provider].find((model) => model.id === modelId)?.name ?? "Wybierz model";
  const visibleSessions = sessions.filter((saved) => Boolean(saved.archived) === (historyView === "archived"));

  return (
    <section ref={panel} className={styles.panel} aria-label="Rozmowa z trenerem AI">
      <header className={styles.pageHeader}>
        <h1 className="sr-only">Odprawa</h1>
        <button className={styles.iconButton} type="button" aria-label="Historia rozmów" title="Historia rozmów"
          aria-haspopup="dialog" onClick={() => openDrawer("history")}><History size={19} strokeWidth={1.6} /></button>
        <button className={styles.modelPill} type="button" aria-label={`Wybierz model: ${modelName}`} title={modelName}
          aria-haspopup="dialog" onClick={() => openDrawer("settings")}><span>{modelName}</span><ChevronDown size={12} /></button>
        <button className={styles.iconButton} type="button" aria-label="Nowa rozmowa" title="Nowa rozmowa"
          disabled={busy || providers.length === 0} onClick={startNewConversation}><Plus size={21} strokeWidth={1.6} /></button>
      </header>
      <dialog ref={drawerDialog} className={styles.drawer} aria-labelledby="chat-drawer-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.currentTarget.close();
          }
        }}
        onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <div className={styles.drawerContent}>
          <button className={styles.grabber} type="button" aria-label="Zamknij panel" title="Zamknij panel"
            onPointerDown={(event) => {
              grabberStart.current = { pointerId: event.pointerId, y: event.clientY };
              grabberDistance.current = 0;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (grabberStart.current?.pointerId !== event.pointerId) return;
              grabberDistance.current = Math.max(0, event.clientY - grabberStart.current.y);
              drawerDialog.current?.style.setProperty("--sheet-offset", `${grabberDistance.current}px`);
            }}
            onPointerUp={() => {
              if (grabberDistance.current > 80) drawerDialog.current?.close();
              drawerDialog.current?.style.setProperty("--sheet-offset", "0px");
              grabberStart.current = null;
            }}
            onPointerCancel={() => {
              grabberStart.current = null;
              grabberDistance.current = 0;
              drawerDialog.current?.style.setProperty("--sheet-offset", "0px");
            }}
            onClick={(event) => {
              if (event.detail === 0 || grabberDistance.current < 8) drawerDialog.current?.close();
            }}><span /></button>
          <div className={styles.drawerHeading}><h2 id="chat-drawer-title">{drawer === "history" ? "Rozmowy" : "Wybierz model"}</h2></div>
          {drawer === "history" && <div className={styles.historyTabs} role="group" aria-label="Widok rozmów">
            <button type="button" aria-pressed={historyView === "active"} onClick={() => setHistoryView("active")}>Aktywne</button>
            <button type="button" aria-pressed={historyView === "archived"} onClick={() => setHistoryView("archived")}><Archive size={13} />Archiwum</button>
          </div>}
          <div className={`${styles.sheetBody} ${styles.scrollbarNone}`}>
            {drawer === "settings" ? providers.length > 0 ? <ModelSelector providers={providers} provider={provider}
              modelId={modelId} disabled={busy} onChange={(nextProvider, nextModel) => {
                setProvider(nextProvider); setModelId(nextModel); saveModelPreference(nextProvider, nextModel);
                drawerDialog.current?.close();
              }} /> : <p className={styles.drawerEmpty}>Dodaj klucz w <a href="/settings#ai-keys">ustawieniach AI</a>.</p>
              : <>
                {archiveError && <p className={styles.sheetError} role="alert">{archiveError}</p>}
                {historyNotice && <p className={styles.historyNotice} role="status">{historyNotice}</p>}
                <div className={styles.sessionList} role="navigation" aria-label="Rozmowy">
                  {visibleSessions.map((saved) => <div key={saved.sessionId}
                    className={`${styles.sessionRow} ${saved.sessionId === sessionId ? styles.activeSession : ""} ${revealedSession === saved.sessionId ? styles.revealedSession : ""}`}
                    onTouchStart={(event) => {
                      suppressRowClick.current = false;
                      rowSwipe.current = event.touches.length === 1 && event.touches[0]
                        ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
                    }}
                    onTouchCancel={() => { rowSwipe.current = null; }}
                    onTouchEnd={(event) => {
                      const touch = event.changedTouches[0];
                      const start = rowSwipe.current;
                      rowSwipe.current = null;
                      if (start && touch && touch.clientX - start.x < -36 && Math.abs(touch.clientY - start.y) < 24) {
                        suppressRowClick.current = true;
                        setRevealedSession(saved.sessionId);
                      }
                    }}>
                    <button className={styles.session} type="button" aria-current={saved.sessionId === sessionId ? "page" : undefined}
                      title={saved.title} disabled={busy} onClick={() => {
                        if (suppressRowClick.current) { suppressRowClick.current = false; return; }
                        drawerDialog.current?.close();
                        void selectSession(saved.sessionId);
                      }}><MessageCircle size={16} strokeWidth={1.5} /><span>{saved.title}</span></button>
                    <button className={styles.archiveAction} type="button" disabled={busy}
                      aria-label={`${saved.archived ? "Przywróć" : "Archiwizuj"} rozmowę: ${saved.title}`}
                      title={saved.archived ? "Przywróć rozmowę" : "Archiwizuj rozmowę"} onClick={() => void changeArchived(saved)}>
                      {pendingArchive === saved.sessionId ? <LoaderCircle size={16} className="pending-icon" />
                        : saved.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                    </button>
                  </div>)}
                  {visibleSessions.length === 0 && <p className={styles.drawerEmpty}>{loading ? "Wczytywanie rozmów..."
                    : historyView === "archived" ? "Archiwum jest puste." : "Brak aktywnych rozmów."}</p>}
                </div>
              </>}
          </div>
        </div>
      </dialog>
      {feedback && <div className={styles.feedback} role={feedback.error ? "alert" : "status"} aria-live="polite"
        data-error={feedback.error}>{feedback.text}</div>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {providers.length === 0 ? <div className={styles.empty}>
        <MessageCircle size={28} /><h2>Twój trener czeka</h2>
        <p>Dodaj klucz dostawcy w <a href="/settings#ai-keys">ustawieniach AI</a>, aby rozpocząć rozmowę.</p>
      </div> : <>
        <div ref={messageList} className={`${styles.messages} ${styles.scrollbarNone}`} role="log"
          aria-label="Wiadomości" aria-live="polite" aria-relevant="additions text" aria-busy={loading}
          onScroll={(event) => {
            const container = event.currentTarget;
            followLatest.current = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
          }}>
          {loading && <div className={styles.empty} role="status"><LoaderCircle size={22} className="pending-icon" /><p>Wczytywanie rozmowy...</p></div>}
          {!loading && messages.length === 0 && !sending && <div className={styles.empty}>
            <MessageCircle size={28} /><h2>Jak się dziś czujesz?</h2><p>Porozmawiajmy o treningu i regeneracji.</p>
          </div>}
          {!loading && messages.map((message) => {
            const text = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
            const progress = message.parts.find((part) => part.type === "data-thinking");
            const active = hasActiveAssistant && message.id === lastMessage?.id;
            if (!text && !active) return null;
            return <article key={message.id} className={`${styles.message} ${message.role === "user" ? styles.user : styles.assistant}`}
              aria-label={message.role === "user" ? "Wiadomość użytkownika" : "Odpowiedź trenera"}>
              {message.role === "assistant" && active && <ThinkingStepper progress={progress?.data ?? { stage: "telemetry" }}
                complete={Boolean(text)} />}
              {text && (message.role === "assistant" ? <div className={styles.markdown}>
                <Markdown remarkPlugins={[remarkGfm]} components={{
                  table: ({ children }) => <div className={`${styles.tableScroll} ${styles.scrollbarNone}`} tabIndex={0} role="region" aria-label="Tabela trenera"><table>{children}</table></div>,
                  a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
                }}>{text}</Markdown>
              </div> : <p className={styles.userText}>{text}</p>)}
              {message.role === "assistant" && text && !active && !failedAnswers.has(message.id) && (
                <div className={styles.messageActions} role="group" aria-label="Akcje odpowiedzi">
                  <button type="button" aria-label={copiedMessageId === message.id ? "Skopiowano odpowiedź" : "Kopiuj odpowiedź"}
                    title={copiedMessageId === message.id ? "Skopiowano odpowiedź" : "Kopiuj odpowiedź"}
                    onClick={() => void copyAnswer(message.id, text)}>
                    {copiedMessageId === message.id ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                  <button type="button" aria-label="Ponów odpowiedź" title="Ponów odpowiedź" disabled={busy || !sessionId || providers.length === 0}
                    onClick={() => void regenerateAnswer(message.id)}><RotateCw size={16} /></button>
                </div>
              )}
            </article>;
          })}
          {sending && !hasActiveAssistant && <article className={`${styles.message} ${styles.assistant}`} aria-label="Odpowiedź trenera">
            <ThinkingStepper progress={{ stage: "telemetry" }} />
          </article>}
        </div>
        <form ref={composer} className={styles.composer} onSubmit={sendMessage}>
          <label className="sr-only" htmlFor="coach-message">Wiadomość do trenera</label>
          <textarea ref={textarea} id="coach-message" className={styles.scrollbarNone} value={draft}
            onChange={(event) => setDraft(event.target.value)} placeholder="Zapytaj o trening lub regenerację..."
            maxLength={4000} rows={1} readOnly={busy} aria-disabled={busy}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault(); event.currentTarget.form?.requestSubmit();
              }
            }} />
          <button className={styles.send} type="submit" aria-label="Wyślij wiadomość" title="Wyślij wiadomość"
            disabled={busy || !draft.trim()}>
            {sending ? <LoaderCircle className="pending-icon" size={19} /> : <ArrowUp size={20} />}
          </button>
        </form>
      </>}
    </section>
  );
}