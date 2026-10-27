import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import { authSettings } from "@/lib/server-config";
import { ScreenHeader } from "../screen-header";
import { ActivitiesView } from "./activities-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "AI Trainer | Aktywnosci" };

export default async function ActivitiesPage() {
  const session = authSettings() ? await auth() : null;

  return (
    <>
      <ScreenHeader title="Aktywnosci" accountName={session?.user.name} />
      <div className="screen-content min-w-0 overflow-y-auto bg-[var(--background)] px-5 py-5 sm:px-8 sm:py-8 lg:px-10">
        {session?.user.id ? <ActivitiesView key={session.user.id} /> : (
          <section className="mx-auto max-w-4xl py-10 text-[var(--ink)]">
            <h1 className="font-['Newsreader',Georgia,serif] text-3xl">Twoje aktywnosci</h1>
            <p className="mt-3 text-[var(--muted)]">Zaloguj sie, aby zobaczyc historie treningow.</p>
            <Link href="/settings" className="mt-6 inline-flex min-h-11 items-center rounded-md bg-[var(--accent)] px-4 font-medium text-[var(--accent-contrast)]!">Przejdz do profilu</Link>
          </section>
        )}
      </div>
    </>
  );
}