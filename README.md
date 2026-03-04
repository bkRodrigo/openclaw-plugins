# OpenClaw Local Plugins

Deterministic local source for custom OpenClaw plugins.

## Location Strategy

- Plugin source can live in any filesystem path.
- OpenClaw discovers plugins from:
  - `~/.openclaw/extensions`
  - `<workspace>/.openclaw/extensions`
  - paths listed in `plugins.load.paths`
- `openclaw plugins install --link <dir>` also works and writes the linked path into `plugins.load.paths`.
- Canonical source path is intended to be `/home/${PLUGIN_HOST_USER}/plugins`.

## Environment Configuration (`.env`)

Scripts in `scripts/` auto-load `../.env` when present.

- Start from template:

```bash
cp /home/${PLUGIN_HOST_USER}/plugins/.env.example /home/${PLUGIN_HOST_USER}/plugins/.env
```

- Set `PLUGIN_HOST_USER` (and related values) for your host.
- Update runtime user, OpenClaw paths, expected models, and timeout values.
- You can override the env file path with `OPENCLAW_PLUGIN_ENV_FILE=/path/to/file`.

## Layout

- `codex-openai-fallback/`
  - `index.ts`
  - `openclaw.plugin.json`
- `scripts/deploy-openclaw-codex-fallback.sh`
- `scripts/test-codex-openai-fallback.sh`
- `.env.example`

## Deploy

```bash
/home/${PLUGIN_HOST_USER}/plugins/scripts/deploy-openclaw-codex-fallback.sh --preview
/home/${PLUGIN_HOST_USER}/plugins/scripts/deploy-openclaw-codex-fallback.sh --apply --restart
```

## Deterministic Fallback Test

With `.env` configured:

```bash
/home/${PLUGIN_HOST_USER}/plugins/scripts/test-codex-openai-fallback.sh --json
```

Without `.env` (explicit args):

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

What it verifies:

- gateway health is `ok`
- plugin is enabled and exposes status/arm/disarm methods
- while armed, agent routing uses the fallback provider/model
- after disarm, routing returns to the primary provider/model
- `appliedCount` increases during fallback

## Admin Console Action

```bash
manage-openclaw --run deploy_codex_openai_fallback_plugin
```

This action runs the same deploy script and restarts `openclaw-gateway.service`.
