#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'EOF_NODE'
import {
  createCircuitState,
  recordDebugHookEvent,
  resetDebugState,
} from "/home/forge/plugins/codex-openai-fallback/core.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const state = createCircuitState();
assert(state.debug.beforeModelResolveCalls === 0, "debug state should initialize counters");
assert(state.debug.lastHookName === "", "debug state should initialize last hook name");

recordDebugHookEvent(state, "agent_end", {
  contentPrefix: "OAuth token refresh failed for openai-codex",
  channelId: "telegram",
  error: "OAuth token refresh failed for openai-codex",
}, 1000);

assert(state.debug.agentEndCalls === 1, "agent_end counter should increment");
assert(state.debug.lastHookName === "agent_end", "last hook name should be recorded");
assert(state.debug.lastHookAtMs === 1000, "last hook time should be recorded");
assert(
  state.debug.lastContentPrefix === "OAuth token refresh failed for openai-codex",
  "content prefix should be recorded",
);
assert(state.debug.lastChannelId === "telegram", "channel id should be recorded");

recordDebugHookEvent(state, "message_sending", { contentPrefix: "Agent failed before reply" }, 1500);
assert(state.debug.messageSendingCalls === 1, "message_sending counter should increment");
assert(state.debug.lastHookName === "message_sending", "last hook should update");

resetDebugState(state);
assert(state.debug.beforeModelResolveCalls === 0, "reset should clear counters");
assert(state.debug.agentEndCalls === 0, "reset should clear agent_end counter");
assert(state.debug.messageSendingCalls === 0, "reset should clear message_sending counter");
assert(state.debug.lastHookName === "", "reset should clear last hook name");
assert(state.debug.lastContentPrefix === "", "reset should clear last content prefix");

console.log("ok");
EOF_NODE
