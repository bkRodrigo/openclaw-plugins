import fs from "fs";
import path from "path";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import {
  beginOutage,
  buildStatus,
  cancelReauthSession,
  createSessionId,
  loadState,
  saveState,
  startReauthSession,
} from "./state.mjs";

type PluginCfg = {
  enabled: boolean;
  fallbackPluginId: string;
  provider: string;
  primaryModelRef: string;
  sessionTtlSeconds: number;
  alertCooldownSeconds: number;
  autoStartReauth: boolean;
  allowPasteRedirect: boolean;
  telegramChatIds: string[];
  telegramUserIds: string[];
  verificationPrompt: string;
  verificationExpectedText: string;
};

const DEFAULT_CFG: PluginCfg = {
  enabled: true,
  fallbackPluginId: "codex-openai-fallback",
  provider: "openai-codex",
  primaryModelRef: "openai-codex/gpt-5.3-codex",
  sessionTtlSeconds: 900,
  alertCooldownSeconds: 300,
  autoStartReauth: false,
  allowPasteRedirect: true,
  telegramChatIds: [],
  telegramUserIds: [],
  verificationPrompt: "Reply with PRIMARY_REAUTH_OK and nothing else.",
  verificationExpectedText: "PRIMARY_REAUTH_OK",
};

function normalizeCfg(raw: unknown): PluginCfg {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = (key: string) =>
    Array.isArray(source[key])
      ? source[key].map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)
      : [];

  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_CFG.enabled,
    fallbackPluginId:
      typeof source.fallbackPluginId === "string" && source.fallbackPluginId.trim()
        ? source.fallbackPluginId.trim()
        : DEFAULT_CFG.fallbackPluginId,
    provider:
      typeof source.provider === "string" && source.provider.trim() ? source.provider.trim() : DEFAULT_CFG.provider,
    primaryModelRef:
      typeof source.primaryModelRef === "string" && source.primaryModelRef.trim()
        ? source.primaryModelRef.trim()
        : DEFAULT_CFG.primaryModelRef,
    sessionTtlSeconds:
      typeof source.sessionTtlSeconds === "number" && Number.isFinite(source.sessionTtlSeconds)
        ? Math.max(60, Math.min(86400, Math.floor(source.sessionTtlSeconds)))
        : DEFAULT_CFG.sessionTtlSeconds,
    alertCooldownSeconds:
      typeof source.alertCooldownSeconds === "number" && Number.isFinite(source.alertCooldownSeconds)
        ? Math.max(0, Math.min(86400, Math.floor(source.alertCooldownSeconds)))
        : DEFAULT_CFG.alertCooldownSeconds,
    autoStartReauth:
      typeof source.autoStartReauth === "boolean" ? source.autoStartReauth : DEFAULT_CFG.autoStartReauth,
    allowPasteRedirect:
      typeof source.allowPasteRedirect === "boolean" ? source.allowPasteRedirect : DEFAULT_CFG.allowPasteRedirect,
    telegramChatIds: list("telegramChatIds"),
    telegramUserIds: list("telegramUserIds"),
    verificationPrompt:
      typeof source.verificationPrompt === "string" && source.verificationPrompt.trim()
        ? source.verificationPrompt.trim()
        : DEFAULT_CFG.verificationPrompt,
    verificationExpectedText:
      typeof source.verificationExpectedText === "string" && source.verificationExpectedText.trim()
        ? source.verificationExpectedText.trim()
        : DEFAULT_CFG.verificationExpectedText,
  };
}

function resolveStatePath() {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(process.env.HOME || "/home/openclaw", ".openclaw");
  return path.join(stateDir, "state", "plugins", "codex-telegram-reauth", "state.json");
}

const plugin = {
  id: "codex-telegram-reauth",
  name: "Codex Telegram Reauth",
  register(api: OpenClawPluginApi) {
    const cfg = normalizeCfg(api.pluginConfig);
    const statePath = resolveStatePath();
    let state = loadState(statePath);

    const persist = () => {
      saveState(statePath, state);
    };

    api.registerGatewayMethod("codex-reauth.status", ({ respond }: any) => {
      respond(true, {
        enabled: cfg.enabled,
        fallbackPluginId: cfg.fallbackPluginId,
        provider: cfg.provider,
        primaryModelRef: cfg.primaryModelRef,
        sessionTtlSeconds: cfg.sessionTtlSeconds,
        alertCooldownSeconds: cfg.alertCooldownSeconds,
        allowPasteRedirect: cfg.allowPasteRedirect,
        autoStartReauth: cfg.autoStartReauth,
        state: buildStatus(state),
      });
    });

    api.registerGatewayMethod("codex-reauth.begin-outage", ({ params, respond }: any) => {
      const now = Date.now();
      const result = beginOutage(
        state,
        {
          reason: params?.reason,
          fallbackPinned: params?.fallbackPinned === true,
          fallbackPinReason: params?.fallbackPinReason,
          fallbackPinSource: params?.fallbackPinSource,
          failureReason: params?.failureReason,
        },
        now
      );
      persist();
      respond(true, {
        changed: result.changed,
        state: buildStatus(state),
      });
    });

    api.registerGatewayMethod("codex-reauth.start", ({ params, respond }: any) => {
      const now = Date.now();
      const result = startReauthSession(
        state,
        {
          sessionId: params?.sessionId || createSessionId(now),
          chatId: params?.chatId,
          userId: params?.userId,
          authUrl: params?.authUrl,
          expiresAt: now + cfg.sessionTtlSeconds * 1000,
        },
        now
      );
      persist();
      respond(result.ok, {
        reason: result.ok ? null : result.reason,
        state: buildStatus(state),
      });
    });

    api.registerGatewayMethod("codex-reauth.cancel", ({ params, respond }: any) => {
      const now = Date.now();
      const result = cancelReauthSession(
        state,
        {
          reason: params?.reason,
          failureReason: params?.failureReason,
        },
        now
      );
      persist();
      respond(result.ok, {
        reason: result.ok ? null : result.reason,
        state: buildStatus(state),
      });
    });

    api.registerCli(({ program }) => {
      const root = program.command("codex-reauth").description("Inspect Codex Telegram reauth state.");
      root
        .command("status")
        .option("--json", "Emit machine-readable JSON")
        .action((opts: { json?: boolean }) => {
          const payload = {
            enabled: cfg.enabled,
            fallbackPluginId: cfg.fallbackPluginId,
            provider: cfg.provider,
            primaryModelRef: cfg.primaryModelRef,
            sessionTtlSeconds: cfg.sessionTtlSeconds,
            alertCooldownSeconds: cfg.alertCooldownSeconds,
            allowPasteRedirect: cfg.allowPasteRedirect,
            autoStartReauth: cfg.autoStartReauth,
            state: buildStatus(state),
          };
          if (opts.json) {
            console.log(JSON.stringify(payload, null, 2));
            return;
          }
          console.log(`enabled: ${payload.enabled}`);
          console.log(`provider: ${payload.provider}`);
          console.log(`primary_model_ref: ${payload.primaryModelRef}`);
          console.log(`outage_active: ${payload.state.outageActive}`);
          console.log(`session_status: ${payload.state.session.status}`);
          console.log(`session_id: ${payload.state.session.sessionId ?? "<none>"}`);
          console.log(`fallback_pinned: ${payload.state.fallbackPinned}`);
        });
    });

    if (!fs.existsSync(statePath)) {
      persist();
    }

    api.logger.info(
      `codex-telegram-reauth: loaded (provider=${cfg.provider}, fallback_plugin_id=${cfg.fallbackPluginId}, session_ttl_s=${cfg.sessionTtlSeconds})`
    );
  },
};

export default plugin;
