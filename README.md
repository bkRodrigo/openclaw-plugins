# OpenClaw Local Plugins (forge)

Deterministic local source for custom OpenClaw plugins used on this host.

## Location Strategy

- Plugin source can live in any filesystem path.
- OpenClaw discovers plugins from:
  - `~/.openclaw/extensions`
  - `<workspace>/.openclaw/extensions`
  - paths listed in `plugins.load.paths`
- `openclaw plugins install --link <dir>` also works and writes the linked path into `plugins.load.paths`.
- For this host, canonical source is fixed at `/home/forge/plugins` so plugin recovery after upgrades is deterministic.

## Environment Configuration (`.env`)

Scripts in `scripts/` auto-load `../.env` when present.

- Start from template:

```bash
cp /home/forge/plugins/.env.example /home/forge/plugins/.env
```

- Update values for your environment (runtime user, OpenClaw paths, expected models, timeout).
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
/home/forge/plugins/scripts/deploy-openclaw-codex-fallback.sh --preview
/home/forge/plugins/scripts/deploy-openclaw-codex-fallback.sh --apply --restart
```

## Deterministic Fallback Test

With `.env` configured:

```bash
/home/forge/plugins/scripts/test-codex-openai-fallback.sh --json
```

Without `.env` (explicit args):

```bash
/home/forge/plugins/scripts/test-codex-openai-fallback.sh \
  --runtime-user openclaw \
  --runtime-home /home/openclaw \
  --runtime-path /home/forge/.nvm/current/bin:/home/forge/.npm-global/bin:/usr/local/bin:/usr/bin:/bin \
  --state-dir /home/forge/.openclaw \
  --config-path /home/forge/.openclaw/openclaw.json \
  --workspace /home/forge/.openclaw/workspace \
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
