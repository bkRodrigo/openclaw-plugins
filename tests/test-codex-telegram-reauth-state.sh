#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'EOF_NODE'
import fs from "fs";
import os from "os";
import path from "path";

import {
  buildStatus,
  createReauthState,
  createSessionId,
  beginOutage,
  startReauthSession,
  cancelReauthSession,
  loadState,
  saveState,
} from "/home/forge/plugins/codex-telegram-reauth/state.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-reauth-state-"));
const statePath = path.join(tmpDir, "state.json");

const initial = createReauthState();
assert(initial.outageActive === false, "initial state should not have an outage");
assert(initial.session.status === "idle", "initial session should be idle");

const loadedMissing = loadState(statePath);
assert(loadedMissing.session.status === "idle", "missing state file should load defaults");

const outage = beginOutage(initial, {
  reason: "auth-outage",
  fallbackPinned: true,
  fallbackPinSource: "auth-refresh",
  fallbackPinReason: "auth-outage",
  failureReason: "OAuth token refresh failed for openai-codex: refresh_token_reused",
}, 1000);
assert(outage.changed === true, "first outage should change state");
assert(initial.outageActive === true, "outage should become active");
assert(initial.session.status === "reauth_pending", "outage should move session to pending");

const repeated = beginOutage(initial, {
  reason: "auth-outage",
  fallbackPinned: true,
  fallbackPinSource: "auth-refresh",
  fallbackPinReason: "auth-outage",
  failureReason: "OAuth token refresh failed for openai-codex: refresh_token_reused",
}, 1500);
assert(repeated.changed === false, "repeat outage during same incident should not mutate state");

const sessionId = createSessionId(1234567890);
const started = startReauthSession(initial, {
  sessionId,
  chatId: "chat-123",
  userId: "user-456",
  authUrl: "https://example.test/oauth",
  expiresAt: 1234567890 + 900000,
}, 1234567890);
assert(started.ok === true, "pending outage should allow reauth session start");
assert(initial.session.status === "reauth_in_progress", "reauth start should set in-progress status");
assert(initial.session.sessionId === sessionId, "session id should be recorded");

const duplicate = startReauthSession(initial, {
  sessionId: createSessionId(1234567891),
  chatId: "chat-123",
  userId: "user-456",
  authUrl: "https://example.test/oauth2",
  expiresAt: 1234567891 + 900000,
}, 1234567891);
assert(duplicate.ok === false, "second concurrent reauth session should be rejected");

saveState(statePath, initial);
const loaded = loadState(statePath);
assert(loaded.session.sessionId === sessionId, "saved state should persist session id");
assert(loaded.session.status === "reauth_in_progress", "saved state should persist session status");

const canceled = cancelReauthSession(loaded, {
  reason: "operator_cancelled",
  failureReason: "Cancelled by operator",
}, 1234567999);
assert(canceled.ok === true, "active session should be cancellable");
assert(loaded.session.status === "reauth_failed", "cancel should move session to failed/retryable state");
assert(loaded.lastFailureReason === "Cancelled by operator", "cancel should preserve failure reason");

const status = buildStatus(loaded);
assert(status.outageActive === true, "cancel should preserve outage active state");
assert(status.session.status === "reauth_failed", "status should reflect failed state");

console.log("ok");
EOF_NODE
