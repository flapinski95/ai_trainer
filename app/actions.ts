"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { auth, signIn, signOut } from "@/auth";
import { authSettings } from "@/lib/server-config";
import { authStore } from "@/lib/auth-store";
import { historyStore } from "@/lib/history-store";
import { revalidatePath } from "next/cache";
import { garminAuthorizationRedirect } from "@/backend/auth/garmin";
import { aiProviders } from "@/backend/ai/credentials";
import type { AIProvider } from "@/backend/ai/credentials";
import { aiCredentialStore } from "@/lib/ai-credential-store";

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
    const created = await historyStore().request(
      session.user.id,
      connection.scopes.includes("activity:read_all"),
      true,
    );
    revalidatePath("/settings");
    return {
      message: created
        ? "Zlecono synchronizacje historii."
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
