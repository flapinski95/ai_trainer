import { auth } from "@/auth";
import { z } from "zod";
import type { AIProvider } from "@/backend/ai/credentials";
import { aiCredentialStore } from "@/lib/ai-credential-store";
import { authSettings } from "@/lib/server-config";
import { ChatPanel } from "./chat-panel";
import styles from "./chat.module.css";

export const dynamic = "force-dynamic";

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ sessionId?: string }> }) {
  const query = await searchParams;
  const requestedSession = z.string().uuid().safeParse(query.sessionId);
  const session = authSettings() ? await auth() : null;
  let providers: AIProvider[] = [];
  let keysError = false;

  if (session?.user.id) {
    try {
      const keys = await aiCredentialStore().status(session.user.id);
      providers = keys.filter((key) => key.configured).map((key) => key.provider);
    } catch {
      keysError = true;
    }
  }

  return (
    <>
      <div className={`screen-content ${styles.screen}`}>
        {session ? (
          <>
            {keysError && (
              <p className="notice" role="alert">
                Nie mozna odczytac statusu kluczy AI.
              </p>
            )}
            <ChatPanel userId={session.user.id} providers={providers} initialSessionId={requestedSession.success ? requestedSession.data : undefined} />
          </>
        ) : (
          <>
            <header className={styles.pageHeader}><h1>Odprawa</h1></header>
            <section className="chat-locked">
              <p>Zaloguj sie w zakladce Profil, aby otworzyc rozmowe z trenerem.</p>
            </section>
          </>
        )}
      </div>
    </>
  );
}