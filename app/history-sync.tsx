"use client";

import { useActionState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { History, LoaderCircle } from "lucide-react";
import { synchronizeHistory } from "./actions";

export type HistoryStatus = {
  state: string;
  processed: number;
  changed: number;
  lastSuccess: number;
  retryAt: number;
  errorCode: string | null;
} | null;
export function HistorySync({
  status,
  unavailable,
}: {
  status: HistoryStatus;
  unavailable: boolean;
}) {
  const [result, action, pending] = useActionState(synchronizeHistory, {
    message: "",
  });
  const [, startTransition] = useTransition();
  const router = useRouter();
  const active = Boolean(
    status && ["QUEUED", "RUNNING", "WAITING"].includes(status.state),
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => {
        if (document.visibilityState === "visible")
          startTransition(() => router.refresh());
      },
      status?.state === "WAITING" ? 60000 : 30000,
    );
    return () => clearInterval(timer);
  }, [active, status?.state, router]);
  const format = (timestamp: number) =>
    new Intl.DateTimeFormat("pl-PL", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Warsaw",
    }).format(new Date(timestamp * 1000));
  const labels: Record<string, string> = {
    QUEUED: "W kolejce",
    RUNNING: "Synchronizacja trwa",
    WAITING:
      status?.errorCode === "RATE_LIMIT"
        ? "Oczekiwanie na limit Stravy"
        : "Oczekiwanie na ponowienie",
    SUCCEEDED: "Zsynchronizowano",
    FAILED:
      status?.errorCode === "AUTHORIZATION"
        ? "Wymagana ponowna autoryzacja"
        : "Synchronizacja przerwana",
  };
  return (
    <div className="history-sync">
      <div className="history-status" role="status">
        <strong>Historia treningowa</strong>
        <span>
          {unavailable
            ? "Status niedostepny"
            : status
              ? (labels[status.state] ?? "Status niedostepny")
              : "Jeszcze nie pobrano"}
        </span>
      </div>
      {status && (
        <p className="history-progress">
          Przetworzono: {status.processed} · Zapisano: {status.changed}
        </p>
      )}
      {status?.lastSuccess ? (
        <p className="history-progress">
          Ostatni sukces: {format(status.lastSuccess)}
        </p>
      ) : null}
      {status?.state === "WAITING" && (
        <p className="history-progress">
          Ponowienie po: {format(status.retryAt)}
        </p>
      )}
      <form action={action}>
        <button
          type="submit"
          className="history-button"
          disabled={pending || active || unavailable}
        >
          {pending ? (
            <LoaderCircle size={16} className="pending-icon" />
          ) : (
            <History size={16} />
          )}
          {pending
            ? "Zlecanie..."
            : status?.state === "FAILED"
              ? "Ponow synchronizacje"
              : "Synchronizuj historie"}
        </button>
      </form>
      {result.message && (
        <p className="history-progress" role="status">
          {result.message}
        </p>
      )}
    </div>
  );
}
