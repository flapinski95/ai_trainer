"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import useSWR, { SWRConfig } from "swr";
import { Activity, ArrowLeft, ArrowUpRight, Bike, ChevronLeft, ChevronRight, Footprints, Mountain, RefreshCw, Sparkles, Watch } from "lucide-react";
import { activityDiscipline, type ActivitiesPage, type ActivityType } from "@/backend/workouts/activities";
import type { Workout } from "@/backend/workouts/store";

const dateFormatter = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Warsaw",
});
const numberFormatter = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 });
const filters: { value: ActivityType; label: string }[] = [
  { value: "all", label: "Wszystkie" },
  { value: "cycling", label: "Kolarstwo" },
  { value: "running", label: "Bieg" },
];

class ActivitiesError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? "Sesja wygasla. Zaloguj sie ponownie w profilu."
      : status === 400 ? "Ta strona jest juz nieaktualna. Wroc do poczatku listy."
        : "Nie mozna pobrac treningow. Sprobuj ponownie.");
  }
}

async function fetchActivities(url: string): Promise<ActivitiesPage> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new ActivitiesError(response.status);
  return response.json() as Promise<ActivitiesPage>;
}

function duration(seconds: number): string {
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}`;
}

function pace(workout: Workout): string {
  if (workout.distance <= 0 || workout.movingTime <= 0) return "-";
  const seconds = Math.round(workout.movingTime / (workout.distance / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function ActivityCard({ workout }: { workout: Workout }) {
  const discipline = activityDiscipline(workout.sport);
  const SportIcon = discipline === "cycling" ? Bike : discipline === "running" ? Footprints : Activity;
  const sport = discipline === "cycling" ? "Kolarstwo" : discipline === "running" ? "Bieg" : workout.sport;
  const externalUrl = workout.provider === "strava"
    ? `https://www.strava.com/activities/${workout.id}`
    : /^\d+$/.test(workout.id) ? `https://connect.garmin.com/modern/activity/${workout.id}` : null;
  const metrics = [
    { label: "Dystans", value: numberFormatter.format(workout.distance / 1000), unit: "km" },
    { label: "Czas", value: duration(workout.provider === "garmin" ? workout.elapsedTime : workout.movingTime), unit: "h:mm" },
    { label: "Srednie tetno", value: workout.averageHeartRate === undefined ? "-" : String(Math.round(workout.averageHeartRate)), unit: "bpm" },
    discipline === "running"
      ? { label: "Tempo", value: pace(workout), unit: "min/km" }
      : { label: "Srednia moc", value: workout.averagePower === undefined ? "-" : String(Math.round(workout.averagePower)), unit: "W" },
    { label: "Przewyzszenie", value: workout.elevationGain === undefined ? "-" : String(Math.round(workout.elevationGain)), unit: "m" },
  ];

  return (
    <article className="min-w-0 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-semibold text-[var(--accent)] bg-[var(--accent-soft)]">
          {workout.provider === "strava" ? <Mountain size={13} aria-hidden="true" /> : <Watch size={13} aria-hidden="true" />}
          {workout.provider === "strava" ? "Strava" : "Garmin"}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--muted)] [overflow-wrap:anywhere]">
          <SportIcon size={15} className="shrink-0" aria-hidden="true" />{sport}
        </span>
      </div>
      <h2 className="mt-4 text-lg leading-snug font-semibold text-[var(--ink)] [overflow-wrap:anywhere]">
        {externalUrl ? <a href={externalUrl} target="_blank" rel="noreferrer" className="group inline-flex max-w-full items-start gap-2 hover:text-[var(--accent)]!">
          <span className="min-w-0">{workout.name}</span>
          <ArrowUpRight size={17} className="mt-1 shrink-0 text-[var(--muted)] group-hover:text-[var(--accent)]" aria-hidden="true" />
          <span className="sr-only">Otworz w {workout.provider === "strava" ? "Strava" : "Garmin Connect"} (nowa karta)</span>
        </a> : workout.name}
      </h2>
      <time dateTime={workout.startedAt} className="mt-1 block text-xs leading-5 text-[var(--muted)]">{dateFormatter.format(new Date(workout.startedAt))}</time>
      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-[var(--line)] pt-4 sm:grid-cols-5 sm:gap-x-5">
        {metrics.map((metric) => <div key={metric.label} className="min-w-0">
          <dt className="text-[11px] leading-5 text-[var(--muted)]">{metric.label}</dt>
          <dd className="mt-1 flex min-h-7 flex-wrap items-baseline gap-x-1.5 text-lg font-semibold tabular-nums text-[var(--ink)] [overflow-wrap:anywhere]">
            <span aria-label={metric.value === "-" ? "Brak danych" : undefined}>{metric.value}</span>
            <span className="text-[11px] font-normal text-[var(--muted)]">{metric.unit}</span>
          </dd>
        </div>)}
      </dl>
      <Link href={`/chat?activityId=${encodeURIComponent(workout.id)}`}
        className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-md border border-[#7A1A28] px-4 text-sm font-medium text-[#7A1A28]! hover:bg-[var(--accent-soft)]">
        <Sparkles size={16} aria-hidden="true" />Analizuj z AI
        <span className="sr-only">: {workout.name}</span>
      </Link>
    </article>
  );
}

export function ActivitiesSkeleton() {
  return <div role="status" aria-label="Ladowanie aktywnosci" className="grid gap-4">
    {[0, 1, 2, 3].map((item) => <div key={item} aria-hidden="true" className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4 motion-safe:animate-pulse sm:p-6">
      <div className="h-5 w-20 rounded bg-[var(--accent-soft)]" />
      <div className="mt-4 h-6 w-3/4 rounded bg-[var(--surface-hover)]" />
      <div className="mt-2 h-4 w-40 rounded bg-[var(--surface-hover)]" />
      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-[var(--line)] pt-4 sm:grid-cols-5">
        {[0, 1, 2, 3, 4].map((metric) => <div key={metric}><div className="h-5 w-16 rounded bg-[var(--surface-hover)]" /><div className="mt-1 h-7 w-20 rounded bg-[var(--surface-hover)]" /></div>)}
      </div>
    </div>)}
  </div>;
}

function ActivitiesList() {
  const [type, setType] = useState<ActivityType>("all");
  const [limit, setLimit] = useState(20);
  const [cursors, setCursors] = useState<string[]>([""]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const page = cursors.length;
  const cursor = cursors[page - 1] ?? "";
  const params = new URLSearchParams({ page: String(page), limit: String(limit), type });
  if (cursor) params.set("cursor", cursor);
  const { data, error, isLoading, isValidating, mutate } = useSWR<ActivitiesPage, ActivitiesError>(
    `/api/activities?${params}`, fetchActivities,
    { revalidateOnFocus: false, dedupingInterval: 30000, shouldRetryOnError: false },
  );

  function movePage(nextCursor?: string) {
    setCursors((previous) => nextCursor ? [...previous, nextCursor] : previous.slice(0, -1));
    headingRef.current?.scrollIntoView({ block: "start" });
    headingRef.current?.focus({ preventScroll: true });
  }

  return <section className="mx-auto w-full max-w-4xl pb-8 text-[var(--ink)]">
    <Link href="/" className="inline-flex min-h-11 items-center gap-2 text-xs font-medium text-[var(--muted)]! hover:text-[var(--accent)]!"><ArrowLeft size={15} aria-hidden="true" />Dziennik</Link>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-4 border-b border-[var(--line)] pb-6">
      <h1 ref={headingRef} tabIndex={-1} className="font-['Newsreader',Georgia,serif] text-3xl leading-tight outline-none sm:text-4xl">Aktywnosci</h1>
      <button type="button" title="Odswiez aktywnosci" aria-label="Odswiez aktywnosci" disabled={isValidating} onClick={() => void mutate()}
        className="flex size-11 shrink-0 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--accent)]">
        <RefreshCw size={17} className={isValidating ? "motion-safe:animate-spin" : undefined} aria-hidden="true" />
      </button>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-4 py-5">
      <div role="group" aria-label="Dyscyplina" className="inline-grid max-w-full grid-cols-3 gap-1 rounded-md bg-[var(--surface-hover)] p-1">
        {filters.map((filter) => <button key={filter.value} type="button" aria-pressed={type === filter.value}
          onClick={() => { setType(filter.value); setCursors([""]); }}
          className={`min-h-10 rounded px-2 text-xs font-medium sm:px-4 ${type === filter.value ? "bg-[var(--accent)] text-[var(--accent-contrast)]" : "text-[var(--muted)] hover:text-[var(--accent)]"}`}>{filter.label}</button>)}
      </div>
      <label className="flex min-h-11 items-center gap-2 text-xs text-[var(--muted)]">Na stronie
        <select value={limit} onChange={(event) => { setLimit(Number(event.target.value)); setCursors([""]); }}
          className="min-h-11 rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
          {[10, 20, 50].map((size) => <option value={size} key={size}>{size}</option>)}
        </select>
      </label>
    </div>
    <div aria-busy={isLoading}>
      {isLoading ? <ActivitiesSkeleton /> : error ? <div role="alert" className="border-y border-[var(--line)] py-10">
        <p className="text-sm text-[var(--muted)]">{error.message}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          {error.status === 401 ? <Link href="/settings" className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--accent)]!">Przejdz do profilu<ChevronRight size={16} aria-hidden="true" /></Link>
            : <button type="button" onClick={() => { if (error.status === 400) setCursors([""]); else void mutate(); }} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-[var(--accent)]"><RefreshCw size={16} aria-hidden="true" />{error.status === 400 ? "Pierwsza strona" : "Sprobuj ponownie"}</button>}
        </div>
      </div> : data?.activities.length ? <ul aria-label="Lista aktywnosci" className="grid list-none gap-4 p-0">
        {data.activities.map((workout) => <li key={`${workout.provider}-${workout.id}`} className="min-w-0"><ActivityCard workout={workout} /></li>)}
      </ul> : <div className="border-y border-[var(--line)] py-12">
        <Activity size={26} className="mb-4 text-[var(--accent)]" aria-hidden="true" />
        <h2 className="text-lg font-medium">{type === "all" ? "Brak treningow" : "Brak treningow w tej dyscyplinie"}</h2>
        <Link href="/settings" className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-[var(--accent)]!">Polaczenia i import<ChevronRight size={16} aria-hidden="true" /></Link>
      </div>}
    </div>
    <nav aria-label="Strony aktywnosci" className="mt-6 grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-t border-[var(--line)] pt-5">
      <button type="button" disabled={page === 1 || isLoading} onClick={() => movePage()} className="inline-flex min-h-11 min-w-0 items-center justify-self-start gap-1 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 text-xs font-medium hover:text-[var(--accent)] sm:gap-2 sm:px-4"><ChevronLeft size={16} className="shrink-0" aria-hidden="true" />Poprzednia</button>
      <span role="status" aria-live="polite" aria-atomic="true" className="text-center text-xs tabular-nums text-[var(--muted)]">Strona {page}</span>
      <button type="button" disabled={isLoading || Boolean(error) || !data?.nextCursor} onClick={() => { if (data?.nextCursor) movePage(data.nextCursor); }} className="inline-flex min-h-11 min-w-0 items-center justify-self-end gap-1 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 text-xs font-medium hover:text-[var(--accent)] sm:gap-2 sm:px-4">Nastepna<ChevronRight size={16} className="shrink-0" aria-hidden="true" /></button>
    </nav>
  </section>;
}

export function ActivitiesView() {
  return <SWRConfig value={{ provider: () => new Map() }}><ActivitiesList /></SWRConfig>;
}