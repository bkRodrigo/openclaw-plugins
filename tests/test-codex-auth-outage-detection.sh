#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'EOF_NODE'
import {
  AUTH_OUTAGE_PIN_REASON,
  AUTH_OUTAGE_PIN_SOURCE,
  classifyAgentFailure,
  isAuthOutageError,
} from "/home/forge/plugins/codex-openai-fallback/auth-outage.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(AUTH_OUTAGE_PIN_REASON === "auth-outage", "pin reason should be stable for cross-plugin coordination");
assert(AUTH_OUTAGE_PIN_SOURCE === "auth-refresh", "pin source should be stable for observability");

assert(
  isAuthOutageError("OAuth token refresh failed for openai-codex: Failed to refresh OAuth token for openai-codex. Please try again or re-authenticate."),
  "refresh failure should match auth outage"
);
assert(
  isAuthOutageError("OpenAI returned refresh_token_reused while refreshing openai-codex credentials"),
  "refresh_token_reused should match auth outage"
);
assert(
  isAuthOutageError("401 invalid_grant while refreshing OAuth token for openai-codex"),
  "401 refresh-context auth failure should match auth outage"
);
assert(
  !isAuthOutageError("Rate limit exceeded for openai-codex"),
  "rate limit should not match auth outage"
);
assert(
  !isAuthOutageError("OAuth token refresh failed for github-copilot"),
  "non-codex auth failures should not match auth outage"
);

const classified = classifyAgentFailure({
  success: false,
  error: "OAuth token refresh failed for openai-codex: refresh_token_reused",
});
assert(classified.kind === "auth_outage", "auth failure should classify as auth_outage");
assert(classified.reason === AUTH_OUTAGE_PIN_REASON, "classification should surface stable pin reason");
assert(classified.source === AUTH_OUTAGE_PIN_SOURCE, "classification should surface stable pin source");

const ignored = classifyAgentFailure({
  success: false,
  error: "tool execution failed: bad arguments",
});
assert(ignored.kind === "none", "non-provider failures should not classify as auth outage");

console.log("ok");
EOF_NODE
