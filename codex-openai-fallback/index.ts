import type { OpenClawConfig } from "openclaw/plugin-sdk/config/types.js";
import type { OpenClawPluginApi, PluginHookAgentContext } from "openclaw/plugin-sdk";

type PluginCfg = {
  enabled: boolean;
  cooldownMs: number;
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
};

const DEFAULT_CFG: PluginCfg = {
  enabled: true,
  cooldownMs: 5 * 60 * 1000,
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
    active: cfg.enabled && state.untilMs > now,
    fallbackUntilMs: state.untilMs || null,
    fallbackRemainingMs: state.untilMs > now ? state.untilMs - now : 0,
    lastThrottleAtMs: state.lastThrottleAtMs || null,
    lastThrottleReason: state.lastThrottleReason || null,
    lastAppliedAtMs: state.lastAppliedAtMs || null,
    appliedCount: state.appliedCount,
    primaryProvider: cfg.primaryProvider,
    primaryModelPrefixes: cfg.primaryModelPrefixes,
    fallbackProvider: cfg.fallbackProvider,
    fallbackModel: cfg.fallbackModel,
  };
}

function arm(state: CircuitState, seconds: number): void {
  const safeSeconds = Math.max(15, Math.min(3600, Math.floor(seconds)));
  const now = Date.now();
  state.untilMs = now + safeSeconds * 1000;
  state.lastThrottleAtMs = now;
  state.lastThrottleReason = `manual-arm:${safeSeconds}s`;
}

function remainingSeconds(state: CircuitState, now = Date.now()): number {
  if (state.untilMs <= now) {
    return 0;
  }
  return Math.ceil((state.untilMs - now) / 1000);
}

const fallbackPlugin = {
  id: "codex-openai-fallback",
  name: "Codex/OpenAI Fallback",
  register(api: OpenClawPluginApi) {
    const cfg = normalizeCfg(api.pluginConfig);
    const state: CircuitState = {
      untilMs: 0,
      lastThrottleAtMs: 0,
      lastThrottleReason: "",
      lastAppliedAtMs: 0,
      appliedCount: 0,
    };

    api.registerGatewayMethod("codex-fallback.status", ({ respond }: any) => {
      respond(true, buildStatus(cfg, state));
    });

    api.registerGatewayMethod("codex-fallback.arm", ({ params, respond }: any) => {
      const secondsRaw = params && typeof params.seconds === "number" ? params.seconds : 60;
      arm(state, secondsRaw);
      api.logger.warn(
        `codex-openai-fallback: fallback entered (source=manual-arm, until_ms=${state.untilMs}, remaining_s=${remainingSeconds(state)})`
      );
      respond(true, buildStatus(cfg, state));
    });

    api.registerGatewayMethod("codex-fallback.disarm", ({ respond }: any) => {
      const wasActive = state.untilMs > Date.now();
      state.untilMs = 0;
      if (wasActive) {
        api.logger.info("codex-openai-fallback: fallback exited (source=manual-disarm)");
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
          console.log(`fallback: ${payload.fallbackProvider}/${payload.fallbackModel}`);
        });

      root
        .command("arm")
        .description("Force fallback mode for a short test window")
        .option("--seconds <n>", "Fallback duration in seconds", "60")
        .action((opts: { seconds?: string }) => {
          const seconds = Number.parseInt(opts.seconds ?? "60", 10) || 60;
          arm(state, seconds);
          api.logger.warn(
            `codex-openai-fallback: fallback entered (source=cli-arm, until_ms=${state.untilMs}, remaining_s=${remainingSeconds(state)})`
          );
          console.log(`armed for ${Math.max(15, Math.min(3600, seconds))}s`);
        });

      root
        .command("disarm")
        .description("Disable fallback mode immediately")
        .action(() => {
          const wasActive = state.untilMs > Date.now();
          state.untilMs = 0;
          if (wasActive) {
            api.logger.info("codex-openai-fallback: fallback exited (source=cli-disarm)");
          }
          console.log("disarmed");
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
      if (state.untilMs > 0 && state.untilMs <= now) {
        api.logger.info(
          `codex-openai-fallback: fallback exited (source=cooldown-expired, last_reason=${state.lastThrottleReason || "n/a"})`
        );
        state.untilMs = 0;
      }
      if (state.untilMs <= now) {
        return;
      }

      state.appliedCount += 1;
      state.lastAppliedAtMs = now;

      api.logger.info(
        `codex-openai-fallback: fallback request routed (provider=${cfg.fallbackProvider}, model=${cfg.fallbackModel}, remaining_s=${remainingSeconds(state, now)})`
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
      if (!isRateLimitError(event.error)) {
        return;
      }

      const now = Date.now();
      const wasActive = state.untilMs > now;
      const previousUntilMs = state.untilMs;
      state.untilMs = now + cfg.cooldownMs;
      state.lastThrottleAtMs = now;
      state.lastThrottleReason = typeof event.error === "string" ? event.error : "rate-limit";
      const previousRemainingSeconds = previousUntilMs > now ? Math.ceil((previousUntilMs - now) / 1000) : 0;
      if (wasActive) {
        api.logger.warn(
          `codex-openai-fallback: fallback window refreshed (source=throttle, previous_remaining_s=${previousRemainingSeconds}, new_remaining_s=${remainingSeconds(state, now)})`
        );
      } else {
        api.logger.warn(
          `codex-openai-fallback: fallback entered (source=throttle, remaining_s=${remainingSeconds(state, now)})`
        );
      }
    });

    api.logger.info(
      `codex-openai-fallback: loaded (primary=${cfg.primaryProvider}, fallback=${cfg.fallbackProvider}/${cfg.fallbackModel}, cooldown=${Math.floor(cfg.cooldownMs / 1000)}s)`
    );
  },
};

export default fallbackPlugin;
