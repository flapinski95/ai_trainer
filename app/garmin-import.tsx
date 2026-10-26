"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";

export function GarminImport({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    setFailed(false);
    if (!(file instanceof File) || !file.size || file.size > 25 * 1024 * 1024) {
      setFailed(true);
      setMessage("Wybierz plik ZIP, FIT, CSV lub JSON o rozmiarze do 25 MB.");
      return;
    }
    setPending(true);
    setMessage("Importowanie historii...");
    try {
      const response = await fetch("/api/garmin/import", { method: "POST", body: form });
      const result: { error?: string; imported?: number; unchanged?: number; metricsImported?: number; duplicates?: number } = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Nie udalo sie zaimportowac pliku.");
      setMessage(`Treningi: ${result.imported ?? 0}. Dni pomiarow: ${result.metricsImported ?? 0}. Duplikaty: ${result.duplicates ?? 0}. Bez zmian: ${result.unchanged ?? 0}.`);
      router.push("/?import=garmin#activities");
      router.refresh();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Nie udalo sie zaimportowac pliku.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="settings-panel garmin-import-panel" id="garmin-import" aria-labelledby="garmin-import-heading">
      <div className="section-title">
        <h2 id="garmin-import-heading">Importuj historię z Garmin Connect (.zip / .fit / .csv / .json)</h2>
        <Upload size={18} aria-hidden="true" />
      </div>
      <form onSubmit={submit} className="garmin-import-form" aria-busy={pending}>
        <label htmlFor="garmin-history-file">Plik historii</label>
        <input id="garmin-history-file" name="file" type="file" accept=".zip,.fit,.csv,.json" required disabled={!enabled || pending} />
        <button className="garmin-button" type="submit" disabled={!enabled || pending}>
          <Upload size={16} />{pending ? "Importowanie..." : "Importuj historię"}
        </button>
      </form>
      {!enabled && <p className="settings-empty">Zaloguj się, aby zaimportować historię.</p>}
      {message && <p className={failed ? "notice" : "notice notice-success"} role={failed ? "alert" : "status"}>{message}</p>}
    </section>
  );
}