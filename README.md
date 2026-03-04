# OpenClaw Plugins Repository

Deterministic source for custom OpenClaw plugins and plugin tooling.

## Repository Scope

This repository is intentionally organized as a multi-plugin home:

- plugin source directories
- reusable deployment/testing scripts
- per-plugin documentation under `docs/`

## Plugin Discovery (OpenClaw)

OpenClaw can load plugins from:

- `~/.openclaw/extensions`
- `<workspace>/.openclaw/extensions`
- paths listed in `plugins.load.paths`

You can also use:

- `openclaw plugins install --link <dir>`

## Environment Configuration (`.env`)

Scripts under `scripts/` auto-load `../.env` when present.

Start from template:

```bash
cp /home/${PLUGIN_HOST_USER}/plugins/.env.example /home/${PLUGIN_HOST_USER}/plugins/.env
```

Set host/runtime values in `.env` (for example `PLUGIN_HOST_USER`, `RUNTIME_USER`, OpenClaw paths, expected models).

## Repository Layout

- `codex-openai-fallback/` - plugin source
- `scripts/` - deployment/test scripts
- `docs/` - plugin-specific docs
- `.env.example` - portable env template for scripts

## Plugin TOC

- [Codex/OpenAI Fallback](docs/codex-openai-fallback.md)
