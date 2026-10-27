import {
  Activity,
  ArrowUpRight,
  Link2,
  SlidersHorizontal,
  ShieldCheck,
} from "lucide-react";
import { auth } from "@/auth";
import { authStore } from "@/lib/auth-store";
import { aiCredentialStore } from "@/lib/ai-credential-store";
import { authSettings } from "@/lib/server-config";
import { activityProvider } from "@/backend/providers/policy";
import type { AIProvider } from "@/backend/ai/credentials";
import { historyStore } from "@/lib/history-store";
import { connectGarmin, connectStrava, logout } from "../actions";
import { AIKeySettings } from "../ai-key-settings";
import { HistorySync, type HistoryStatus } from "../history-sync";
import { ModelPreferences } from "../model-preferences";
import { SubmitButton } from "../submit-button";
import { GarminImport } from "../garmin-import";
import { PushSettings } from "../push-settings";
import { readAthleteMemory } from "../api/chat/memory";
import { AIPrivacySettings } from "./ai-privacy-settings";
import { SettingsAccordion } from "./settings-accordion";
import styles from "./settings.module.css";

export const dynamic = "force-dynamic";

type ConnectionSummary = Awaited<
  ReturnType<ReturnType<typeof authStore>["connection"]>
>;
type AIKeyStatus = Awaited<
  ReturnType<ReturnType<typeof aiCredentialStore>["status"]>
>;

const errors = new Map([
  ["permissions", "Nie przyznano dostepu do aktywnosci. Polacz konto ponownie."],
  ["configuration", "Logowanie jest chwilowo niedostepne."],
  ["ai-key", "Nie udalo sie zaktualizowac klucza AI. Sprobuj ponownie."],
  ["authentication", "Nie udalo sie zalogowac. Sprobuj ponownie."],
]);

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; key?: string }>;
}) {
  const settings = authSettings();
  const session = settings ? await auth() : null;
  const query = await searchParams;
  const error = typeof query.error === "string" ? query.error : undefined;
  const keyNotice = typeof query.key === "string" ? query.key : undefined;
  let connection: ConnectionSummary = null;
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
  const stravaConnected = Boolean(connection?.active);
  const garminConnected = Boolean(garminConnection?.active);
  let history: HistoryStatus = null;
  let historyError = false;

  if (stravaConnected && session?.user.id) {
    try {
      history = await historyStore().status(session.user.id);
    } catch {
      historyError = true;
    }
  }

  const providers = aiKeys
    .filter((key) => key.configured)
    .map((key) => key.provider) as AIProvider[];
  const configuredKeyCount = providers.length;
  let profile: Awaited<ReturnType<typeof readAthleteMemory>> = {};
  let profileError = false;
  if (session?.user.id) {
    try { profile = await readAthleteMemory(session.user.id); }
    catch { profileError = true; }
  }

  return (
    <div className={`screen-content ${styles.settingsScreen}`}>
      <div className={`content ${styles.content}`}>
        <header className={styles.titleBar}>
          <h1>Ustawienia</h1>
        </header>

        {error && <p className="notice" role="alert">{errors.get(error) ?? errors.get("authentication")}</p>}
        {keyNotice && !error && (
          <p className="notice notice-success" role="status">
            {keyNotice === "saved" ? "Klucz AI zostal zapisany." : "Klucz AI zostal usuniety."}
          </p>
        )}

        <div className={styles.groups}>
          <SettingsAccordion
            id="integrations"
            title="Integracje i historia"
            status={`Garmin ${garminConnected ? "połączono" : "niepołączono"} · Strava ${stravaConnected ? "połączono" : "niepołączono"}`}
            icon="link"
            defaultOpen
          >
            <section className="settings-panel connection-panel">
              {connectionError && (
                <p className="notice" role="alert">Nie mozna odczytac statusu konta.</p>
              )}

              <article className={`provider-settings-card ${styles.providerCard}`}>
                <div className={styles.integrationRow}>
                  <div className={styles.integrationIdentity}>
                    <Activity size={26} className={styles.garminIcon} />
                    <div>
                      <h3>Garmin</h3>
                      <span className={garminConnected ? "status connected" : "status"}>
                        <span className="status-dot" />
                        {garminConnected ? "Polaczono" : "Nie polaczono"}
                      </span>
                    </div>
                  </div>
                  <form action={connectGarmin} className={styles.inlineAction}>
                    <SubmitButton
                      provider="garmin"
                      disabled={!settings?.garmin}
                      label={garminConnected ? "Ponow autoryzacje Garmin" : session ? "Polacz Garmin" : "Zaloguj przez Garmin"}
                    />
                  </form>
                </div>
                {garminConnection && (
                  <dl className="connection-details">
                    <div><dt>Treningi</dt><dd>{selectedProvider === "garmin" ? "Aktywne" : "Zrodlo zapasowe"}</dd></div>
                    <div><dt>Aktywnosci</dt><dd>{garminConnection.scopes.includes("ACTIVITY_EXPORT") ? "Wlaczone" : "Brak zgody"}</dd></div>
                    <div><dt>Zdrowie</dt><dd>{garminConnection.scopes.includes("HEALTH_EXPORT") ? "Wlaczone" : "Brak zgody"}</dd></div>
                  </dl>
                )}
                {!settings?.garmin && <p className="unavailable">Polaczenie Garmin niedostepne.</p>}
              </article>

              <article className={`provider-settings-card ${styles.providerCard}`}>
                <div className={styles.integrationRow}>
                  <div className={styles.integrationIdentity}>
                    <img src="/strava.svg" width="28" height="28" alt="" />
                    <div>
                      <h3>Strava</h3>
                      <span className={stravaConnected ? "status connected" : "status"}>
                        <span className="status-dot" />
                        {stravaConnected ? "Polaczono" : "Nie polaczono"}
                      </span>
                    </div>
                  </div>
                  <form action={connectStrava} className={styles.inlineAction}>
                    <SubmitButton
                      disabled={!settings?.strava}
                      label={stravaConnected ? "Ponow autoryzacje" : session ? "Polacz Strave" : "Zaloguj przez Strave"}
                    />
                  </form>
                </div>
                {connection && (
                  <dl className="connection-details">
                    <div><dt>Zawodnik</dt><dd>{connection.name}</dd></div>
                    <div><dt>Aktywnosci</dt><dd>{connection.scopes.includes("activity:read_all") ? "Wszystkie" : "Publiczne i dla obserwujacych"}</dd></div>
                  </dl>
                )}
                {!settings?.strava && <p className="unavailable">Polaczenie Strava niedostepne.</p>}
                <div className="privacy-note">
                  <ShieldCheck size={20} />
                  <div>
                    <h3>Kontrola nad kontem</h3>
                    <a href="https://www.strava.com/settings/apps" target="_blank" rel="noreferrer">
                      Uprawnienia w Stravie <ArrowUpRight size={13} />
                    </a>
                  </div>
                </div>
              </article>

              {stravaConnected && (
                <HistorySync
                  status={history}
                  unavailable={historyError}
                  className={styles.historySync}
                />
              )}
            </section>
            <GarminImport enabled={Boolean(session?.user.id)} />
          </SettingsAccordion>

          <SettingsAccordion
            id="ai-engine"
            title="Silnik AI i klucze"
            status={configuredKeyCount ? `${configuredKeyCount} zapisane ${configuredKeyCount === 1 ? "poświadczenie" : "poświadczenia"}` : "Brak kluczy API"}
            icon="brain"
          >
            <ModelPreferences providers={providers} />
            {aiKeysError ? (
              <p className="notice" role="alert">Nie mozna odczytac statusu kluczy AI.</p>
            ) : session ? (
              <AIKeySettings keys={aiKeys} />
            ) : (
              <p className="settings-empty">Zaloguj sie, aby zarzadzac kluczami AI.</p>
            )}
          </SettingsAccordion>

          <SettingsAccordion
            id="preferences"
            title="Preferencje i powiadomienia"
            status="Zdrowie · powiadomienia"
            icon="sliders"
          >
            <PushSettings enabled={Boolean(session?.user.id)} />
            <section className="profile-health-panel">
              <h2>Profil zdrowotny</h2>
              {profileError ? <p role="alert">Nie mozna odczytac profilu.</p> : (
                <>
                  {profile.primaryGoal && <p>Cel: {profile.primaryGoal}</p>}
                  {Boolean(profile.injuries?.length) && <><h3>Urazy i aktualizacje</h3><ul>{profile.injuries?.map((injury) => <li key={injury}>{injury}</li>)}</ul></>}
                  {Boolean(profile.equipment?.length) && <><h3>Zmiany sprzetu</h3><ul>{profile.equipment?.map((equipment) => <li key={equipment}>{equipment}</li>)}</ul></>}
                  {!profile.primaryGoal && !profile.injuries?.length && !profile.equipment?.length && <p>Brak zapisanych informacji o celu treningowym i urazach.</p>}
                </>
              )}
            </section>
          </SettingsAccordion>

          <SettingsAccordion
            id="ai-privacy"
            title="Prywatność i anonimizacja AI"
            status="Zakres danych do modelu"
            icon="shield"
          >
            <AIPrivacySettings userId={session?.user.id ?? null} />
          </SettingsAccordion>
        </div>
        {session && (
          <form action={logout} className={styles.logoutFooter}>
            <SubmitButton logout label="Wyloguj" />
          </form>
        )}
      </div>
    </div>
  );
}