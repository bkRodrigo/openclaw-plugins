[Back to Main](../README.md)

# Codex/OpenAI Fallback Plugin

## Purpose

Provide a fallback path from a primary Codex provider/model to an OpenAI API provider/model during throttle windows, targeted `openai-codex` auth-refresh outages, or manual fallback windows.

## Plugin ID

- `codex-openai-fallback`

## Source

- `codex-openai-fallback/index.ts`
- `codex-openai-fallback/auth-preflight.mjs`
- `codex-openai-fallback/openclaw.plugin.json`

## Runtime Behavior

- Watches for rate-limit/throttle style failures.
- Watches for targeted `openai-codex` OAuth refresh/auth failures.
- Preflights primary `openai-codex` auth in `before_model_resolve` so first-turn Telegram auth outages can reroute before OpenClaw reaches the failing SSO refresh path.
- Activates fallback window (`cooldownSeconds`) after qualifying throttle failures.
- Pins fallback automatically for qualifying auth-refresh outages.
- Pins fallback automatically when Telegram emits the user-facing auth failure reply for the same outage class.
- Supports pinned fallback state for operator-controlled outage windows.
- Overrides provider/model while fallback window is active.
- Exposes control/status methods:
  - `codex-fallback.status`
  - `codex-fallback.arm`
  - `codex-fallback.disarm`
  - `codex-fallback.pin`
  - `codex-fallback.release`
  - `codex-fallback.debug-reset`

## Default Routing Model

- Primary provider: `openai-codex`
- Primary model prefixes: `gpt-5.3-codex`, `gpt-5.2-codex`
- Fallback provider: `openai`
- Fallback model: `gpt-5.3-codex`

## Deploy

```bash
/home/${PLUGIN_HOST_USER}/plugins/scripts/deploy-openclaw-codex-fallback.sh --preview
/home/${PLUGIN_HOST_USER}/plugins/scripts/deploy-openclaw-codex-fallback.sh --apply --restart
```

## Deterministic Test

With `.env` configured:

```bash
/home/${PLUGIN_HOST_USER}/plugins/scripts/test-codex-openai-fallback.sh --json
```

Without `.env`:

```bash
/home/${PLUGIN_HOST_USER}/plugins/scripts/test-codex-openai-fallback.sh \
  --runtime-user openclaw \
  --runtime-home /home/openclaw \
  --runtime-path /home/${PLUGIN_HOST_USER}/.nvm/current/bin:/home/${PLUGIN_HOST_USER}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin \
  --state-dir /home/${PLUGIN_HOST_USER}/.openclaw \
  --config-path /home/${PLUGIN_HOST_USER}/.openclaw/openclaw.json \
  --workspace /home/${PLUGIN_HOST_USER}/.openclaw/workspace \
  --expect-fallback openai/gpt-5.3-codex \
  --expect-primary openai-codex/gpt-5.3-codex \
  --cmd-timeout 120 \
  --json
```

The deterministic drill now uses `scripts/openclaw-gateway-rpc.mjs` for plugin control/status calls instead of `openclaw gateway call ...`, because the CLI wrapper can hang under the runtime-user path even when the lower-level gateway transport is healthy.

## Fallback Mode Status Helper

One-shot check:

```bash
/home/${PLUGIN_HOST_USER}/plugins/scripts/check-codex-fallback-mode.sh
```

Watch mode (poll every 5 seconds):

```bash
/home/${PLUGIN_HOST_USER}/plugins/scripts/check-codex-fallback-mode.sh --watch 5
```

Raw JSON:

```bash
/home/${PLUGIN_HOST_USER}/plugins/scripts/check-codex-fallback-mode.sh --json
```

Pinned and auth-outage status fields:

- `pinned`
- `pinReason`
- `pinSource`
- `authOutagePinEnabled`
- `lastAuthOutageAtMs`
- `lastAuthOutageError`
- `debug.beforeModelResolveCalls`
- `debug.agentEndCalls`
- `debug.messageSendingCalls`
- `debug.lastHookName`
- `debug.lastHookAtMs`
- `debug.lastContentPrefix`
- `debug.lastChannelId`
- `debug.lastError`

Pinned fallback remains active even after a timed cooldown expires and must be released explicitly.

Use `codex-fallback.debug-reset` before a live drill if you want a clean hook counter snapshot for the next test.

## Script Configuration

All script defaults are configurable via `.env` (template: `.env.example`), including:

- host user/home (`PLUGIN_HOST_USER`, `PLUGIN_HOME`)
- OpenClaw binary/package root (`OPENCLAW_BIN`, `OPENCLAW_PACKAGE_ROOT`)
- runtime user/home/path (`RUNTIME_USER`, `RUNTIME_HOME`, `RUNTIME_PATH`)
- OpenClaw paths (`OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_WORKSPACE`)
- deployment target paths (`OPENCLAW_ROOT`, `OPENCLAW_CONFIG`)
- test/status controls (`ARM_SECONDS`, `COMMAND_TIMEOUT_SECONDS`, `EXPECTED_FALLBACK`, `EXPECTED_PRIMARY`, `FALLBACK_STATUS_WATCH_SECONDS`)

## Local Regression Tests

```bash
/home/${PLUGIN_HOST_USER}/plugins/tests/run.sh
```

Coverage includes:

- core fallback state semantics for cooldown vs pin behavior
- auth-outage detection and auto-pin behavior for targeted `openai-codex` refresh failures
- Telegram user-facing auth failure reply detection as a second trigger for auto-pin
- lower-level gateway RPC helper resolution and invocation
- deterministic drill/status helpers using the gateway helper instead of `openclaw gateway call`
- explicit regression guard that fails if the shell scripts fall back to the broken CLI wrapper path

## Observability Markers

Plugin logs include explicit fallback transition markers:

- fallback entered (`source=manual-arm`, `source=cli-arm`, or `source=throttle`)
- fallback pinned (`source=<pin-source>`)
- auth outage detected and fallback pinned (`source=auth-refresh`, `reason=auth-outage`)
- auth outage reply observed and fallback pinned on Telegram delivery path
- fallback window refreshed (`source=throttle`)
- fallback request routed (provider/model + remaining seconds)
- fallback exited (`source=manual-disarm`, `source=cli-disarm`, `source=cooldown-expired`)
- fallback pin released
