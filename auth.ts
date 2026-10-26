import "server-only";
import NextAuth, { AuthError } from "next-auth";
import Strava from "next-auth/providers/strava";
import {
  parseStravaAuthorization,
  StravaAuthorizationError,
} from "@/backend/auth/strava-account";
import { authStore } from "@/lib/auth-store";
import { authSettings } from "@/lib/server-config";
import { historyStore } from "@/lib/history-store";
import { getToken } from "next-auth/jwt";
import {
  garminOAuth,
  fetchGarminProfile,
  parseGarminAuthorization,
} from "@/backend/auth/garmin";

export const { handlers, auth, signIn, signOut } = NextAuth((request) => {
  const settings = authSettings();
  const callbackScope = request
    ? new URL(request.url).searchParams.get("scope")
    : null;
  return {
    secret: settings?.AUTH_SECRET,
    trustHost: Boolean(settings),
    session: { strategy: "jwt", maxAge: 60 * 60 * 8 },
    pages: { signIn: "/", error: "/" },
    providers: [
      ...(settings?.strava
        ? [
            Strava({
              clientId: settings.strava.AUTH_STRAVA_ID,
              clientSecret: settings.strava.AUTH_STRAVA_SECRET,
              checks: ["state"],
              authorization: {
                params: {
                  scope: "read,activity:read",
                  approval_prompt: "force",
                },
              },
              profile(profile) {
                return {
                  id: String(profile.id),
                  name: `${profile.firstname} ${profile.lastname}`,
                  email: null,
                  image: null,
                };
              },
            }),
          ]
        : []),
      ...(settings?.garmin
        ? [
            {
              id: "garmin",
              name: "Garmin",
              type: "oauth" as const,
              clientId: settings.garmin.AUTH_GARMIN_ID,
              clientSecret: settings.garmin.AUTH_GARMIN_SECRET,
              checks: ["pkce", "state"] as ("pkce" | "state")[],
              authorization: {
                url: garminOAuth.authorization,
                params: { response_type: "code" },
              },
              token: garminOAuth.token,
              client: { token_endpoint_auth_method: "client_secret_basic" },
              userinfo: {
                url: garminOAuth.userId,
                async request({
                  tokens,
                }: {
                  tokens: { access_token?: string };
                }) {
                  if (!tokens.access_token)
                    throw new Error("Garmin access token missing");
                  return fetchGarminProfile(tokens.access_token);
                },
              },
              profile(profile: { userId: string }) {
                return {
                  id: profile.userId,
                  name: "Uzytkownik Garmin",
                  email: null,
                  image: null,
                };
              },
            },
          ]
        : []),
    ],
    logger: {
      error(error) {
        console.error("authentication_failed", {
          type: error instanceof AuthError ? error.type : error.name,
          cause:
            error instanceof AuthError ? error.cause?.err?.name : undefined,
        });
      },
    },
    callbacks: {
      async signIn({ account, profile }) {
        try {
          if (account?.provider === "garmin")
            parseGarminAuthorization(account, profile);
          else parseStravaAuthorization(account, profile, callbackScope);
          return true;
        } catch (error) {
          if (error instanceof StravaAuthorizationError)
            return "/?error=permissions";
          return false;
        }
      },
      async jwt({ token, account, profile }) {
        if (account) {
          const provider = account.provider === "garmin" ? "garmin" : "strava";
          const authorized =
            provider === "garmin"
              ? parseGarminAuthorization(account, profile)
              : {
                  ...parseStravaAuthorization(account, profile, callbackScope),
                  provider: "strava" as const,
                };
          const currentSession =
            request && settings
              ? await getToken({
                  req: request,
                  secret: settings.AUTH_SECRET,
                  secureCookie: settings.AUTH_URL.startsWith("https:"),
                })
              : null;
          const store = authStore();
          const userId = await store.resolve(
            provider,
            authorized.athleteId,
            currentSession?.sub,
          );
          const linked = { ...authorized, userId };
          await store.connect(linked);
          if (provider === "strava")
            try {
              await historyStore().request(
                userId,
                authorized.scopes.includes("activity:read_all"),
              );
            } catch (error) {
              console.error("strava_history_enqueue_failed", {
                type: error instanceof Error ? error.name : "UnknownError",
              });
            }
          return { sub: userId, name: await store.profileName(userId) };
        }
        return { sub: token.sub, name: token.name };
      },
      session({ session, token }) {
        session.user.id = token.sub ?? "";
        session.user.name = token.name ?? "Zawodnik";
        return session;
      },
    },
  };
});
