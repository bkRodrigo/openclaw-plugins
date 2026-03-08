import { createSessionId, startReauthSession, cancelReauthSession, buildStatus } from "./state.mjs";

function normalizeList(values) {
  return Array.isArray(values)
    ? values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)
    : [];
}

function isAllowed(ctx, cfg) {
  const allowedChats = normalizeList(cfg.telegramChatIds);
  const allowedUsers = normalizeList(cfg.telegramUserIds);
  if (allowedChats.length === 0 && allowedUsers.length === 0) {
    return ctx.isAuthorizedSender !== false;
  }
  const chatId = typeof ctx.to === "string" ? ctx.to.trim() : "";
  const userId = typeof ctx.senderId === "string" ? ctx.senderId.trim() : typeof ctx.from === "string" ? ctx.from.trim() : "";
  const chatAllowed = allowedChats.length === 0 || (chatId && allowedChats.includes(chatId));
  const userAllowed = allowedUsers.length === 0 || (userId && allowedUsers.includes(userId));
  return chatAllowed && userAllowed;
}

function reply(text) {
  return { text };
}

function formatStatusText(status) {
  return [
    "Codex Reauth Status",
    `Outage active: ${status.outageActive ? "yes" : "no"}`,
    `Fallback pinned: ${status.fallbackPinned ? "yes" : "no"}`,
    `Session status: ${status.session.status}`,
    `Session ID: ${status.session.sessionId ?? "<none>"}`,
    `Failure reason: ${status.lastFailureReason ?? "<none>"}`,
  ].join("\n");
}

export function createCommandHandlers({ cfg, getState, saveState, now = () => Date.now(), createAuthUrl }) {
  return {
    async reauth(ctx) {
      if (!isAllowed(ctx, cfg)) {
        return reply("Re-auth command not authorized for this Telegram user/chat.");
      }
      const state = getState();
      if (!state.outageActive) {
        return reply("No active Codex auth outage. Primary SSO is not currently marked unavailable.");
      }
      const issuedAt = now();
      const sessionId = createSessionId(issuedAt);
      const authUrl = await createAuthUrl(sessionId, ctx);
      const result = startReauthSession(
        state,
        {
          sessionId,
          chatId: ctx.to ?? "",
          userId: ctx.senderId ?? ctx.from ?? "",
          authUrl,
          expiresAt: issuedAt + cfg.sessionTtlSeconds * 1000,
        },
        issuedAt
      );
      saveState(state);
      if (!result.ok) {
        if (result.reason === "session_active") {
          return reply("A re-auth session is already in progress. Use /reauth_status to inspect it.");
        }
        return reply("Unable to start re-auth right now.");
      }
      const pasteLine = cfg.allowPasteRedirect
        ? "If callback completion is unavailable, use /reauth_paste <redirect-url>."
        : "Callback completion is required on this host.";
      return reply(
        [
          "Re-auth session started.",
          `Open this URL in a browser: ${authUrl}`,
          `Session expires in ${cfg.sessionTtlSeconds} seconds.`,
          pasteLine,
        ].join("\n")
      );
    },

    async reauthStatus(ctx) {
      if (!isAllowed(ctx, cfg)) {
        return reply("Re-auth status is not authorized for this Telegram user/chat.");
      }
      return reply(formatStatusText(buildStatus(getState())));
    },

    async reauthCancel(ctx) {
      if (!isAllowed(ctx, cfg)) {
        return reply("Re-auth cancel is not authorized for this Telegram user/chat.");
      }
      const state = getState();
      const result = cancelReauthSession(
        state,
        {
          reason: "operator_cancelled",
          failureReason: "Cancelled by operator",
        },
        now()
      );
      saveState(state);
      if (!result.ok) {
        return reply("No active re-auth session to cancel.");
      }
      return reply("Re-auth session cancelled. API fallback remains active.");
    },
  };
}
