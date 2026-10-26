import { handlers } from "@/auth";
import { authSettings } from "@/lib/server-config";
import { NextResponse, type NextRequest } from "next/server";
import { garminAuthorizationResponse } from "@/backend/auth/garmin";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!authSettings())
    return NextResponse.json(
      { error: "Authentication unavailable" },
      { status: 503 },
    );
  return garminAuthorizationResponse(await handlers.GET(request));
}

export async function POST(request: NextRequest) {
  if (!authSettings())
    return NextResponse.json(
      { error: "Authentication unavailable" },
      { status: 503 },
    );
  return garminAuthorizationResponse(await handlers.POST(request));
}
