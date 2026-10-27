import { z } from "zod";

export const physiologyFields = ["max_hr", "z2_hr_upper", "lthr", "ftp_watts", "has_power_meter"] as const;

export const athletePhysiologySchema = z.object({
  max_hr: z.number().int().min(50).max(250).optional(),
  z2_hr_upper: z.number().int().min(40).max(240).optional(),
  lthr: z.number().int().min(50).max(249).optional(),
  ftp_watts: z.number().int().min(20).max(1500).optional(),
  has_power_meter: z.boolean().optional(),
}).superRefine((value, context) => {
  if (value.max_hr !== undefined && value.lthr !== undefined && value.lthr >= value.max_hr) {
    context.addIssue({ code: "custom", path: ["lthr"], message: "LTHR musi być niższe od HRmax." });
  }
  const ceiling = value.lthr ?? value.max_hr;
  if (value.z2_hr_upper !== undefined && ceiling !== undefined && value.z2_hr_upper > ceiling - 3) {
    context.addIssue({ code: "custom", path: ["z2_hr_upper"], message: "Limit Z2 musi być co najmniej o 3 bpm niższy od LTHR lub HRmax." });
  }
});

export type AthletePhysiology = z.infer<typeof athletePhysiologySchema>;
export type ZoneName = "Z1" | "Z2" | "Z3" | "Z4" | "Z5";
export type ZoneBand = { zone: ZoneName; above: number; up_to?: number };
export type AthleteZones = {
  settings: AthletePhysiology;
  hr_method: "lthr" | "max_hr" | "insufficient_data";
  hr?: ZoneBand[];
  power?: ZoneBand[];
};

function bands(limits: number[], maximum?: number): ZoneBand[] {
  const names: ZoneName[] = ["Z1", "Z2", "Z3", "Z4", "Z5"];
  return names.map((zone, index) => ({ zone, above: index === 0 ? 0 : limits[index - 1]!, up_to: index === 4 ? maximum : limits[index] }));
}

export function buildAthleteZones(value: AthletePhysiology): AthleteZones {
  const settings = athletePhysiologySchema.parse(value);
  let hr: ZoneBand[] | undefined;
  let hrMethod: AthleteZones["hr_method"] = "insufficient_data";
  if (settings.lthr !== undefined) {
    const threshold = settings.lthr;
    const z2 = settings.z2_hr_upper ?? Math.round(threshold * 0.9) - 1;
    const z1 = Math.min(Math.round(threshold * 0.85) - 1, z2 - 1);
    const z3 = Math.min(threshold - 2, Math.max(Math.round(threshold * 0.95) - 1, z2 + 1));
    hr = bands([z1, z2, z3, threshold - 1], settings.max_hr);
    hrMethod = "lthr";
  } else if (settings.max_hr !== undefined) {
    const maximum = settings.max_hr;
    const z2 = settings.z2_hr_upper ?? Math.floor(maximum * 0.7);
    const z1 = Math.min(Math.floor(maximum * 0.6), z2 - 1);
    const z3 = Math.min(maximum - 2, Math.max(Math.floor(maximum * 0.8), z2 + 1));
    const z4 = Math.min(maximum - 1, Math.max(Math.floor(maximum * 0.9), z3 + 1));
    hr = bands([z1, z2, z3, z4], maximum);
    hrMethod = "max_hr";
  }
  const power = settings.ftp_watts === undefined ? undefined
    : bands([0.55, 0.75, 0.9, 1.05].map((fraction) => Math.floor(settings.ftp_watts! * fraction)));
  return { settings, hr_method: hrMethod, hr, power };
}

export function classifyZone(value: number | undefined, zones: readonly ZoneBand[] | undefined): ZoneName | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || !zones) return undefined;
  return zones.find((band) => value > band.above && (band.up_to === undefined || value <= band.up_to))?.zone;
}