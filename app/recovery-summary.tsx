"use client";

import { useEffect, useState } from "react";
import { Activity, HeartPulse, Moon, Zap } from "lucide-react";

type DailyMetric = {
  date?: string | null;
  values?: {
    hrvLastNightAverage?: number;
    bodyBattery?: number;
    sleepDurationSeconds?: number;
    sleepScore?: number;
    restingHeartRate?: number;
  };
};

export function RecoverySummary({ enabled }: { enabled: boolean }) {
  const [metric, setMetric] = useState<DailyMetric | null>(null);

  useEffect(() => {
    if (!enabled) {
      setMetric(null);
      return;
    }

    let active = true;
    let pending = false;
    let retryOnResume = false;
    let controller: AbortController | undefined;
    let interval: number | undefined;

    function stopPolling() {
      if (interval === undefined) return;
      window.clearInterval(interval);
      interval = undefined;
    }

    function startPolling() {
      if (interval !== undefined) return;
      interval = window.setInterval(() => void refresh(), 5000);
    }

    async function refresh() {
      if (!active || pending || document.visibilityState === "hidden") return;
      pending = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 10000);
      try {
        let response: Response | undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          response = await fetch("/api/health/daily", {
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
          });
          if (response.status !== 401 || attempt === 2) break;
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 400 * (attempt + 1));
          });
        }
        if (!response || !response.ok) {
          if (active) setMetric(null);
          retryOnResume = true;
          stopPolling();
          return;
        }
        const dailyMetric = await response.json() as DailyMetric;
        if (active) setMetric(dailyMetric);
      } catch {
        if (active) setMetric(null);
        retryOnResume = true;
        stopPolling();
      } finally {
        window.clearTimeout(timeout);
        pending = false;
      }
    }
    void refresh();
    startPolling();
    const resume = () => {
      if (!active || document.visibilityState === "hidden") return;
      if (retryOnResume) {
        retryOnResume = false;
        startPolling();
      }
      void refresh();
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);

    return () => {
      active = false;
      controller?.abort();
      stopPolling();
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [enabled]);

  const values = metric?.values;
  const sleepDuration = values?.sleepDurationSeconds;
  const sleepTime = sleepDuration !== undefined
    ? `${Math.floor(sleepDuration / 3600)}h ${Math.floor((sleepDuration % 3600) / 60)}m`
    : undefined;
  const sleepValue = sleepTime && values?.sleepScore !== undefined
    ? `${sleepTime} (${Math.round(values.sleepScore)}/100)`
    : sleepTime ?? (values?.sleepScore !== undefined ? `${Math.round(values.sleepScore)}/100` : undefined);
  const items = [
    { label: "HRV", value: values?.hrvLastNightAverage, unit: "ms", progressMax: 100, detail: undefined, icon: HeartPulse },
    { label: "Body Battery", value: values?.bodyBattery, unit: "/ 100", progressMax: 100, detail: undefined, icon: Zap },
    { label: "Sen", value: values?.sleepScore, unit: "/ 100", progressMax: 100, detail: sleepTime, icon: Moon },
    { label: "Tętno spoczynkowe", value: values?.restingHeartRate, unit: "bpm", progressMax: 120, detail: undefined, icon: Activity },
  ];

  return (
    <section className="dashboard-recovery-grid" aria-label="Regeneracja z Garmin Connect">
      {items.map(({ label, value, unit, progressMax, detail, icon: Icon }) => {
        const progress = value === undefined
          ? 0
          : Math.min(100, Math.max(0, value / progressMax * 100));
        return (
          <article className="dashboard-recovery-card" key={label}>
            <div className="dashboard-recovery-card-heading">
              <span className="dashboard-recovery-icon"><Icon size={16} aria-hidden="true" /></span>
              <h2>{label}</h2>
            </div>
            <p className="dashboard-recovery-value">
              <strong>{value === undefined ? "—" : Math.round(value)}</strong>
              <span>{unit}</span>
            </p>
            <p className="dashboard-recovery-detail">{detail ?? ""}</p>
            <span className="dashboard-recovery-track" aria-hidden="true">
              <span style={{ width: `${progress}%` }} />
            </span>
          </article>
        );
      })}
    </section>
  );
}