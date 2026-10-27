import { Activity, Bike, Footprints } from "lucide-react";
import type { Workout } from "@/backend/workouts/store";

const previewSize = 4;
const workoutDate = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Europe/Warsaw",
});
const distance = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 });

function formatDuration(seconds: number) {
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function WorkoutList({
  connected,
  error,
  workouts,
}: {
  connected: boolean;
  error: boolean;
  workouts: Workout[];
}) {
  const visibleWorkouts = workouts.slice(0, previewSize);

  return (
    <section id="activities" className="activity-section" aria-label="Ostatnie treningi">
      <h2 className="dashboard-section-title">Ostatnie treningi</h2>
      {error ? (
        <p className="notice" role="alert">
          Nie można odczytać treningów. Spróbuj odświeżyć dziennik.
        </p>
      ) : workouts.length ? (
        <>
          <ul className="workout-list">
            {visibleWorkouts.map((workout) => {
              const normalizedSport = workout.sport.toLowerCase();
              const SportIcon = normalizedSport.includes("ride") || normalizedSport.includes("bike")
                ? Bike
                : normalizedSport.includes("run")
                  ? Footprints
                  : Activity;
              const sportLabel = SportIcon === Bike
                ? "Kolarstwo"
                : SportIcon === Footprints
                  ? "Bieg"
                  : workout.sport;
              const workoutUrl =
                workout.provider === "strava"
                  ? `https://www.strava.com/activities/${workout.id}`
                  : /^\d+$/.test(workout.id)
                    ? `https://connect.garmin.com/modern/activity/${workout.id}`
                    : "#activities";
              const workoutDistance = distance.format(workout.distance / 1000);
              const workoutDuration = formatDuration(
                workout.provider === "garmin"
                  ? workout.elapsedTime
                  : workout.movingTime,
              );
              const elevation =
                workout.elevationGain === undefined
                  ? "—"
                  : `${Math.round(workout.elevationGain)} m`;

              return (
                <li
                  className="workout-row"
                  key={`${workout.provider}-${workout.id}`}
                >
                  <div className="workout-main">
                    <div className="workout-identity">
                      <span className="workout-sport-badge" title={workout.sport}>
                        <SportIcon size={14} aria-hidden="true" />
                        {sportLabel}
                      </span>
                      <a
                        className="workout-title"
                        href={workoutUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {workout.name}
                      </a>
                    </div>
                    <div className="workout-details">
                      <time dateTime={workout.startedAt}>
                        {workoutDate.format(new Date(workout.startedAt))}
                      </time>
                      <span className="workout-separator" aria-hidden="true">·</span>
                      <span aria-label={`Dystans: ${workoutDistance} km`}>
                        {workoutDistance} km
                      </span>
                      <span className="workout-separator" aria-hidden="true">·</span>
                      <span aria-label={`Czas: ${workoutDuration}`}>
                        {workoutDuration}
                      </span>
                      <span className="workout-separator" aria-hidden="true">·</span>
                      <span aria-label={`Wznios: ${elevation}`}>
                        {elevation}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <div className="dashboard-empty">
          <h3>Brak zsynchronizowanych treningów</h3>
          <p>
            {connected
              ? "Twój dziennik jest jeszcze pusty."
              : "Konto sportowe nie jest połączone."}
          </p>
        </div>
      )}
    </section>
  );
}