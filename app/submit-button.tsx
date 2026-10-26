"use client";

import { ArrowUpRight, LoaderCircle, LogOut } from "lucide-react";
import { useFormStatus } from "react-dom";

export function SubmitButton({
  label,
  disabled = false,
  logout = false,
  provider = "strava",
}: {
  label: string;
  disabled?: boolean;
  logout?: boolean;
  provider?: "strava" | "garmin";
}) {
  const { pending } = useFormStatus();
  const Icon = pending ? LoaderCircle : logout ? LogOut : ArrowUpRight;
  return (
    <button
      type="submit"
      className={
        logout
          ? "logout-button"
          : provider === "garmin"
            ? "garmin-button"
            : "strava-button"
      }
      disabled={disabled || pending}
      aria-busy={pending}
    >
      <Icon size={18} className={pending ? "pending-icon" : undefined} />
      {pending ? (logout ? "Wylogowywanie..." : "Laczenie...") : label}
    </button>
  );
}
