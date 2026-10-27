"use client";

import { useActionState, useState } from "react";
import { Check, LoaderCircle, Save } from "lucide-react";
import { athletePhysiologySchema, buildAthleteZones, type AthletePhysiology, type ZoneBand } from "@/lib/athlete-zones";
import { saveAthletePhysiology, type PhysiologyActionState } from "../actions";
import styles from "./settings.module.css";

const fields = [
  { name: "max_hr", label: "Tętno maksymalne", symbol: "HRmax", unit: "bpm", min: 50, max: 250 },
  { name: "z2_hr_upper", label: "Górny limit Z2", symbol: "Próg tlenowy", unit: "bpm", min: 40, max: 240 },
  { name: "lthr", label: "Próg beztlenowy", symbol: "LTHR", unit: "bpm", min: 50, max: 249 },
  { name: "ftp_watts", label: "Moc progowa", symbol: "FTP", unit: "W", min: 20, max: 1500 },
] as const;

function ZoneStrip({ zones, title, unit }: { zones: readonly ZoneBand[]; title: string; unit: string }) {
  return (
    <div className={styles.zonePreview}>
      <h3>{title} <span>{unit}</span></h3>
      <dl className={styles.zoneStrip}>
        {zones.map((band) => (
          <div key={band.zone}>
            <dt>{band.zone}</dt>
            <dd>{band.up_to === undefined ? `> ${band.above}` : band.above === 0 ? `≤ ${band.up_to}` : `${band.above + 1}–${band.up_to}`}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function PhysiologySettings({ initial, enabled, unavailable }: {
  initial: AthletePhysiology;
  enabled: boolean;
  unavailable: boolean;
}) {
  const [values, setValues] = useState(() => ({
    max_hr: initial.max_hr?.toString() ?? "",
    z2_hr_upper: initial.z2_hr_upper?.toString() ?? "",
    lthr: initial.lthr?.toString() ?? "",
    ftp_watts: initial.ftp_watts?.toString() ?? "",
  }));
  const [hasPowerMeter, setHasPowerMeter] = useState(initial.has_power_meter ?? false);
  const [state, action, pending] = useActionState<PhysiologyActionState, FormData>(saveAthletePhysiology, { status: "idle", message: "" });
  const parsed = athletePhysiologySchema.safeParse({
    ...Object.fromEntries(Object.entries(values).map(([field, value]) => [field, value.trim() === "" ? undefined : Number(value)])),
    has_power_meter: hasPowerMeter,
  });
  const zones = parsed.success ? buildAthleteZones(parsed.data) : undefined;
  const disabled = !enabled || unavailable || pending;

  return (
    <form action={action} className={styles.physiologyForm}>
      {!enabled && <p className="settings-empty">Zaloguj się, aby zapisać swoje progi.</p>}
      {unavailable && <p className="notice" role="alert">Nie można odczytać progów. Odśwież ustawienia przed zapisem.</p>}
      <fieldset disabled={disabled} className={styles.physiologyFields}>
        <legend>Progi indywidualne</legend>
        <div className={styles.physiologyGrid}>
          {fields.map((field) => (
            <div className={`${styles.physiologyField} ${field.name === "ftp_watts" ? styles.ftpField : ""}`} key={field.name}>
              <label htmlFor={`physiology-${field.name}`}>{field.label}<span>{field.symbol}</span></label>
              <div className={styles.physiologyInput}>
                <input
                  id={`physiology-${field.name}`}
                  name={field.name}
                  type="number"
                  inputMode="numeric"
                  min={field.min}
                  max={field.max}
                  step={1}
                  value={values[field.name]}
                  onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                  aria-invalid={Boolean(state.errors?.[field.name])}
                  aria-describedby={`physiology-${field.name}-hint${state.errors?.[field.name] ? ` physiology-${field.name}-error` : ""}`}
                />
                <span aria-hidden="true">{field.unit}</span>
              </div>
              <span className={styles.fieldHint} id={`physiology-${field.name}-hint`}>{field.min}–{field.max} {field.unit}</span>
              {state.errors?.[field.name] && <span className={styles.fieldError} id={`physiology-${field.name}-error`}>{state.errors[field.name]}</span>}
            </div>
          ))}
        </div>
        <label className={styles.powerMeterRow}>
          <span>Fizyczny pomiar mocy</span>
          <input type="checkbox" role="switch" name="has_power_meter" checked={hasPowerMeter} onChange={(event) => setHasPowerMeter(event.target.checked)} />
          <span className={styles.switchTrack} aria-hidden="true" />
        </label>
      </fieldset>
      {(zones?.hr || zones?.power) && (
        <div className={styles.zonePreviews} aria-live="polite">
          {zones.hr && <ZoneStrip zones={zones.hr} title={`HR · ${zones.hr_method === "lthr" ? "LTHR" : "HRmax"}`} unit="bpm" />}
          {zones.power && <ZoneStrip zones={zones.power} title="Moc · FTP" unit="W" />}
        </div>
      )}
      <div className={styles.physiologyFooter}>
        <p role={state.status === "error" ? "alert" : "status"}>{state.message || (zones?.hr_method === "insufficient_data" && values.z2_hr_upper ? "HR: niepełne progi" : "")}</p>
        <button type="submit" disabled={disabled} className={styles.physiologySave}>
          {pending ? <LoaderCircle size={16} className={styles.savingIcon} aria-hidden="true" /> : state.status === "success" ? <Check size={16} aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
          {pending ? "Zapisywanie" : "Zapisz progi"}
        </button>
      </div>
    </form>
  );
}