"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { auth, signIn, signOut } from "@/auth";
import { authSettings } from "@/lib/server-config";
import { authStore } from "@/lib/auth-store";
import { historyStore } from "@/lib/history-store";
import { requestStravaBackfill } from "@/backend/strava/backfill";
import { revalidatePath } from "next/cache";
import { garminAuthorizationRedirect } from "@/backend/auth/garmin";
import { aiProviders } from "@/backend/ai/credentials";
import type { AIProvider } from "@/backend/ai/credentials";
import { aiCredentialStore } from "@/lib/ai-credential-store";
import { athletePhysiologySchema, type AthletePhysiology } from "@/lib/athlete-zones";

export type PhysiologyActionState = {
  status: "idle" | "success" | "error";
  message: string;
  errors?: Partial<Record<keyof AthletePhysiology, string>>;
};

export async function saveAthletePhysiology(_previous: PhysiologyActionState, formData: FormData): Promise<PhysiologyActionState> {
  const session = await auth();
  if (!session?.user.id) return { status: "error", message: "Zaloguj się ponownie, aby zapisać progi." };
  const numberField = (field: string) => {
    const value = formData.get(field);
    return typeof value === "string" && value.trim() === "" ? undefined : typeof value === "string" ? Number(value) : NaN;
  };
  const parsed = athletePhysiologySchema.safeParse({
    max_hr: numberField("max_hr"),
    z2_hr_upper: numberField("z2_hr_upper"),
    lthr: numberField("lthr"),
    ftp_watts: numberField("ftp_watts"),
    has_power_meter: formData.get("has_power_meter") === "on",
  });
  if (!parsed.success) {
    const errors: PhysiologyActionState["errors"] = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "max_hr" || field === "z2_hr_upper" || field === "lthr" || field === "ftp_watts") {
        errors[field] = issue.code === "custom" ? issue.message : "Wpisz pełną liczbę w podanym zakresie.";
      }
    }
    return { status: "error", message: "Sprawdź wartości progów.", errors };
  }
  try {
    await authStore().setPhysiology(session.user.id, parsed.data);
  } catch (error) {
    console.error("athlete_physiology_save_failed", { type: error instanceof Error ? error.name : "UnknownError" });
    return { status: "error", message: "Nie udało się zapisać progów. Spróbuj ponownie." };
  }
  revalidatePath("/settings");
  return { status: "success", message: "Strefy i progi zostały zapisane." };
}

function formProvider(value: FormDataEntryValue | null): AIProvider | null {
  return typeof value === "string" && aiProviders.some((provider) => provider === value)
    ? (value as AIProvider)
    : null;
}

async function authenticatedUserId() {
  const session = await auth();
  if (!session?.user.id) redirect("/settings?error=authentication");
  return session.user.id;
}

export async function saveAIKey(formData: FormData) {
  const userId = await authenticatedUserId();
  const provider = formProvider(formData.get("provider"));
  const apiKey = formData.get("apiKey");
  if (!provider || typeof apiKey !== "string") redirect("/settings?error=ai-key");
  try {
    await aiCredentialStore().set(userId, provider, apiKey);
  } catch (error) {
    console.error("ai_credential_save_failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    redirect("/settings?error=ai-key");
  }
  revalidatePath("/settings");
  redirect("/settings?key=saved");
}

export async function deleteAIKey(formData: FormData) {
  const userId = await authenticatedUserId();
  const provider = formProvider(formData.get("provider"));
  if (!provider) redirect("/settings?error=ai-key");
  try {
    await aiCredentialStore().remove(userId, provider);
  } catch (error) {
    console.error("ai_credential_delete_failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    redirect("/settings?error=ai-key");
  }
  revalidatePath("/settings");
  redirect("/settings?key=removed");
}

export async function connectStrava() {
  if (!authSettings()?.strava) redirect("/settings?error=configuration");
  try {
    await signIn("strava", { redirectTo: "/settings" });
  } catch (error) {
    if (error instanceof AuthError) redirect("/settings?error=authentication");
    throw error;
  }
}

export async function logout() {
  await signOut({ redirectTo: "/" });
}

export async function connectGarmin() {
  if (!authSettings()?.garmin) redirect("/settings?error=configuration");
  try {
    const destination = await signIn("garmin", { redirectTo: "/settings", redirect: false });
    redirect(garminAuthorizationRedirect(destination));
  } catch (error) {
    if (error instanceof AuthError) redirect("/settings?error=authentication");
    throw error;
  }
}

export async function synchronizeHistory(_previous: { message: string }) {
  const session = await auth();
  if (!session?.user.id) return { message: "Zaloguj sie ponownie." };
  try {
    const connection = await authStore().connection(session.user.id);
    if (!connection?.active)
      return { message: "Najpierw polacz konto Strava." };
    const created = await requestStravaBackfill(
      historyStore(),
      session.user.id,
      connection.scopes.includes("activity:read_all"),
    );
    revalidatePath("/settings");
    return {
      message: created
        ? "Zlecono pelny import historii Stravy."
        : "Synchronizacja jest juz aktywna lub byla niedawno zlecona.",
    };
  } catch (error) {
    console.error("strava_history_enqueue_failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      message: "Nie udalo sie zlecic synchronizacji. Sprobuj ponownie.",
    };
  }
}
