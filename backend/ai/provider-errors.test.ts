import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isUnavailableProviderError,
  providerErrorCode,
  providerErrorDetails,
  runWithGoogleFallback,
} from "./provider-errors";

test("extracts safe diagnostics from the final nested retry failure without exposing request details", () => {
  const error = Object.assign(new Error("secret response body"), {
    name: "AI_RetryError",
    reason: "maxRetriesExceeded",
    errors: [{ statusCode: 503 }],
    lastError: { statusCode: 429, requestHeaders: { authorization: "secret key" },
      data: { error: { status: "RESOURCE_EXHAUSTED", message: "secret response" } } },
  });
  assert.deepEqual(providerErrorDetails(error), {
    type: "AI_RetryError", statusCode: 429, providerStatus: "RESOURCE_EXHAUSTED", retryReason: "maxRetriesExceeded",
  });
  assert.equal(providerErrorCode(error), "provider_rate_limited");
  assert.doesNotMatch(JSON.stringify(providerErrorDetails(error)), /secret/);
});

test("classifies authentication, access, model, timeout and availability errors", () => {
  const cases = [
    [401, "provider_auth_failed"], [403, "provider_access_denied"], [404, "provider_model_not_found"],
    [400, "provider_invalid_request"], [408, "provider_timeout"], [504, "provider_timeout"], [503, "provider_unavailable"],
  ] as const;
  for (const [statusCode, expected] of cases) assert.equal(providerErrorCode({ cause: { statusCode } }), expected);
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(providerErrorCode(cyclic), "chat_unavailable");
});

test("detects provider 503 errors nested in AI SDK retry errors", () => {
  assert.equal(
    isUnavailableProviderError({
      name: "AI_RetryError",
      errors: [{ name: "AI_APICallError", statusCode: 503 }],
    }),
    true,
  );
  assert.equal(
    isUnavailableProviderError({
      data: { error: { status: "UNAVAILABLE" } },
    }),
    true,
  );
});

test("does not classify unrelated provider failures as temporary unavailability", () => {
  assert.equal(
    isUnavailableProviderError({ statusCode: 404, data: { error: { status: "NOT_FOUND" } } }),
    false,
  );
  assert.equal(isUnavailableProviderError(new Error("network error")), false);
});

test("retries Google 503 with Flash-Lite after the selected model is exhausted", async () => {
  const attempts: string[] = [];
  const result = await runWithGoogleFallback(
    "google",
    "gemini-3.8-flash",
    async (modelId) => {
      attempts.push(modelId);
      if (modelId === "gemini-3.8-flash")
        throw { errors: [{ statusCode: 503 }] };
      return "fallback response";
    },
    () => false,
  );

  assert.equal(result, "fallback response");
  assert.deepEqual(attempts, ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
});

test("falls back from a rate-limited Google model to Flash-Lite", async () => {
  const failures: unknown[] = [
    { statusCode: 429 },
    { name: "AI_RetryError", lastError: { statusCode: 429 } },
    { data: { error: { status: "RESOURCE_EXHAUSTED" } } },
    { errors: [{ data: { error: { status: "RESOURCE_EXHAUSTED" } } }] },
  ];
  for (const failure of failures) {
    const attempts: string[] = [];
    const result = await runWithGoogleFallback("google", "gemini-3.8-flash", async (modelId) => {
      attempts.push(modelId);
      if (modelId === "gemini-3.8-flash") throw failure;
      return "fallback response";
    }, () => false);
    assert.equal(result, "fallback response");
    assert.deepEqual(attempts, ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
  }
});

test("does not switch models after partial output, for another provider, or for permanent failures", async () => {
  const cases = [
    { provider: "google" as const, model: "gemini-3.8-flash", partial: true, error: { statusCode: 429 } },
    { provider: "openai" as const, model: "gpt-6.1-sol", partial: false, error: { statusCode: 429 } },
    ...[400, 401, 403, 404].map((statusCode) => ({
      provider: "google" as const, model: "gemini-3.8-flash", partial: false, error: { statusCode },
    })),
    { provider: "google" as const, model: "gemini-3.5-flash-lite", partial: false, error: { statusCode: 429 } },
  ];
  for (const scenario of cases) {
    const attempts: string[] = [];
    await assert.rejects(runWithGoogleFallback(scenario.provider, scenario.model, async (modelId) => {
      attempts.push(modelId);
      throw scenario.error;
    }, () => scenario.partial));
    assert.deepEqual(attempts, [scenario.model]);
  }
});

test("returns the fallback failure without looping if both Google models are rate limited", async () => {
  const attempts: string[] = [];
  const fallbackError = new Error("fallback quota exhausted");
  await assert.rejects(runWithGoogleFallback("google", "gemini-3.8-flash", async (modelId) => {
    attempts.push(modelId);
    if (modelId === "gemini-3.8-flash") throw { statusCode: 429 };
    throw fallbackError;
  }, () => false), (error) => error === fallbackError);
  assert.deepEqual(attempts, ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
});

test("does not fall back after partial output or for other providers and errors", async () => {
  const attempts: string[] = [];
  const run = async (modelId: string) => {
    attempts.push(modelId);
    throw { statusCode: 503 };
  };

  await assert.rejects(
    runWithGoogleFallback("google", "gemini-3.8-flash", run, () => true),
  );
  await assert.rejects(
    runWithGoogleFallback("openai", "gpt-6.1-sol", run, () => false),
  );
  assert.deepEqual(attempts, ["gemini-3.8-flash", "gpt-6.1-sol"]);
});