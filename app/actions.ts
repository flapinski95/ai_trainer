"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { auth, signIn, signOut } from "@/auth";
import { authSettings } from "@/lib/server-config";
import { authStore } from "@/lib/auth-store";
import { historyStore } from "@/lib/history-store";
import { revalidatePath } from "next/cache";
import { garminAuthorizationRedirect } from "@/backend/auth/garmin";

export async function connectStrava() {
  if (!authSettings()?.strava) redirect("/?error=configuration");
  try {
    await signIn("strava", { redirectTo: "/" });
  } catch (error) {
    if (error instanceof AuthError) redirect("/?error=authentication");
    throw error;
  }
}

export async function logout() {
  await signOut({ redirectTo: "/" });
}

export async function connectGarmin() {
  if (!authSettings()?.garmin) redirect("/?error=configuration");
  try {
    const destination = await signIn("garmin", { redirectTo: "/", redirect: false });
    redirect(garminAuthorizationRedirect(destination));
  } catch (error) {
    if (error instanceof AuthError) redirect("/?error=authentication");
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
    revalidatePath("/");
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
