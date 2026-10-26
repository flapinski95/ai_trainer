import {
  Activity,
  ArrowUpRight,
  Bike,
  Footprints,
  ShieldCheck,
} from "lucide-react";
import { auth } from "@/auth";
import { authStore } from "@/lib/auth-store";
import { authSettings } from "@/lib/server-config";
import { recentWorkouts, workoutProvider } from "@/lib/workouts";
import type { Workout } from "@/backend/workouts/store";
import { RefreshWorkouts } from "./refresh-workouts";
import { historyStore } from "@/lib/history-store";
import { ScreenHeader } from "./screen-header";
import { RecoverySummary } from "./recovery-summary";

export const dynamic = "force-dynamic";
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
  let trainingContext: {
    count: number;
    distance: number;
    movingTime: number;
  } | null = null;
  if (connected && session?.user.id) {
    try {
      const store = historyStore();
      trainingContext = await store.context(
        session.user.id,
        selectedProvider ?? "strava",
      );
    } catch {
      trainingContext = null;
    }
  }
  let workouts: Workout[] = [];
  let workoutsError = false;
  if (connected) {
    try {
      workouts = await recentWorkouts();
    } catch {
      workoutsError = true;
    }
  }
  const workoutDate = new Intl.DateTimeFormat("pl-PL", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Warsaw",
  });
  const distance = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 });
  const duration = (seconds: number) =>
    `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const date = new Intl.DateTimeFormat("pl-PL", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Warsaw",
  }).format(new Date());

  return (
    <>
      <ScreenHeader
        title="DZIENNIK TRENINGOWY"
        accountName={session?.user.name}
      />
      <div className="screen-content">
        <div className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">{date}</p>
              <h1>Twoje treningi</h1>
            </div>
            <div className="sport-labels">
              <span>
                <Bike size={17} /> Kolarstwo
              </span>
              <span>
                <Footprints size={17} /> Bieganie
              </span>
            </div>
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

          <div className="dashboard-grid journal-grid">
            <section id="activities" className="activity-section">
              <figure className="ride-image">
                <img src="/cycling.jpg" alt="Rower szosowy" />
                <figcaption>
                  <Bike size={17} /> KOLARSTWO SZOSOWE
                </figcaption>
              </figure>
              <div className="section-title">
                <h2>Ostatnie aktywnosci</h2>
                <div className="workout-tools">
                  <span className="muted-label">Ostatnie 50</span>
                  {connected && <RefreshWorkouts />}
                </div>
              </div>
              {trainingContext && trainingContext.count > 0 && (
                <div
                  className="training-context"
                  aria-label="Historia treningowa"
                >
                  <span>
                    <strong>{trainingContext.count}</strong> treningow
                  </span>
                  <span>
                    <strong>
                      {distance.format(trainingContext.distance / 1000)}
                    </strong>{" "}
                    km
                  </span>
                  <span>
                    <strong>
                      {Math.round(trainingContext.movingTime / 3600)}
                    </strong>{" "}
                    godzin
                  </span>
                </div>
              )}
              {workoutsError ? (
                <p className="notice" role="alert">
                  Nie mozna odczytac treningow. Sprobuj odswiezyc dziennik.
                </p>
              ) : workouts.length ? (
                <ul className="workout-list" aria-label="Ostatnie treningi">
                  {workouts.map((workout) => {
                    const SportIcon = workout.sport.includes("Ride")
                      ? Bike
                      : workout.sport.includes("Run")
                        ? Footprints
                        : Activity;
                    return (
                      <li
                        className="workout-row"
                        key={`${workout.provider}-${workout.id}`}
                      >
                        <span className="workout-sport" title={workout.sport}>
                          <SportIcon size={20} aria-label={workout.sport} />
                        </span>
                        <div className="workout-main">
                          <a
                            className="workout-title"
                            href={
                              workout.provider === "strava"
                                ? `https://www.strava.com/activities/${workout.id}`
                                : /^\d+$/.test(workout.id)
                                  ? `https://connect.garmin.com/modern/activity/${workout.id}`
                                  : "#activities"
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            {workout.name}
                            <ArrowUpRight size={13} />
                          </a>
                          <time dateTime={workout.startedAt}>
                            {workoutDate.format(new Date(workout.startedAt))}
                          </time>
                        </div>
                        <dl className="workout-metrics">
                          <div>
                            <dt>Dystans</dt>
                            <dd>
                              {distance.format(workout.distance / 1000)}{" "}
                              <span>km</span>
                            </dd>
                          </div>
                          <div>
                            <dt>
                              {workout.provider === "garmin"
                                ? "Czas treningu"
                                : "Czas ruchu"}
                            </dt>
                            <dd>
                              {duration(
                                workout.provider === "garmin"
                                  ? workout.elapsedTime
                                  : workout.movingTime,
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>Przewyzszenie</dt>
                            <dd>
                              {workout.elevationGain === undefined
                                ? "-"
                                : `${Math.round(workout.elevationGain)} m`}
                            </dd>
                          </div>
                        </dl>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="empty-state">
                  <div className="empty-icon">
                    <Activity size={25} />
                  </div>
                  <h3>Brak zsynchronizowanych treningow</h3>
                  <p>
                    {connected
                      ? "Twoj dziennik jest jeszcze pusty."
                      : "Konto sportowe nie jest polaczone."}
                  </p>
                </div>
              )}
              <div className="activity-footer">
                <ShieldCheck size={15} />
                <span>Twoje dane pozostaja prywatne.</span>
              </div>
            </section>

          </div>
          <footer className="page-footer">
            <span>AI TRAINER</span>
            <span>Kolarstwo. Bieganie. Twoje tempo.</span>
          </footer>
        </div>
      </div>
    </>
  );
}
