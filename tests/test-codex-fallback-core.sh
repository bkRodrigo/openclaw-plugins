#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'EOF'
import {
  armFallbackWindow,
  cleanupExpiredFallbackWindow,
  clearFallbackWindow,
  createCircuitState,
  isFallbackActive,
  pinFallback,
  releasePinnedFallback,
  remainingSeconds,
} from "/home/forge/plugins/codex-openai-fallback/core.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const state = createCircuitState();
assert(isFallbackActive(state, 1000) === false, "initial state should be inactive");

const armedSeconds = armFallbackWindow(state, 30, "manual-arm", 1000);
assert(armedSeconds === 30, "arm should preserve bounded seconds");
assert(isFallbackActive(state, 1000) === true, "armed cooldown should be active");
assert(remainingSeconds(state, 1000) === 30, "remaining seconds should match cooldown");

pinFallback(state, "auth-outage", "reauth-plugin");
assert(isFallbackActive(state, 1000) === true, "pin should force active fallback");
assert(state.pinned === true, "pin flag should be true");
assert(state.pinReason === "auth-outage", "pin reason should be recorded");
assert(state.pinSource === "reauth-plugin", "pin source should be recorded");

const expired = cleanupExpiredFallbackWindow(state, state.untilMs + 1);
assert(expired === true, "expired cooldown should be cleaned up");
assert(state.untilMs === 0, "expired cooldown should be cleared");
assert(isFallbackActive(state, state.untilMs + 1) === true, "pin should keep fallback active after cooldown expiry");

const clearedTimedWindow = clearFallbackWindow(state, state.untilMs + 1);
assert(clearedTimedWindow === false, "clearing an already expired cooldown should report false");
assert(isFallbackActive(state, 5000) === true, "clearing cooldown should not release pin");

const released = releasePinnedFallback(state);
assert(released === true, "release should report prior pin state");
assert(state.pinned === false, "release should clear pin flag");
assert(state.pinReason === "", "release should clear pin reason");
assert(state.pinSource === "", "release should clear pin source");
assert(isFallbackActive(state, 5000) === false, "released pin with no cooldown should become inactive");

console.log("ok");
EOF
