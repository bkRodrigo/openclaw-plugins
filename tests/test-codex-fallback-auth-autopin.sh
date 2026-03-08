#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'EOF_NODE'
import { createCircuitState, isFallbackActive } from "/home/forge/plugins/codex-openai-fallback/core.mjs";
import {
  AUTH_OUTAGE_PIN_REASON,
  AUTH_OUTAGE_PIN_SOURCE,
  applyAgentFailureToCircuit,
} from "/home/forge/plugins/codex-openai-fallback/auth-outage.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const state = createCircuitState();
const mutated = applyAgentFailureToCircuit(
  state,
  {
    success: false,
    error: "OAuth token refresh failed for openai-codex: refresh_token_reused",
  },
  1000,
);
assert(mutated !== null, "auth outage should mutate circuit state");
assert(mutated?.kind === "auth_outage", "auth outage mutation should identify the failure kind");
assert(state.pinned === true, "auth outage should pin fallback");
assert(state.pinReason === AUTH_OUTAGE_PIN_REASON, "auth outage should record stable pin reason");
assert(state.pinSource === AUTH_OUTAGE_PIN_SOURCE, "auth outage should record stable pin source");
assert(isFallbackActive(state, 1000) === true, "pinned auth outage should activate fallback immediately");

const stateNoop = createCircuitState();
const noop = applyAgentFailureToCircuit(
  stateNoop,
  {
    success: false,
    error: "Rate limit exceeded for openai-codex",
  },
  1000,
);
assert(noop === null, "rate-limit path should not pin auth outage fallback");
assert(stateNoop.pinned === false, "non-auth failure should not pin fallback");

console.log("ok");
EOF_NODE
