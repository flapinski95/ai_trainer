import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Trainer | Dziennik",
  description: "Prywatny dziennik treningowy dla kolarzy i biegaczy.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pl">
      <body>{children}</body>
    </html>
  );
}
