type WorkerEvent = Event & { waitUntil(promise: Promise<unknown>): void };
type WorkerClient = {
  url: string;
  focus(): Promise<WorkerClient>;
  navigate(url: string): Promise<WorkerClient | null>;
};
type WorkerEvents = {
  install: WorkerEvent;
  activate: WorkerEvent;
  fetch: WorkerEvent & { request: Request; respondWith(response: Promise<Response>): void };
  push: WorkerEvent & { data?: { json(): unknown } };
  notificationclick: WorkerEvent & { notification: { data: unknown; close(): void } };
};
type WorkerScope = {
  location: Location;
  skipWaiting(): Promise<void>;
  registration: { showNotification(title: string, options: NotificationOptions): Promise<void> };
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WorkerClient[]>;
    openWindow(url: string): Promise<WorkerClient | null>;
  };
  addEventListener<Name extends keyof WorkerEvents>(name: Name, handler: (event: WorkerEvents[Name]) => void): void;
};

export function serviceWorkerMain() {
  const worker = globalThis as unknown as WorkerScope;
  const offlineCache = "ai-trainer-offline-v1";

  worker.addEventListener("install", (event) => {
    event.waitUntil((async () => {
      const cache = await caches.open(offlineCache);
      await cache.add("/offline.html");
      await worker.skipWaiting();
    })());
  });

  worker.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("ai-trainer-offline-") && key !== offlineCache).map((key) => caches.delete(key)));
      await worker.clients.claim();
    })());
  });

  worker.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== "GET" || url.origin !== worker.location.origin) return;
    if (event.request.mode !== "navigate" && !url.pathname.startsWith("/api/")) return;
    event.respondWith((async () => {
      try {
        return await fetch(event.request);
      } catch {
        if (event.request.mode === "navigate") {
          const cached = await caches.match("/offline.html");
          if (cached) return cached;
        }
        return Response.json({ error: "offline" }, { status: 503, headers: { "cache-control": "no-store" } });
      }
    })());
  });

  function notificationUrl(data: unknown) {
    if (!data || typeof data !== "object" || !("url" in data) || typeof data.url !== "string") return "/chat";
    const url = new URL(data.url, worker.location.origin);
    if (url.origin !== worker.location.origin || url.pathname !== "/chat") return "/chat";
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return "/chat";
    return `/chat?sessionId=${sessionId}`;
  }

  worker.addEventListener("push", (event) => {
    event.waitUntil((async () => {
      let payload: unknown;
      try { payload = event.data?.json(); } catch { payload = undefined; }
      let url = "/chat";
      try { url = notificationUrl(payload); } catch { url = "/chat"; }
      const sessionId = new URL(url, worker.location.origin).searchParams.get("sessionId");
      await worker.registration.showNotification("Czas na odprawe", {
        body: "Twoj trening jest gotowy do omowienia z trenerem.",
        icon: "/api/pwa-icon?size=192", badge: "/api/pwa-icon?size=192",
        tag: sessionId ? `debrief-${sessionId}` : "ai-trainer",
        data: { url },
      });
    })());
  });

  worker.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil((async () => {
      let path = "/chat";
      try { path = notificationUrl(event.notification.data); } catch { path = "/chat"; }
      const url = new URL(path, worker.location.origin).href;
      const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== worker.location.origin) continue;
        const navigated = await client.navigate(url);
        if (navigated) { await navigated.focus(); return; }
      }
      await worker.clients.openWindow(url);
    })());
  });
}