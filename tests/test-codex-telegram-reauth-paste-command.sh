#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'EOF_NODE'
import {
  createCommandHandlers,
} from "/home/forge/plugins/codex-telegram-reauth/commands.mjs";
import {
  createReauthState,
} from "/home/forge/plugins/codex-telegram-reauth/state.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const state = createReauthState();
state.outageActive = true;
state.fallbackPinned = true;
state.session.status = "reauth_in_progress";
state.session.sessionId = "sess-1";
state.session.expectedState = "state-1";
state.session.verifier = "verifier-1";

let completedInput = null;
let saved = 0;
let verified = 0;
let released = 0;
let repinned = 0;
const handlers = createCommandHandlers({
  cfg: {
    sessionTtlSeconds: 900,
    telegramChatIds: ["chat-1"],
    telegramUserIds: ["user-1"],
    allowPasteRedirect: true,
  },
  getState: () => state,
  saveState: () => {
    saved += 1;
  },
  now: () => 2000,
  createAuthUrl: async () => "https://example.test/oauth",
  completeAuthPaste: async (params) => {
    completedInput = params;
    state.session.callbackReceivedAt = 2000;
    state.session.credentialWriteAt = 2001;
    return {
      profileId: "openai-codex:test@example.com",
      credentials: { accountId: "acct-1" },
    };
  },
  verifyPrimary: async () => {
    verified += 1;
    return { ok: true };
  },
  releaseFallback: async () => {
    released += 1;
    state.outageActive = false;
    state.fallbackPinned = false;
  },
  ensureFallbackPinned: async () => {
    repinned += 1;
    state.fallbackPinned = true;
  },
});

const response = await handlers.reauthPaste({
  channel: "telegram",
  channelId: "telegram",
  isAuthorizedSender: true,
  senderId: "user-1",
  from: "user-1",
  to: "chat-1",
  commandBody: "/reauth_paste http://localhost:1455/auth/callback?code=code-1&state=state-1",
  args: "http://localhost:1455/auth/callback?code=code-1&state=state-1",
  config: {},
});

assert(response.text.includes("OpenAI Codex SSO restored"), "paste command should announce restored SSO");
assert(response.text.includes("API fallback released"), "paste command should announce fallback release");
assert(completedInput?.input?.includes("code=code-1"), "paste command should pass redirect URL to completion");
assert(completedInput?.expectedState === "state-1", "paste command should pass expected state");
assert(completedInput?.verifier === "verifier-1", "paste command should pass stored PKCE verifier");
assert(verified === 1, "paste command should verify primary before release");
assert(released === 1, "paste command should release fallback after successful verification");
assert(state.session.status === "recovered", "paste command should advance session status to recovered");
assert(state.outageActive === false, "paste command should clear outage state after recovery");
assert(state.fallbackPinned === false, "paste command should clear fallback pin after recovery");
assert(saved >= 1, "paste command should persist updated state");

state.outageActive = true;
state.fallbackPinned = false;
state.lastFailureReason = "";
state.session.status = "reauth_in_progress";
state.session.sessionId = "sess-2";
state.session.expectedState = "state-2";
state.session.verifier = "verifier-2";

const failingHandlers = createCommandHandlers({
  cfg: {
    sessionTtlSeconds: 900,
    telegramChatIds: ["chat-1"],
    telegramUserIds: ["user-1"],
    allowPasteRedirect: true,
  },
  getState: () => state,
  saveState: () => {
    saved += 1;
  },
  now: () => 3000,
  createAuthUrl: async () => "https://example.test/oauth",
  completeAuthPaste: async () => ({
    profileId: "openai-codex:test@example.com",
    credentials: { accountId: "acct-1" },
  }),
  verifyPrimary: async () => {
    verified += 1;
    return { ok: false, reason: "Primary request timed out" };
  },
  ensureFallbackPinned: async () => {
    repinned += 1;
    state.fallbackPinned = true;
  },
});

const failedResponse = await failingHandlers.reauthPaste({
  channel: "telegram",
  channelId: "telegram",
  isAuthorizedSender: true,
  senderId: "user-1",
  from: "user-1",
  to: "chat-1",
  commandBody: "/reauth_paste http://localhost:1455/auth/callback?code=code-2&state=state-2",
  args: "http://localhost:1455/auth/callback?code=code-2&state=state-2",
  config: {},
});

assert(failedResponse.text.includes("primary verification failed"), "paste failure should explain verification failure");
assert(failedResponse.text.includes("Primary request timed out"), "paste failure should include clean failure reason");
assert(repinned >= 1, "failed verification should re-pin fallback");
assert(state.fallbackPinned === true, "failed verification should leave fallback pinned");
assert(state.session.status === "verification_failed", "failed verification should record failure state");

console.log("ok");
EOF_NODE
