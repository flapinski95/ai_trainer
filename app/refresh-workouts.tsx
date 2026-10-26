"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

export function RefreshWorkouts() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="refresh-workouts"
      title="Odswiez treningi"
      aria-label="Odswiez treningi"
      aria-busy={pending}
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RefreshCw size={16} className={pending ? "pending-icon" : undefined} />
    </button>
  );
}
