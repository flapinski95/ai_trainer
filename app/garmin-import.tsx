"use client";

import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import styles from "./settings/settings.module.css";

export function GarminImport({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (!enabled || pending) return;
    const file = event.dataTransfer.files.item(0);
    if (!file || !fileInput.current) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.current.files = transfer.files;
    setFileName(file.name);
    setFailed(false);
    setMessage("");
  }

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
        <label
          className={`${styles.fileDropZone} ${dragging ? styles.fileDropActive : ""} ${!enabled || pending ? styles.fileDropDisabled : ""}`}
          htmlFor="garmin-history-file"
          aria-disabled={!enabled || pending}
          onDragOver={(event) => {
            event.preventDefault();
            if (enabled && !pending) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <input
            ref={fileInput}
            className={styles.fileInput}
            id="garmin-history-file"
            name="file"
            type="file"
            accept=".zip,.fit,.csv,.json"
            required
            disabled={!enabled || pending}
            onChange={(event) => {
              const file = event.target.files?.item(0);
              setFileName(file?.name ?? "");
              setFailed(false);
              setMessage("");
            }}
          />
          <Upload size={19} aria-hidden="true" />
          <span className={styles.fileDropPrimary}>
            {fileName || "Upuść plik ZIP / FIT / CSV tutaj lub kliknij, aby wybrać"}
          </span>
          <span className={styles.fileDropHint}>ZIP · FIT · CSV · JSON · do 25 MB</span>
        </label>
        <button className="garmin-button" type="submit" disabled={!enabled || pending}>
          <Upload size={16} />{pending ? "Importowanie..." : "Importuj historię"}
        </button>
      </form>
      {!enabled && <p className="settings-empty">Zaloguj się, aby zaimportować historię.</p>}
      {message && <p className={failed ? "notice" : "notice notice-success"} role={failed ? "alert" : "status"}>{message}</p>}
    </section>
  );
}