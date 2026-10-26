import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AI Trainer", short_name: "AI Trainer", lang: "pl",
    description: "Prywatny dziennik treningowy dla kolarzy i biegaczy.",
    id: "/", start_url: "/", scope: "/", display: "standalone",
    background_color: "#FDFBF7", theme_color: "#7A1A28",
    icons: [192, 512].map((size) => ({
      src: `/api/pwa-icon?size=${size}`, sizes: `${size}x${size}`, type: "image/png", purpose: "any",
    })),
  };
}