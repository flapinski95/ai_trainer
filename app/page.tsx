import {
  Activity,
  ArrowUpRight,
  Bike,
  CalendarDays,
  Check,
  CircleUserRound,
  Footprints,
  KeyRound,
  Link2,
  ShieldCheck,
} from "lucide-react";
import { auth } from "@/auth";
import { authStore } from "@/lib/auth-store";
import { authSettings } from "@/lib/server-config";
import { connectStrava, connectGarmin, logout } from "./actions";
import { SubmitButton } from "./submit-button";
import { recentWorkouts } from "@/lib/workouts";
import type { Workout } from "@/backend/workouts/store";
import { RefreshWorkouts } from "./refresh-workouts";
import { HistorySync, type HistoryStatus } from "./history-sync";
import { historyStore } from "@/lib/history-store";
import { activityProvider } from "@/backend/providers/policy";
import { aiCredentialStore } from "@/lib/ai-credential-store";
import { AIKeySettings } from "./ai-key-settings";

export const dynamic = "force-dynamic";
type ConnectionSummary = Awaited<
  ReturnType<ReturnType<typeof authStore>["connection"]>
>;
type AIKeyStatus = Awaited<
  ReturnType<ReturnType<typeof aiCredentialStore>["status"]>
>;

const errors = new Map([
  [
    "permissions",
    "Nie przyznano dostepu do aktywnosci. Polacz konto ponownie.",
  ],
  ["configuration", "Logowanie jest chwilowo niedostepne."],
  ["ai-key", "Nie udalo sie zaktualizowac klucza AI. Sprobuj ponownie."],
]);

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; key?: string }>;
}) {
  const settings = authSettings();
  const configured = Boolean(settings);
  const session = configured ? await auth() : null;
  const query = await searchParams;
  const error = typeof query.error === "string" ? query.error : undefined;
  const keyNotice = typeof query.key === "string" ? query.key : undefined;
  let connection: Awaited<
    ReturnType<ReturnType<typeof authStore>["connection"]>
  > = null;
  let garminConnection: ConnectionSummary = null;
  let connectionError = false;
  let aiKeys: AIKeyStatus = [];
  let aiKeysError = false;
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
    try {
      aiKeys = await aiCredentialStore().status(session.user.id);
    } catch {
      aiKeysError = true;
    }
  }
  const selectedProvider = activityProvider({
    strava: connection,
    garmin: garminConnection,
  });
  const connected = selectedProvider !== null;
  const stravaConnected = Boolean(connection?.active);
  const garminConnected = Boolean(garminConnection?.active);
  let history: HistoryStatus = null;
  let historyError = false;
  let trainingContext: {
    count: number;
    distance: number;
    movingTime: number;
  } | null = null;
  if (connected && session?.user.id) {
    try {
      const store = historyStore();
      [history, trainingContext] = await Promise.all([
        stravaConnected ? store.status(session.user.id) : Promise.resolve(null),
        store.context(session.user.id, selectedProvider ?? "strava"),
      ]);
    } catch {
      historyError = true;
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
    <div className="workspace">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="AI Trainer">
          <Activity size={25} strokeWidth={2.5} />
          <span>
            AI TRAINER<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace-label">TWOJA PRZESTRZEN</div>
        <nav aria-label="Nawigacja">
          <a className="nav-link active" href="#activities">
            <CalendarDays size={18} /> Dziennik
          </a>
          <a className="nav-link" href="#connection">
            <Link2 size={18} /> Polaczenia
          </a>
          {session && (
            <a className="nav-link" href="#ai-keys">
              <KeyRound size={18} /> Klucze AI
            </a>
          )}
        </nav>
        <div className="sidebar-bottom">
          <ShieldCheck size={17} />
          <span>Prywatne konto</span>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <span>DZIENNIK TRENINGOWY</span>
          <div className="account-indicator">
            <CircleUserRound size={19} />
            <span className="account-name">
              {session?.user.name ?? "Nie zalogowano"}
            </span>
          </div>
        </header>
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
          {error && (
            <p className="notice" role="alert">
              {errors.get(error) ??
                "Nie udalo sie zalogowac. Sprobuj ponownie."}
            </p>
          )}
          {keyNotice && !error && (
            <p className="notice notice-success" role="status">
              {keyNotice === "saved"
                ? "Klucz AI zostal zapisany."
                : keyNotice === "removed"
                  ? "Klucz AI zostal usuniety."
                  : ""}
            </p>
          )}

          <div className="dashboard-grid">
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

            <section id="connection" className="connection-section">
              <div className="section-title">
                <h2>Konto sportowe</h2>
                <Link2 size={18} />
              </div>
              {session && (
                <dl className="connection-details">
                  <div>
                    <dt>Treningi</dt>
                    <dd>
                      {selectedProvider === "strava"
                        ? "Strava"
                        : selectedProvider === "garmin"
                          ? "Garmin"
                          : "Brak zrodla"}
                    </dd>
                  </div>
                  <div>
                    <dt>Zdrowie</dt>
                    <dd>
                      {garminConnected &&
                      garminConnection?.scopes.some(
                        (permission) =>
                          permission === "HEALTH_EXPORT" ||
                          permission === "MCT_EXPORT",
                      )
                        ? "Garmin"
                        : "Nie polaczono"}
                    </dd>
                  </div>
                </dl>
              )}
              <div className="provider-heading">
                <Activity size={32} className="garmin-logo" />
                <div>
                  <h3>Garmin</h3>
                  <span
                    className={garminConnected ? "status connected" : "status"}
                  >
                    <span className="status-dot" />
                    {garminConnected ? "Polaczono" : "Nie polaczono"}
                  </span>
                </div>
                {garminConnected && (
                  <Check className="provider-check" size={20} />
                )}
              </div>
              {garminConnection && (
                <dl className="connection-details">
                  <div>
                    <dt>ID Garmin</dt>
                    <dd>{garminConnection.athleteId}</dd>
                  </div>
                  <div>
                    <dt>Aktywnosci</dt>
                    <dd>
                      {garminConnection.scopes.includes("ACTIVITY_EXPORT")
                        ? "Wlaczone"
                        : "Brak zgody"}
                    </dd>
                  </div>
                  <div>
                    <dt>Zdrowie</dt>
                    <dd>
                      {garminConnection.scopes.includes("HEALTH_EXPORT")
                        ? "Wlaczone"
                        : "Brak zgody"}
                    </dd>
                  </div>
                  <div>
                    <dt>Zdrowie kobiet</dt>
                    <dd>
                      {garminConnection.scopes.includes("MCT_EXPORT")
                        ? "Wlaczone"
                        : "Brak zgody"}
                    </dd>
                  </div>
                </dl>
              )}
              <form action={connectGarmin}>
                <SubmitButton
                  provider="garmin"
                  disabled={!settings?.garmin}
                  label={
                    garminConnected
                      ? "Ponow autoryzacje Garmin"
                      : session
                        ? "Polacz Garmin"
                        : "Zaloguj przez Garmin"
                  }
                />
              </form>
              {!settings?.garmin && (
                <p className="unavailable">Polaczenie Garmin niedostepne.</p>
              )}
              <div className="connection-divider" />
              <div className="provider-heading">
                <img src="/strava.svg" width="34" height="34" alt="" />
                <div>
                  <h3>Strava</h3>
                  <span
                    className={stravaConnected ? "status connected" : "status"}
                  >
                    <span className="status-dot" />
                    {stravaConnected ? "Polaczono" : "Nie polaczono"}
                  </span>
                </div>
                {stravaConnected && (
                  <Check className="provider-check" size={20} />
                )}
              </div>
              {connectionError && (
                <p className="notice" role="alert">
                  Nie mozna odczytac statusu konta.
                </p>
              )}
              {connection && (
                <dl className="connection-details">
                  <div>
                    <dt>Zawodnik</dt>
                    <dd>{connection.name}</dd>
                  </div>
                  <div>
                    <dt>ID Strava</dt>
                    <dd>{connection.athleteId}</dd>
                  </div>
                  <div>
                    <dt>Aktywnosci</dt>
                    <dd>
                      {connection.scopes.some(
                        (scope) => scope === "activity:read_all",
                      )
                        ? "Wszystkie"
                        : "Publiczne i dla obserwujacych"}
                    </dd>
                  </div>
                </dl>
              )}
              <form action={connectStrava}>
                <SubmitButton
                  disabled={!settings?.strava}
                  label={
                    stravaConnected
                      ? "Ponow autoryzacje"
                      : session
                        ? "Polacz Strave"
                        : "Zaloguj przez Strave"
                  }
                />
              </form>
              {!configured && (
                <p className="unavailable" role="status">
                  Logowanie chwilowo niedostepne.
                </p>
              )}
              {session && (
                <form action={logout}>
                  <SubmitButton logout label="Wyloguj" />
                </form>
              )}
              {stravaConnected && (
                <HistorySync status={history} unavailable={historyError} />
              )}
              <div className="connection-divider" />
              <div className="privacy-note">
                <ShieldCheck size={20} />
                <div>
                  <h3>Kontrola nad kontem</h3>
                  <a
                    href="https://www.strava.com/settings/apps"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Uprawnienia w Stravie <ArrowUpRight size={13} />
                  </a>
                </div>
              </div>
            </section>
          </div>
          {session && (
            <div className="settings-grid">
              {aiKeysError ? (
                <section id="ai-keys" className="ai-key-section">
                  <p className="notice" role="alert">
                    Nie mozna odczytac statusu kluczy AI.
                  </p>
                </section>
              ) : (
                <AIKeySettings keys={aiKeys} />
              )}
            </div>
          )}
          <footer className="page-footer">
            <span>AI TRAINER</span>
            <span>Kolarstwo. Bieganie. Twoje tempo.</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
