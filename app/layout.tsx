import type { Metadata } from "next";
import { AppShell } from "./app-shell";
import { PWARegistration } from "./pwa-registration";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Trainer | Dziennik",
  description: "Prywatny dziennik treningowy dla kolarzy i biegaczy.",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "AI Trainer", statusBarStyle: "default" },
  icons: { apple: "/api/pwa-icon?size=180" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pl" data-scroll-behavior="smooth">
      <body>
        <PWARegistration />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
