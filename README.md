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

Set host/runtime values in `.env` (for example `PLUGIN_HOST_USER`, `RUNTIME_USER`, `OPENCLAW_BIN`, `OPENCLAW_PACKAGE_ROOT`, OpenClaw paths, expected models).

## Repository Layout

- `codex-openai-fallback/` - plugin source
- `scripts/` - deployment/test/status scripts
- `tests/` - local regression coverage for plugin tooling
- `docs/` - plugin-specific docs
- `.env.example` - portable env template for scripts

## CI

- GitHub Actions workflow `.github/workflows/shell-syntax.yml` runs `bash -n` for all `scripts/*.sh` on push and PR.
- Local regression runner: `/home/${PLUGIN_HOST_USER}/plugins/tests/run.sh`

## Plugin TOC

- [Codex/OpenAI Fallback](docs/codex-openai-fallback.md)
- [Codex Telegram Reauth](docs/codex-telegram-reauth.md)
