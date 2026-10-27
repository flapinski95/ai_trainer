import type { AIProvider } from "./credentials";
import { googleFallbackModel } from "./models";

export function providerErrorDetails(error: unknown) {
  const visited = new Set<object>();
  const pending: unknown[] = [error];
  let statusCode: number | undefined;
  let providerStatus: string | undefined;
  let retryReason: string | undefined;
  const statuses = new Set([
    "RESOURCE_EXHAUSTED", "UNAVAILABLE", "NOT_FOUND", "UNAUTHENTICATED",
    "PERMISSION_DENIED", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED", "INTERNAL",
  ]);
  const type = error instanceof Error ? error.name : "UnknownError";
  while (pending.length > 0 && visited.size < 64) {
    const value = pending.shift();
    if (typeof value !== "object" || value === null || visited.has(value)) continue;
    visited.add(value);
    const record = value as Record<string, unknown>;
    if (statusCode === undefined && typeof record.statusCode === "number"
      && Number.isInteger(record.statusCode) && record.statusCode >= 400 && record.statusCode <= 599) {
      statusCode = record.statusCode;
    }
    if (!providerStatus && typeof record.status === "string" && statuses.has(record.status)) providerStatus = record.status;
    if (!retryReason && typeof record.reason === "string"
      && ["maxRetriesExceeded", "errorNotRetryable", "abort"].includes(record.reason)) retryReason = record.reason;
    pending.push(record.lastError, record.cause, record.data, record.error);
    if (Array.isArray(record.errors)) pending.push(...record.errors.slice(-8).reverse());
  }
  return { type, statusCode, providerStatus, retryReason };
}

export function providerErrorCode(error: unknown) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.message === "provider_timeout") return "provider_timeout";
    if (error.message === "chat_generation_empty") return "chat_generation_empty";
    if (error.message === "chat_generation_interrupted") return "chat_generation_interrupted";
  }
  const details = providerErrorDetails(error);
  if (details.statusCode === 429 || details.providerStatus === "RESOURCE_EXHAUSTED") return "provider_rate_limited";
  if (details.statusCode === 401 || details.providerStatus === "UNAUTHENTICATED") return "provider_auth_failed";
  if (details.statusCode === 403 || details.providerStatus === "PERMISSION_DENIED") return "provider_access_denied";
  if (details.statusCode === 404 || details.providerStatus === "NOT_FOUND") return "provider_model_not_found";
  if (details.statusCode === 400 || details.providerStatus === "INVALID_ARGUMENT") return "provider_invalid_request";
  if (details.statusCode === 408 || details.statusCode === 504 || details.providerStatus === "DEADLINE_EXCEEDED") return "provider_timeout";
  if ((details.statusCode !== undefined && details.statusCode >= 500) || details.providerStatus === "UNAVAILABLE") return "provider_unavailable";
  return "chat_unavailable";
}

export function isUnavailableProviderError(error: unknown) {
  const visited = new Set<object>();

  function inspect(value: unknown): boolean {
    if (typeof value !== "object" || value === null || visited.has(value))
      return false;
    visited.add(value);
    const record = value as Record<string, unknown>;
    const data = record.data as Record<string, unknown> | undefined;
    const dataError = data?.error as Record<string, unknown> | undefined;
    if (
      record.statusCode === 503 ||
      record.status === "UNAVAILABLE" ||
      dataError?.status === "UNAVAILABLE"
    )
      return true;
    if (
      inspect(record.cause) ||
      inspect(record.lastError) ||
      inspect(record.data)
    )
      return true;
    return Array.isArray(record.errors) && record.errors.some(inspect);
  }

  return inspect(error);
}

export async function runWithGoogleFallback<T>(
  provider: AIProvider,
  selectedModel: string,
  run: (modelId: string) => Promise<T>,
  hasPartialOutput: () => boolean,
) {
  try {
    return await run(selectedModel);
  } catch (error) {
    if (
      provider !== "google" ||
      selectedModel === googleFallbackModel ||
      hasPartialOutput() ||
      (!isUnavailableProviderError(error) && !["provider_rate_limited", "provider_timeout", "chat_generation_empty"].includes(providerErrorCode(error)))
    )
      throw error;
    return run(googleFallbackModel);
  }
}