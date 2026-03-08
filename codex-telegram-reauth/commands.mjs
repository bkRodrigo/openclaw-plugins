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

export function createCommandHandlers({
  cfg,
  getState,
  saveState,
  now = () => Date.now(),
  createAuthStart,
  createAuthUrl,
  completeAuthPaste,
  verifyPrimary,
  releaseFallback,
  ensureFallbackPinned,
}) {
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
      const authStart = createAuthStart
        ? await createAuthStart({ sessionId, ctx })
        : { url: await createAuthUrl(sessionId, ctx), verifier: "", state: "" };
      const result = startReauthSession(
        state,
        {
          sessionId,
          chatId: ctx.to ?? "",
          userId: ctx.senderId ?? ctx.from ?? "",
          authUrl: authStart.url,
          verifier: authStart.verifier,
          expectedState: authStart.state,
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
          `Open this URL in a browser: ${authStart.url}`,
          `Session expires in ${cfg.sessionTtlSeconds} seconds.`,
          pasteLine,
        ].join("\n")
      );
    },

    async reauthPaste(ctx) {
      if (!isAllowed(ctx, cfg)) {
        return reply("Re-auth paste is not authorized for this Telegram user/chat.");
      }
      if (typeof completeAuthPaste !== "function") {
        return reply("Redirect paste completion is not configured on this host.");
      }
      const input = typeof ctx.args === "string" ? ctx.args.trim() : "";
      if (!input) {
        return reply("Missing redirect URL. Usage: /reauth_paste <redirect-url>");
      }
      const state = getState();
      if (state.session.status !== "reauth_in_progress" || !state.session.sessionId) {
        return reply("No active re-auth session is waiting for redirect input.");
      }
      try {
        const completed = await completeAuthPaste({
          input,
          expectedState: state.session.expectedState,
          verifier: state.session.verifier,
          sessionId: state.session.sessionId,
          chatId: state.session.chatId,
          userId: state.session.userId,
        });
        state.session.callbackReceivedAt = now();
        state.session.credentialWriteAt = now();
        state.session.profileId = completed?.profileId ?? "";
        state.session.status = "primary_verifying";
        state.lastFailureReason = "";
        saveState(state);
        const verification = typeof verifyPrimary === "function" ? await verifyPrimary(state) : { ok: false, reason: "not_configured" };
        state.session.verificationAttemptAt = now();
        if (!verification?.ok) {
          if (typeof ensureFallbackPinned === "function") {
            await ensureFallbackPinned(state);
          }
          state.session.status = "verification_failed";
          state.lastFailureReason = verification?.reason || "Primary verification failed";
          saveState(state);
          return reply(
            [
              "OpenAI Codex SSO credentials were updated, but primary verification failed.",
              "API fallback remains active.",
              `Reason: ${state.lastFailureReason}`,
              "Retry with /reauth if needed.",
            ].join("\n")
          );
        }
        if (typeof releaseFallback === "function") {
          await releaseFallback(state);
        }
        state.session.verificationPassedAt = now();
        state.session.status = "recovered";
        state.outageActive = false;
        state.outageReason = "";
        state.fallbackPinned = false;
        state.fallbackPinReason = "";
        state.fallbackPinSource = "";
        state.lastFailureReason = "";
        saveState(state);
        return reply(
          [
            "OpenAI Codex SSO restored.",
            "Primary verification passed.",
            "API fallback released.",
          ].join("\n")
        );
      } catch (error) {
        if (typeof ensureFallbackPinned === "function") {
          await ensureFallbackPinned(state);
        }
        state.session.status = "reauth_failed";
        state.lastFailureReason = String(error?.message ?? error);
        saveState(state);
        return reply(
          [
            "OpenAI Codex SSO re-auth failed.",
            "API fallback remains active.",
            `Reason: ${state.lastFailureReason}`,
          ].join("\n")
        );
      }
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
