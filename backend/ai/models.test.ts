import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatModels,
  defaultChatModels,
  isChatModelForProvider,
} from "./models";

test("lists current text chat models for every supported AI provider", () => {
  assert.deepEqual(
    Object.keys(chatModels).sort(),
    ["anthropic", "google", "openai"],
  );
  assert.ok(chatModels.openai.some((model) => model.id === "gpt-6-luna"));
  assert.ok(chatModels.anthropic.some((model) => model.id === "claude-haiku-5-5"));
  assert.ok(chatModels.google.some((model) => model.id === "gemini-3.8-flash"));
});

test("accepts only model IDs listed for the selected provider", () => {
  assert.equal(isChatModelForProvider("google", "gemini-4-argon"), true);
  assert.equal(isChatModelForProvider("google", "gpt-6-astra"), false);
  assert.equal(isChatModelForProvider("openai", "unlisted-model"), false);
});

test("defaults to the balanced model for each provider", () => {
  assert.equal(defaultChatModels.openai, "gpt-6.1-sol");
  assert.equal(defaultChatModels.anthropic, "claude-sonnet-5-5");
  assert.equal(defaultChatModels.google, "gemini-3.8-flash");
  for (const provider of Object.keys(defaultChatModels) as (keyof typeof chatModels)[])
    assert.ok(isChatModelForProvider(provider, defaultChatModels[provider]));
});