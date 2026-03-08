#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'EOF_NODE'
import {
  AUTH_OUTAGE_PIN_REASON,
  AUTH_OUTAGE_PIN_SOURCE,
  classifyMessageSendingEvent,
} from "/home/forge/plugins/codex-openai-fallback/auth-outage.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const classified = classifyMessageSendingEvent({
  content:
    "⚠️ Agent failed before reply: OAuth token refresh failed for openai-codex: Failed to refresh OAuth token for openai-codex. Please try again or re-authenticate.\nLogs: openclaw logs --follow",
});
assert(classified.kind === "auth_outage", "user-facing auth failure reply should classify as auth outage");
assert(classified.reason === AUTH_OUTAGE_PIN_REASON, "message trigger should use stable pin reason");
assert(classified.source === AUTH_OUTAGE_PIN_SOURCE, "message trigger should use stable pin source");

const ignored = classifyMessageSendingEvent({
  content: "⚠️ Context overflow — prompt too large for this model.",
});
assert(ignored.kind === "none", "non-auth failure replies should not classify");

console.log("ok");
EOF_NODE
