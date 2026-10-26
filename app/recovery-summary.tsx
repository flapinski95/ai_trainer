"use client";

import { useEffect, useState } from "react";
import { Activity, HeartPulse, Moon, Zap } from "lucide-react";
import Link from "next/link";

type DailyMetric = {
  date?: string;
  values?: {
    hrvLastNightAverage?: number;
    bodyBattery?: number;
    sleepScore?: number;
    restingHeartRate?: number;
  };
};

export function RecoverySummary({ enabled }: { enabled: boolean }) {
  const [metric, setMetric] = useState<DailyMetric | null>(null);
  const [message, setMessage] = useState("Wczytywanie danych...");
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setMetric(null);
      setUnavailable(false);
      setMessage("");
      return;
    }

    let active = true;
    let pending = false;
    let controller: AbortController | undefined;
    setMessage("Wczytywanie danych...");
    async function refresh() {
      if (!active || pending || document.visibilityState === "hidden") return;
      pending = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 10000);
      try {
        const response = await fetch("/api/health/daily", { cache: "no-store", signal: controller.signal });
        if ([401, 403, 404].includes(response.status)) {
          if (active) {
            setMetric(null);
            setUnavailable(false);
            setMessage("");
          }
          return;
        }
        if (!response.ok) throw new Error("metric_unavailable");
        const dailyMetric = await response.json() as DailyMetric;
        if (active) {
          setMetric(dailyMetric);
          setUnavailable(false);
          setMessage("");
        }
      } catch {
        if (active) {
          setUnavailable(true);
          setMessage("Nie można odświeżyć pomiarów. Ponawianie połączenia...");
        }
      } finally {
        window.clearTimeout(timeout);
        pending = false;
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    const resume = () => void refresh();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);

    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [enabled]);

  const values = metric?.values;
  const items = [
    { label: "HRV", value: values?.hrvLastNightAverage, unit: "ms", icon: HeartPulse },
    { label: "Body Battery", value: values?.bodyBattery, unit: "/ 100", icon: Zap },
    { label: "Sen", value: values?.sleepScore, unit: "/ 100", icon: Moon },
    { label: "Tętno spoczynkowe", value: values?.restingHeartRate, unit: "bpm", icon: Activity },
  ];
  const hasValues = items.some(({ value }) => value !== undefined);
  const metricDate = metric?.date
    ? new Intl.DateTimeFormat("pl-PL", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(new Date(`${metric.date}T12:00:00Z`))
    : "—";

  return (
    <section className="recovery-panel" aria-labelledby="recovery-heading">
      <div className="section-title">
        <div>
          <p className="eyebrow">GARMIN CONNECT</p>
          <h2 id="recovery-heading">Regeneracja</h2>
        </div>
        <span className="muted-label">{metricDate}</span>
      </div>
      <dl className="recovery-metrics">
        {items.map(({ label, value, unit, icon: Icon }) => (
          <div className="recovery-metric" key={label}>
            <dt><Icon size={16} />{label}</dt>
            <dd>
              {value === undefined ? "—" : Math.round(value)}
              <span>{unit}</span>
            </dd>
          </div>
        ))}
      </dl>
      {(!hasValues || unavailable) && message && <p className="recovery-message" role="status">{message}</p>}
      {!hasValues && !message && (
        <div className="recovery-empty">
          <p className="recovery-message">Brak danych. Oczekiwanie na pomiar z zegarka lub wgraj plik ZIP z historią</p>
          <Link href="/settings#garmin-import" className="recovery-import-link">Importuj historię</Link>
        </div>
      )}
    </section>
  );
}