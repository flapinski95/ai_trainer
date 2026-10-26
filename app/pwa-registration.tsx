"use client";

import { useEffect } from "react";

export function PWARegistration() {
  useEffect(() => {
    if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((error: unknown) => {
      console.error("service_worker_registration_failed", { type: error instanceof Error ? error.name : "UnknownError" });
    });
  }, []);
  return null;
}