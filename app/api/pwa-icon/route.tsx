import { ImageResponse } from "next/og";

export function GET(request: Request) {
  const requestedSize = Number(new URL(request.url).searchParams.get("size"));
  const size = requestedSize === 192 || requestedSize === 180 ? requestedSize : 512;
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#7A1A28", color: "#FDFBF7", fontSize: size * 0.4, fontWeight: 700 }}>AI</div>,
    { width: size, height: size, headers: { "cache-control": "public, max-age=86400" } },
  );
}