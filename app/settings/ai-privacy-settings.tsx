"use client";

import { useEffect, useState } from "react";
import {
  defaultAIDataPreferences,
  readAIDataPreferences,
  saveAIDataPreferences,
  type AIDataPreferences,
} from "@/lib/ai-data-preferences";
import styles from "./settings.module.css";

const options: { key: keyof AIDataPreferences; label: string }[] = [
  { key: "recoveryMetrics", label: "Przesyłaj metryki regeneracji (HRV, Body Battery, sen)" },
  { key: "locationDetails", label: "Przesyłaj szczegółowe trasy GPS i nazwy miejsc" },
  { key: "effortZones", label: "Przesyłaj strefy tętna i wykresy wysiłku" },
];

export function AIPrivacySettings({ userId }: { userId: string | null }) {
  const [preferences, setPreferences] = useState(defaultAIDataPreferences);

  useEffect(() => {
    setPreferences(userId ? readAIDataPreferences(userId) : defaultAIDataPreferences);
  }, [userId]);

  function updatePreference(key: keyof AIDataPreferences, checked: boolean) {
    setPreferences((current) => {
      const updated = { ...current, [key]: checked };
      if (userId) saveAIDataPreferences(userId, updated);
      return updated;
    });
  }

  return (
    <section className={styles.privacySettings} aria-label="Zakres danych dla AI">
      {options.map(({ key, label }) => (
        <label className={styles.privacyOption} key={key}>
          <span className={styles.privacyLabel}>{label}</span>
          <input
            className="push-switch"
            type="checkbox"
            role="switch"
            checked={preferences[key]}
            disabled={!userId}
            onChange={(event) => updatePreference(key, event.target.checked)}
            aria-label={label}
          />
        </label>
      ))}
      <p className={styles.privacyNote}>
        Wybory są zapisywane w tej przeglądarce dla zalogowanego konta i stosowane do kolejnych zapytań. Nie obejmują treści wcześniejszych wiadomości. Trasy GPS nie są obecnie dołączane do kontekstu; wyłączenie nazw aktywności ogranicza informacje o miejscach.
      </p>
      {!userId && <p className="settings-empty">Zaloguj się, aby zapisać preferencje prywatności.</p>}
    </section>
  );
}