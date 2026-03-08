#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'EOF_NODE'
import { probePrimaryAuthAvailability } from "/home/forge/plugins/codex-openai-fallback/auth-preflight.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const ok = await probePrimaryAuthAvailability({
  cfg: {},
  provider: "openai-codex",
  runtimeLoader: async () => ({
    ensureAuthProfileStore: () => ({ profiles: { "openai-codex:default": { provider: "openai-codex", type: "oauth" } } }),
    resolveAuthProfileOrder: () => ["openai-codex:default"],
    resolveApiKeyForProfile: async () => ({ apiKey: "ok" }),
    resolveApiKeyForProvider: async () => ({ apiKey: "ok" }),
    resolveOpenClawAgentDir: () => "/tmp/openclaw-agent",
    resolveAgentDir: () => "/tmp/openclaw-agent",
  }),
});
assert(ok.available === true, "successful auth probe should report available");
assert(ok.kind === "ok", "successful auth probe should report ok kind");

const authOutage = await probePrimaryAuthAvailability({
  cfg: {},
  provider: "openai-codex",
  runtimeLoader: async () => ({
    ensureAuthProfileStore: () => ({ profiles: { "openai-codex:default": { provider: "openai-codex", type: "oauth" } } }),
    resolveAuthProfileOrder: () => ["openai-codex:default"],
    resolveApiKeyForProfile: async () => {
      throw new Error(
        "OAuth token refresh failed for openai-codex: refresh_token_reused. Please try again or re-authenticate."
      );
    },
    resolveApiKeyForProvider: async () => {
      throw new Error('No API key found for provider "openai-codex".');
    },
    resolveOpenClawAgentDir: () => "/tmp/openclaw-agent",
    resolveAgentDir: () => "/tmp/openclaw-agent",
  }),
});
assert(authOutage.available === false, "auth outage should report unavailable");
assert(authOutage.kind === "auth_outage", "auth outage should classify explicitly");
assert(
  authOutage.error.includes("refresh_token_reused"),
  "auth outage should preserve the profile-level refresh failure instead of the generic provider fallback error"
);

const providerLevelAuthOutage = await probePrimaryAuthAvailability({
  cfg: {},
  provider: "openai-codex",
  runtimeLoader: async () => ({
    ensureAuthProfileStore: () => ({ profiles: {} }),
    resolveAuthProfileOrder: () => [],
    resolveApiKeyForProfile: async () => null,
    resolveApiKeyForProvider: async () => {
      throw new Error(
        "OAuth token refresh failed for openai-codex: refresh_token_reused. Please try again or re-authenticate."
      );
    },
    resolveOpenClawAgentDir: () => "/tmp/openclaw-agent",
    resolveAgentDir: () => "/tmp/openclaw-agent",
  }),
});
assert(providerLevelAuthOutage.available === false, "provider-level auth outage should report unavailable");
assert(providerLevelAuthOutage.kind === "auth_outage", "provider-level auth outage should classify explicitly");
assert(
  providerLevelAuthOutage.error.includes("refresh_token_reused"),
  "provider-level auth outage should preserve the original error for observability"
);

const otherFailure = await probePrimaryAuthAvailability({
  cfg: {},
  provider: "openai-codex",
  runtimeLoader: async () => ({
    ensureAuthProfileStore: () => ({ profiles: { "openai-codex:default": { provider: "openai-codex", type: "oauth" } } }),
    resolveAuthProfileOrder: () => ["openai-codex:default"],
    resolveApiKeyForProfile: async () => null,
    resolveApiKeyForProvider: async () => {
      throw new Error("No API key found for provider \"openai-codex\".");
    },
    resolveOpenClawAgentDir: () => "/tmp/openclaw-agent",
    resolveAgentDir: () => "/tmp/openclaw-agent",
  }),
});
assert(otherFailure.available === false, "generic auth resolution failure should report unavailable");
assert(otherFailure.kind === "other_error", "non-outage failure should not classify as auth outage");

console.log("ok");
EOF_NODE
