import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import type { UIMessage } from "ai";
import styles from "./chat.module.css";

export type ThinkingStage = "telemetry" | "recovery" | "recommendations";
export type ThinkingProgress = {
  stage: ThinkingStage;
  recoveryDays?: number;
  workouts?: number;
};
export type CoachMessage = UIMessage<unknown, { thinking: ThinkingProgress }>;

const labels: Record<ThinkingStage, string> = {
  telemetry: "Przetwarzanie profilu i telemetrii...",
  recovery: "Analiza trendów regeneracji...",
  recommendations: "Formułowanie zaleceń...",
};

export function ThinkingStepper({ progress, complete = false, failed = false }: { progress: ThinkingProgress; complete?: boolean; failed?: boolean }) {
  return (
    <div className={`${styles.thinking} ${complete ? styles.analyzed : failed ? styles.interrupted : styles.analyzing}`}
      role="status" aria-live="polite">
      {complete ? <Check size={13} /> : failed ? <CircleAlert size={13} /> : <LoaderCircle size={13} />}
      <span>{complete ? "Przeanalizowano dane" : failed ? "Analiza przerwana" : labels[progress.stage]}</span>
    </div>
  );
}