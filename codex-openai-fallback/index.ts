import type { OpenClawConfig } from "openclaw/plugin-sdk/config/types.js";
import type { OpenClawPluginApi, PluginHookAgentContext } from "openclaw/plugin-sdk";
import {
  armFallbackWindow,
  cleanupExpiredFallbackWindow,
  clearFallbackWindow,
  createCircuitState,
  isFallbackActive,
  pinFallback,
  refreshThrottleFallback,
  releasePinnedFallback,
  remainingSeconds,
} from "./core.mjs";
import { applyAgentFailureToCircuit, applyMessageSendingEventToCircuit } from "./auth-outage.mjs";

type PluginCfg = {
  enabled: boolean;
  cooldownMs: number;
  authOutagePinEnabled: boolean;
  primaryProvider: string;
  primaryModelPrefixes: string[];
  fallbackProvider: string;
  fallbackModel: string;
};

type CircuitState = {
  untilMs: number;
  lastThrottleAtMs: number;
  lastThrottleReason: string;
  lastAppliedAtMs: number;
  appliedCount: number;
  pinned: boolean;
  pinReason: string;
  pinSource: string;
  lastAuthOutageAtMs: number;
  lastAuthOutageError: string;
};

type CircuitStatus = {
  enabled: boolean;
  cooldownSeconds: number;
  active: boolean;
  fallbackUntilMs: number | null;
  fallbackRemainingMs: number;
  lastThrottleAtMs: number | null;
  lastThrottleReason: string | null;
  lastAppliedAtMs: number | null;
  appliedCount: number;
  primaryProvider: string;
  primaryModelPrefixes: string[];
  fallbackProvider: string;
  fallbackModel: string;
  pinned: boolean;
  pinReason: string | null;
  pinSource: string | null;
  authOutagePinEnabled: boolean;
  lastAuthOutageAtMs: number | null;
  lastAuthOutageError: string | null;
};

const DEFAULT_CFG: PluginCfg = {
  enabled: true,
  cooldownMs: 5 * 60 * 1000,
  authOutagePinEnabled: true,
  primaryProvider: "openai-codex",
  primaryModelPrefixes: ["gpt-5.3-codex", "gpt-5.2-codex"],
  fallbackProvider: "openai",
  fallbackModel: "gpt-5.3-codex",
};

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b/i,
  /rate\s*limit/i,
  /throttl/i,
  /too\s*many\s*requests/i,
  /quota/i,
  /retry\s*after/i,
  /openai[-_ ]?codex/i,
];

function normalizeCfg(raw: unknown): PluginCfg {
  const cfgRaw = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const enabled = typeof cfgRaw.enabled === "boolean" ? cfgRaw.enabled : DEFAULT_CFG.enabled;

  const cooldownSecondsRaw = cfgRaw.cooldownSeconds;
  const cooldownSeconds =
    typeof cooldownSecondsRaw === "number" && Number.isFinite(cooldownSecondsRaw)
      ? Math.max(15, Math.min(3600, Math.floor(cooldownSecondsRaw)))
      : DEFAULT_CFG.cooldownMs / 1000;

  const authOutagePinEnabled =
    typeof cfgRaw.authOutagePinEnabled === "boolean"
      ? cfgRaw.authOutagePinEnabled
      : DEFAULT_CFG.authOutagePinEnabled;

  const primaryProvider =
    typeof cfgRaw.primaryProvider === "string" && cfgRaw.primaryProvider.trim().length > 0
      ? cfgRaw.primaryProvider.trim()
      : DEFAULT_CFG.primaryProvider;

  const primaryModelPrefixes = Array.isArray(cfgRaw.primaryModelPrefixes)
    ? cfgRaw.primaryModelPrefixes
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter((v) => v.length > 0)
    : DEFAULT_CFG.primaryModelPrefixes;

  const fallbackProvider =
    typeof cfgRaw.fallbackProvider === "string" && cfgRaw.fallbackProvider.trim().length > 0
      ? cfgRaw.fallbackProvider.trim()
      : DEFAULT_CFG.fallbackProvider;

  const fallbackModel =
    typeof cfgRaw.fallbackModel === "string" && cfgRaw.fallbackModel.trim().length > 0
      ? cfgRaw.fallbackModel.trim()
      : DEFAULT_CFG.fallbackModel;

  return {
    enabled,
    cooldownMs: cooldownSeconds * 1000,
    authOutagePinEnabled,
    primaryProvider,
    primaryModelPrefixes,
    fallbackProvider,
    fallbackModel,
  };
}

function parseModelRef(ref: unknown): { provider?: string; model?: string } {
  if (typeof ref !== "string") {
    return {};
  }
  const raw = ref.trim();
  if (!raw) {
    return {};
  }
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash >= raw.length - 1) {
    return { model: raw };
  }
  return {
    provider: raw.slice(0, slash).trim(),
    model: raw.slice(slash + 1).trim(),
  };
}

function resolveConfiguredPrimarySelection(
  cfg: OpenClawConfig,
  agentId?: string,
): { provider?: string; model?: string } {
  const agents = (cfg as Record<string, unknown>).agents as Record<string, unknown> | undefined;
  const entries = agents?.entries as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;

  const entry =
    agentId && entries && typeof entries[agentId] === "object"
      ? (entries[agentId] as Record<string, unknown>)
      : undefined;

  const modelFromEntry = entry?.model;
  const modelFromDefaults = defaults?.model;
  const modelConfig = modelFromEntry ?? modelFromDefaults;

  if (!modelConfig) {
    return {};
  }

  if (typeof modelConfig === "string") {
    return parseModelRef(modelConfig);
  }

  if (typeof modelConfig === "object") {
    const primary = (modelConfig as Record<string, unknown>).primary;
    if (typeof primary === "string") {
      return parseModelRef(primary);
    }
  }

  return {};
}

function matchesPrimaryTarget(
  selected: { provider?: string; model?: string },
  pluginCfg: PluginCfg,
): boolean {
  const provider = selected.provider?.trim();
  const model = selected.model?.trim();

  if (provider && provider === pluginCfg.primaryProvider) {
    return true;
  }

  if (!model) {
    return false;
  }

  return pluginCfg.primaryModelPrefixes.some((prefix) => model.startsWith(prefix));
}

function isRateLimitError(error: unknown): boolean {
  if (typeof error !== "string") {
    return false;
  }
  const msg = error.trim();
  if (!msg) {
    return false;
  }
  return RATE_LIMIT_PATTERNS.some((p) => p.test(msg));
}

function buildStatus(cfg: PluginCfg, state: CircuitState): CircuitStatus {
  const now = Date.now();
  return {
    enabled: cfg.enabled,
    cooldownSeconds: Math.floor(cfg.cooldownMs / 1000),
    active: cfg.enabled && isFallbackActive(state, now),
    fallbackUntilMs: state.untilMs || null,
    fallbackRemainingMs: state.untilMs > now ? state.untilMs - now : 0,
    lastThrottleAtMs: state.lastThrottleAtMs || null,
    lastThrottleReason: state.lastThrottleReason || null,
    lastAppliedAtMs: state.lastAppliedAtMs || null,
    appliedCount: state.appliedCount,
    primaryProvider: cfg.primaryProvider,
    authOutagePinEnabled: cfg.authOutagePinEnabled,
    primaryModelPrefixes: cfg.primaryModelPrefixes,
    fallbackProvider: cfg.fallbackProvider,
    fallbackModel: cfg.fallbackModel,
    pinned: state.pinned === true,
    pinReason: state.pinReason || null,
    pinSource: state.pinSource || null,
    lastAuthOutageAtMs: state.lastAuthOutageAtMs || null,
    lastAuthOutageError: state.lastAuthOutageError || null,
  };
}

const fallbackPlugin = {
  id: "codex-openai-fallback",
  name: "Codex/OpenAI Fallback",
  register(api: OpenClawPluginApi) {
    const cfg = normalizeCfg(api.pluginConfig);
    const state = createCircuitState() as CircuitState;

    api.registerGatewayMethod("codex-fallback.status", ({ respond }: any) => {
      respond(true, buildStatus(cfg, state));
    });

    api.registerGatewayMethod("codex-fallback.arm", ({ params, respond }: any) => {
      const secondsRaw = params && typeof params.seconds === "number" ? params.seconds : 60;
      const armedSeconds = armFallbackWindow(state, secondsRaw, "manual-arm");
      api.logger.warn(
        `codex-openai-fallback: fallback entered (source=manual-arm, until_ms=${state.untilMs}, remaining_s=${remainingSeconds(state)})`
      );
      state.lastThrottleReason = `manual-arm:${armedSeconds}s`;
      respond(true, buildStatus(cfg, state));
    });

    api.registerGatewayMethod("codex-fallback.disarm", ({ respond }: any) => {
      const wasActive = clearFallbackWindow(state);
      if (wasActive) {
        api.logger.info("codex-openai-fallback: fallback exited (source=manual-disarm)");
      }
      respond(true, buildStatus(cfg, state));
    });

    api.registerGatewayMethod("codex-fallback.pin", ({ params, respond }: any) => {
      const reason =
        params && typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : "pinned";
      const source =
        params && typeof params.source === "string" && params.source.trim() ? params.source.trim() : "manual-pin";
      pinFallback(state, reason, source);
      api.logger.warn(
        `codex-openai-fallback: fallback pinned (source=${state.pinSource}, reason=${state.pinReason})`
      );
      respond(true, buildStatus(cfg, state));
    });

    api.registerGatewayMethod("codex-fallback.release", ({ respond }: any) => {
      const wasPinned = releasePinnedFallback(state);
      if (wasPinned) {
        api.logger.info("codex-openai-fallback: fallback pin released");
      }
      respond(true, buildStatus(cfg, state));
    });

    api.registerCli(({ program }) => {
      const root = program
        .command("codex-fallback")
        .description("Inspect Codex/OpenAI fallback circuit state.");

      root
        .command("status")
        .description("Print circuit-breaker status")
        .option("--json", "Emit machine-readable JSON")
        .action((opts: { json?: boolean }) => {
          const payload = buildStatus(cfg, state);
          if (opts.json) {
            console.log(JSON.stringify(payload, null, 2));
            return;
          }
          console.log(`enabled: ${payload.enabled}`);
          console.log(`active: ${payload.active}`);
          console.log(`cooldown_seconds: ${payload.cooldownSeconds}`);
          console.log(`fallback_remaining_ms: ${payload.fallbackRemainingMs}`);
          console.log(`last_throttle_reason: ${payload.lastThrottleReason ?? "<none>"}`);
          console.log(`applied_count: ${payload.appliedCount}`);
          console.log(`primary: ${payload.primaryProvider}`);
          console.log(`auth_outage_pin_enabled: ${payload.authOutagePinEnabled}`);
          console.log(`fallback: ${payload.fallbackProvider}/${payload.fallbackModel}`);
          console.log(`pinned: ${payload.pinned}`);
          console.log(`pin_reason: ${payload.pinReason ?? "<none>"}`);
          console.log(`pin_source: ${payload.pinSource ?? "<none>"}`);
          console.log(`last_auth_outage_at_ms: ${payload.lastAuthOutageAtMs ?? "<none>"}`);
          console.log(`last_auth_outage_error: ${payload.lastAuthOutageError ?? "<none>"}`);
        });

      root
        .command("arm")
        .description("Force fallback mode for a short test window")
        .option("--seconds <n>", "Fallback duration in seconds", "60")
        .action((opts: { seconds?: string }) => {
          const seconds = Number.parseInt(opts.seconds ?? "60", 10) || 60;
          const armedSeconds = armFallbackWindow(state, seconds, "cli-arm");
          api.logger.warn(
            `codex-openai-fallback: fallback entered (source=cli-arm, until_ms=${state.untilMs}, remaining_s=${remainingSeconds(state)})`
          );
          console.log(`armed for ${armedSeconds}s`);
        });

      root
        .command("disarm")
        .description("Disable fallback mode immediately")
        .action(() => {
          const wasActive = clearFallbackWindow(state);
          if (wasActive) {
            api.logger.info("codex-openai-fallback: fallback exited (source=cli-disarm)");
          }
          console.log("disarmed");
        });

      root
        .command("pin")
        .description("Pin fallback mode until explicitly released")
        .option("--reason <text>", "Reason for the pin", "pinned")
        .option("--source <text>", "Pin source label", "cli-pin")
        .action((opts: { reason?: string; source?: string }) => {
          pinFallback(state, opts.reason ?? "pinned", opts.source ?? "cli-pin");
          api.logger.warn(
            `codex-openai-fallback: fallback pinned (source=${state.pinSource}, reason=${state.pinReason})`
          );
          console.log("pinned");
        });

      root
        .command("release")
        .description("Release pinned fallback mode")
        .action(() => {
          const wasPinned = releasePinnedFallback(state);
          if (wasPinned) {
            api.logger.info("codex-openai-fallback: fallback pin released");
          }
          console.log("released");
        });
    });

    api.on("before_model_resolve", (_event, ctx: PluginHookAgentContext) => {
      if (!cfg.enabled) {
        return;
      }

      const selected = resolveConfiguredPrimarySelection(api.config, ctx.agentId);
      if (!matchesPrimaryTarget(selected, cfg)) {
        return;
      }

      const now = Date.now();
      if (cleanupExpiredFallbackWindow(state, now)) {
        if (state.pinned) {
          api.logger.info(
            `codex-openai-fallback: fallback cooldown expired but pin remains active (pin_source=${state.pinSource || "n/a"}, pin_reason=${state.pinReason || "n/a"})`
          );
        } else {
          api.logger.info(
            `codex-openai-fallback: fallback exited (source=cooldown-expired, last_reason=${state.lastThrottleReason || "n/a"})`
          );
        }
      }
      if (!isFallbackActive(state, now)) {
        return;
      }

      state.appliedCount += 1;
      state.lastAppliedAtMs = now;

      api.logger.info(
        `codex-openai-fallback: fallback request routed (provider=${cfg.fallbackProvider}, model=${cfg.fallbackModel}, remaining_s=${remainingSeconds(state, now)}, pinned=${state.pinned === true ? "true" : "false"})`
      );

      return {
        providerOverride: cfg.fallbackProvider,
        modelOverride: cfg.fallbackModel,
      };
    });

    api.on("agent_end", (event) => {
      if (!cfg.enabled) {
        return;
      }
      if (event.success) {
        return;
      }

      const now = Date.now();
      if (cfg.authOutagePinEnabled) {
        const authOutage = applyAgentFailureToCircuit(state, event, now);
        if (authOutage) {
          if (authOutage.wasPinned) {
            api.logger.warn(
              `codex-openai-fallback: auth outage detected while fallback already pinned (source=${state.pinSource}, reason=${state.pinReason})`
            );
          } else {
            api.logger.error(
              `codex-openai-fallback: auth outage detected; fallback pinned (source=${state.pinSource}, reason=${state.pinReason})`
            );
          }
          return;
        }
      }

      if (!isRateLimitError(event.error)) {
        return;
      }

      const { wasWindowActive, previousRemainingSeconds } = refreshThrottleFallback(
        state,
        cfg.cooldownMs,
        typeof event.error === "string" ? event.error : "rate-limit",
        now
      );
      if (wasWindowActive) {
        api.logger.warn(
          `codex-openai-fallback: fallback window refreshed (source=throttle, previous_remaining_s=${previousRemainingSeconds}, new_remaining_s=${remainingSeconds(state, now)})`
        );
      } else {
        api.logger.warn(
          `codex-openai-fallback: fallback entered (source=throttle, remaining_s=${remainingSeconds(state, now)})`
        );
      }
    });

    api.on("message_sending", (event, ctx) => {
      if (!cfg.enabled || !cfg.authOutagePinEnabled) {
        return;
      }
      if (ctx.channelId !== "telegram") {
        return;
      }
      const now = Date.now();
      const authOutage = applyMessageSendingEventToCircuit(state, event, now);
      if (!authOutage) {
        return;
      }
      if (authOutage.wasPinned) {
        api.logger.warn(
          `codex-openai-fallback: auth outage reply observed while fallback already pinned (channel=${ctx.channelId}, source=${state.pinSource}, reason=${state.pinReason})`
        );
      } else {
        api.logger.error(
          `codex-openai-fallback: auth outage reply observed; fallback pinned (channel=${ctx.channelId}, source=${state.pinSource}, reason=${state.pinReason})`
        );
      }
    });

    api.logger.info(
      `codex-openai-fallback: loaded (primary=${cfg.primaryProvider}, fallback=${cfg.fallbackProvider}/${cfg.fallbackModel}, cooldown=${Math.floor(cfg.cooldownMs / 1000)}s, auth_outage_pin_enabled=${cfg.authOutagePinEnabled ? "true" : "false"})`
    );
  },
};

export default fallbackPlugin;
