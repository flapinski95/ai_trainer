import "server-only";
import { parseAuthSettings } from "@/backend/auth/config";

export function authSettings() {
  return parseAuthSettings(process.env);
}
