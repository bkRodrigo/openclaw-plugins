[Back to Main](../README.md)

# Codex/OpenAI Fallback Plugin

## Purpose

Provide a fallback path from a primary Codex provider/model to an OpenAI API provider/model during throttle or manual fallback windows.

## Plugin ID

- `codex-openai-fallback`

## Source

- `codex-openai-fallback/index.ts`
- `codex-openai-fallback/openclaw.plugin.json`

## Runtime Behavior

- Watches for rate-limit/throttle style failures.
- Activates fallback window (`cooldownSeconds`) after qualifying failures.
- Overrides provider/model while fallback window is active.
- Exposes control/status methods:
  - `codex-fallback.status`
  - `codex-fallback.arm`
  - `codex-fallback.disarm`

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

## Script Configuration

All script defaults are configurable via `.env` (template: `.env.example`), including:

- host user/home (`PLUGIN_HOST_USER`, `PLUGIN_HOME`)
- runtime user/home/path (`RUNTIME_USER`, `RUNTIME_HOME`, `RUNTIME_PATH`)
- OpenClaw paths (`OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_WORKSPACE`)
- deployment target paths (`OPENCLAW_ROOT`, `OPENCLAW_CONFIG`)
- test controls (`ARM_SECONDS`, `COMMAND_TIMEOUT_SECONDS`, `EXPECTED_FALLBACK`, `EXPECTED_PRIMARY`)
