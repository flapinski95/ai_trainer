"use client";

import { useEffect, useState } from "react";
import { Bell } from "lucide-react";

type PushSupport = "checking" | "supported" | "unsupported" | "install";

export function PushSettings({ enabled }: { enabled: boolean }) {
  const [support, setSupport] = useState<PushSupport>("checking");
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (ios && !window.matchMedia("(display-mode: standalone)").matches) {
      setSupport("install");
      return;
    }
    if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setSupport("unsupported");
      return;
    }
    setSupport("supported");
    setDenied(Notification.permission === "denied");
    let active = true;
    void Promise.race([
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then(() => navigator.serviceWorker.ready),
      new Promise<never>((_resolve, reject) => {
        AbortSignal.timeout(10_000).addEventListener("abort", () => {
          reject(new Error("push_worker_unavailable"));
        }, { once: true });
      }),
    ])
      .then(async (ready) => {
        const saved = await ready.pushManager.getSubscription();
        if (active) {
          setSubscription(saved);
          setRegistration(ready);
        }
      })
      .catch(() => { if (active) setError("Nie mozna odczytac ustawien powiadomien."); });
    if (enabled) {
      void fetch("/api/push", { cache: "no-store", signal: AbortSignal.timeout(10_000) })
        .then(async (response) => {
          if (!response.ok) throw new Error("push_unavailable");
          const data: unknown = await response.json();
          if (!data || typeof data !== "object" || !("publicKey" in data) || typeof data.publicKey !== "string") throw new Error("push_unavailable");
          if (active) setPublicKey(data.publicKey);
        })
        .catch(() => { if (active) setError("Powiadomienia sa chwilowo niedostepne."); });
    }
    return () => { active = false; };
  }, [enabled]);

  async function togglePush() {
    if (!enabled || busy || support !== "supported" || !registration) return;
    setBusy(true);
    setError("");
    try {
      if (subscription) {
        const response = await fetch("/api/push", {
          method: "DELETE", headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("unsubscribe_failed");
        if (!(await subscription.unsubscribe())) throw new Error("unsubscribe_failed");
        setSubscription(null);
      } else {
        if (!publicKey) throw new Error("push_unavailable");
        const permission = Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();
        setDenied(permission === "denied");
        if (permission !== "granted") return;
        const decoded = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/"));
        const key = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
        const existing = await registration.pushManager.getSubscription();
        const created = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        try {
          const response = await fetch("/api/push", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(created.toJSON()),
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) throw new Error("subscribe_failed");
          setSubscription(created);
        } catch (error) {
          if (!existing) await created.unsubscribe();
          throw error;
        }
      }
    } catch {
      setError("Nie udalo sie zmienic ustawien powiadomien. Sprobuj ponownie.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-panel">
      <div className="section-title"><h2>Powiadomienia</h2><Bell size={18} /></div>
      {support === "install" ? <p className="settings-empty">Powiadomienia wymagaja iOS 16.4 lub nowszego oraz aplikacji uruchomionej z ekranu poczatkowego.</p> :
        support === "unsupported" ? <p className="settings-empty">Ta przegladarka nie obsluguje powiadomien Push.</p> : (
          <label className="push-toggle">
            <span>Odprawa po treningu</span>
            <input className="push-switch" type="checkbox" role="switch" checked={Boolean(subscription)}
              aria-describedby="push-status" aria-busy={busy}
              onChange={() => { void togglePush(); }} disabled={!enabled || busy || !registration || support === "checking" || (!publicKey && !subscription) || (denied && !subscription)} />
          </label>
        )}
      <p id="push-status" className="settings-empty" role="status">
        {busy ? "Zapisywanie..." : support === "checking" || (support === "supported" && !registration && !error)
          ? "Sprawdzanie dostepnosci powiadomien..."
          : support === "supported" && enabled && !denied && !error
            ? subscription ? "Powiadomienia wlaczone na tym urzadzeniu." : "Powiadomienia wylaczone na tym urzadzeniu."
            : null}
      </p>
      {!enabled && <p className="settings-empty">Zaloguj sie, aby zarzadzac powiadomieniami.</p>}
      {denied && <p className="settings-empty">Powiadomienia sa zablokowane w ustawieniach przegladarki.</p>}
      {error && <p className="notice" role="alert">{error}</p>}
    </section>
  );
}