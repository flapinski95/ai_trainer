import { auth } from "@/auth";
import { authStore } from "@/lib/auth-store";
import { authSettings } from "@/lib/server-config";
import { recentWorkouts, workoutProvider } from "@/lib/workouts";
import type { Workout } from "@/backend/workouts/store";
import { DashboardPullRefresh } from "./dashboard-pull-refresh";
import { RecoverySummary } from "./recovery-summary";
import { WorkoutList } from "./workout-list";

export const dynamic = "force-dynamic";
const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Warsaw",
  year: "numeric",
});
const metricNumber = new Intl.NumberFormat("pl-PL", {
  maximumFractionDigits: 1,
});
const weekdayFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: "Europe/Warsaw",
  weekday: "short",
});

function dateKey(date: Date) {
  const parts = dateKeyFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";
  return `${year}-${month}-${day}`;
}

function shiftDateKey(key: string, days: number) {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function workoutTime(workout: Workout) {
  return workout.provider === "garmin" ? workout.elapsedTime : workout.movingTime;
}

function isRunningWorkout(workout: Workout) {
  return /run|trail|hike/i.test(workout.sport);
}

function isCyclingWorkout(workout: Workout) {
  return /ride|gravel|cycl|bike/i.test(workout.sport);
}

function formatPace(secondsPerKilometer: number | null) {
  if (secondsPerKilometer === null || !Number.isFinite(secondsPerKilometer)) return null;
  const totalSeconds = Math.round(secondsPerKilometer);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")} min/km`;
}

function summarizeWorkouts(workouts: Workout[]) {
  const runningWorkouts = workouts.filter(isRunningWorkout);
  const cyclingWorkouts = workouts.filter(isCyclingWorkout);
  const average = (activities: Workout[], key: "averageHeartRate" | "averagePower") => {
    const values = activities
      .map((workout) => workout[key])
      .filter((value): value is number => value !== undefined && Number.isFinite(value));
    return values.length
      ? Math.round(values.reduce((total, value) => total + value, 0) / values.length)
      : null;
  };
  const runningDistance = runningWorkouts.reduce((total, workout) => total + workout.distance, 0);
  const runningMovingTime = runningWorkouts.reduce((total, workout) => total + workout.movingTime, 0);

  return {
    count: workouts.length,
    distance: workouts.reduce((total, workout) => total + workout.distance, 0),
    duration: workouts.reduce((total, workout) => total + workoutTime(workout), 0),
    elevation: workouts.reduce((total, workout) => total + (workout.elevationGain ?? 0), 0),
    averageHeartRate: average(workouts, "averageHeartRate"),
    averagePower: average(cyclingWorkouts, "averagePower"),
    averagePace: runningDistance > 0
      ? formatPace(runningMovingTime / (runningDistance / 1000))
      : null,
    hasRunning: runningWorkouts.length > 0,
    hasCycling: cyclingWorkouts.length > 0,
  };
}

type ConnectionSummary = Awaited<
  ReturnType<ReturnType<typeof authStore>["connection"]>
>;
export default async function Home({ searchParams }: {
  searchParams: Promise<{ import?: string }>;
}) {
  const query = await searchParams;
  const settings = authSettings();
  const configured = Boolean(settings);
  const session = configured ? await auth() : null;
  let connection: Awaited<
    ReturnType<ReturnType<typeof authStore>["connection"]>
  > = null;
  let garminConnection: ConnectionSummary = null;
  let connectionError = false;
  if (session?.user.id) {
    try {
      const store = authStore();
      [connection, garminConnection] = await Promise.all([
        store.connection(session.user.id),
        store.connection(session.user.id, "garmin"),
      ]);
    } catch {
      connectionError = true;
    }
  }
  let selectedProvider: "strava" | "garmin" | null = null;
  try {
    selectedProvider = await workoutProvider();
  } catch {
    connectionError = true;
  }
  const connected = selectedProvider !== null;
  const garminConnected = Boolean(garminConnection?.active);
  let workouts: Workout[] = [];
  let workoutsError = false;
  if (connected) {
    try {
      workouts = await recentWorkouts();
    } catch {
      workoutsError = true;
    }
  }
  const todayKey = dateKey(new Date());
  const weekStartKey = shiftDateKey(todayKey, -6);
  const monthStartKey = `${todayKey.slice(0, 7)}-01`;
  const workoutsByDate = workouts.map((workout) => ({
    workout,
    date: dateKey(new Date(workout.startedAt)),
  }));
  const workoutsThisWeek = workoutsByDate
    .filter(({ date }) => date >= weekStartKey && date <= todayKey)
    .map(({ workout }) => workout);
  const weeklySummary = summarizeWorkouts(workoutsThisWeek);
  const dailyLoads = Array.from({ length: 7 }, (_, index) => {
    const date = shiftDateKey(weekStartKey, index);
    const distance = workoutsThisWeek
      .filter((workout) => dateKey(new Date(workout.startedAt)) === date)
      .reduce((total, workout) => total + workout.distance, 0) / 1000;
    return {
      date,
      label: weekdayFormatter.format(new Date(`${date}T12:00:00Z`)).replace(".", ""),
      distance,
    };
  });
  const maxDailyDistance = Math.max(0, ...dailyLoads.map(({ distance }) => distance));
  const periods = [
    {
      label: "Tydzień",
      summary: weeklySummary,
    },
    {
      label: "Miesiąc",
      summary: summarizeWorkouts(
        workoutsByDate
          .filter(({ date }) => date >= monthStartKey && date <= todayKey)
          .map(({ workout }) => workout),
      ),
    },
  ];
  return (
    <DashboardPullRefresh>
      <div className="dashboard-wordmark" aria-label="AI Trainer">
        AI TRAINER<span className="brand-dot">.</span>
      </div>
          {connectionError && (
            <p className="notice" role="alert">
              Nie mozna odczytac statusu polaczen.
            </p>
          )}
          {query.import === "garmin" && (
            <p className="notice notice-success" role="status">
              Historia Garmina została zaimportowana.
              {selectedProvider === "strava" && " Dziennik pokazuje Stravę jako główne źródło; historia Garmina pozostaje zapisana osobno."}
            </p>
          )}
          <RecoverySummary
            enabled={Boolean(session?.user.id)}
          />
          <section className="dashboard-overview" aria-label="Obciążenie treningowe">
            {periods.map(({ label, summary }) => {
              const sportMetrics: Array<{ label: string; value: string | null }> = [];
              if (summary.hasRunning) {
                sportMetrics.push({ label: "Śr. tempo", value: summary.averagePace });
              }
              if (summary.hasCycling) {
                sportMetrics.push({
                  label: "Śr. moc",
                  value: summary.averagePower === null ? null : `${summary.averagePower} W`,
                });
              }
              if (!sportMetrics.length) {
                sportMetrics.push(
                  { label: "Śr. tempo", value: null },
                  { label: "Śr. moc", value: null },
                );
              }

              return (
                <article className="dashboard-period" key={label}>
                  <h2>{label}</h2>
                  <dl className="dashboard-stat-grid">
                    <div>
                      <dt>Dystans</dt>
                      <dd>{metricNumber.format(summary.distance / 1000)} km</dd>
                    </div>
                    <div>
                      <dt>Czas</dt>
                      <dd>{`${Math.floor(summary.duration / 3600)}:${String(Math.floor(summary.duration / 60) % 60).padStart(2, "0")}`}</dd>
                    </div>
                    <div>
                      <dt>Wznios</dt>
                      <dd>{Math.round(summary.elevation)} m</dd>
                    </div>
                    <div>
                      <dt>Treningi</dt>
                      <dd>{summary.count}</dd>
                    </div>
                    <div>
                      <dt>Śr. tętno</dt>
                      <dd>{summary.averageHeartRate === null
                        ? <span className="dashboard-stat-empty">Brak danych</span>
                        : `${summary.averageHeartRate} bpm`}</dd>
                    </div>
                    {sportMetrics.map((metric) => (
                      <div key={metric.label}>
                        <dt>{metric.label}</dt>
                        <dd>{metric.value ?? <span className="dashboard-stat-empty">Brak danych</span>}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              );
            })}
          </section>
          <section className="weekly-load-chart" aria-labelledby="weekly-load-heading">
            <div className="weekly-load-heading">
              <div>
                <p>OSTATNIE 7 DNI</p>
                <h2 id="weekly-load-heading">Obciążenie tygodniowe</h2>
              </div>
              <strong>{metricNumber.format(weeklySummary.distance / 1000)} <span>km</span></strong>
            </div>
            <div
              className="weekly-load-bars"
              role="img"
              aria-label={`Dzienny kilometraż z ostatnich 7 dni, łącznie ${metricNumber.format(weeklySummary.distance / 1000)} kilometrów`}
            >
              {dailyLoads.map(({ date, label, distance }) => (
                <div className="weekly-load-day" key={date} title={`${label}: ${metricNumber.format(distance)} km`}>
                  <span className="weekly-load-day-value">{distance ? metricNumber.format(distance) : ""}</span>
                  <span className="weekly-load-track">
                    <span
                      className="weekly-load-bar"
                      style={{ height: `${maxDailyDistance ? Math.max(8, distance / maxDailyDistance * 100) : 0}%` }}
                    />
                  </span>
                  <span className="weekly-load-day-label">{label}</span>
                </div>
              ))}
            </div>
          </section>
          <WorkoutList
            connected={connected}
            error={workoutsError}
            workouts={workouts}
          />
    </DashboardPullRefresh>
  );
}
