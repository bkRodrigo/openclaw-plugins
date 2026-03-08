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
const savedStates = [];
const handlers = createCommandHandlers({
  cfg: {
    sessionTtlSeconds: 900,
    telegramChatIds: ["chat-1"],
    telegramUserIds: ["user-1"],
    allowPasteRedirect: true,
  },
  getState: () => state,
  saveState: () => {
    savedStates.push(JSON.parse(JSON.stringify(state)));
  },
  now: () => 1000,
  createAuthUrl: async (sessionId) => `https://example.test/oauth?session=${sessionId}`,
});

const unauthorized = await handlers.reauth({
  channel: "telegram",
  channelId: "telegram",
  isAuthorizedSender: true,
  senderId: "user-2",
  from: "user-2",
  to: "chat-1",
  commandBody: "/reauth",
  args: "",
  config: {},
});
assert(unauthorized.text.includes("not authorized"), "unauthorized sender should be rejected");

state.outageActive = true;
state.fallbackPinned = true;
state.fallbackPinReason = "auth-outage";
state.fallbackPinSource = "auth-refresh";
state.session.status = "reauth_pending";

const start = await handlers.reauth({
  channel: "telegram",
  channelId: "telegram",
  isAuthorizedSender: true,
  senderId: "user-1",
  from: "user-1",
  to: "chat-1",
  commandBody: "/reauth",
  args: "",
  config: {},
});
assert(start.text.includes("Re-auth session started"), "reauth should start a session");
assert(start.text.includes("https://example.test/oauth"), "reauth should return auth url");
assert(state.session.status === "reauth_in_progress", "reauth should move session to in-progress");
assert(savedStates.length >= 1, "reauth should persist state");

const status = await handlers.reauthStatus({
  channel: "telegram",
  channelId: "telegram",
  isAuthorizedSender: true,
  senderId: "user-1",
  from: "user-1",
  to: "chat-1",
  commandBody: "/reauth_status",
  args: "",
  config: {},
});
assert(status.text.includes("Outage active: yes"), "status should report outage state");
assert(status.text.includes("Session status: reauth_in_progress"), "status should report session state");

const canceled = await handlers.reauthCancel({
  channel: "telegram",
  channelId: "telegram",
  isAuthorizedSender: true,
  senderId: "user-1",
  from: "user-1",
  to: "chat-1",
  commandBody: "/reauth_cancel",
  args: "",
  config: {},
});
assert(canceled.text.includes("Re-auth session cancelled"), "cancel should acknowledge cancellation");
assert(state.session.status === "reauth_failed", "cancel should move session to retryable failed state");

console.log("ok");
EOF_NODE
