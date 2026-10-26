import { serviceWorkerMain } from "../sw";

export const dynamic = "force-dynamic";

export function GET() {
  return new Response(`(${serviceWorkerMain.toString()})();`, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "service-worker-allowed": "/",
      "x-content-type-options": "nosniff",
    },
  });
}