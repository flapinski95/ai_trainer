"use client";

import { useState, type ReactNode } from "react";
import {
  BrainCircuit,
  ChevronDown,
  Link2,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import styles from "./settings.module.css";

const icons = {
  brain: BrainCircuit,
  link: Link2,
  shield: ShieldCheck,
  sliders: SlidersHorizontal,
};

export function SettingsAccordion({
  id,
  title,
  status,
  icon,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  status: string;
  icon: keyof typeof icons;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = `settings-panel-${id}`;
  const Icon = icons[icon];

  return (
    <section className={styles.accordion}>
      <h2 className={styles.accordionHeading}>
        <button
          className={styles.trigger}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
        >
          <Icon className={styles.sectionIcon} size={19} aria-hidden="true" />
          <span className={styles.headingText}>{title}</span>
          <span className={styles.status}>{status}</span>
          <ChevronDown className={styles.chevron} size={17} aria-hidden="true" />
        </button>
      </h2>
      <div
        className={`${styles.panel} ${open ? styles.panelOpen : ""}`}
        id={panelId}
        aria-hidden={!open}
        inert={!open}
      >
        <div className={styles.panelInner}>{children}</div>
      </div>
    </section>
  );
}