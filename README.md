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

## Layout

- `codex-openai-fallback/`
  - `index.ts`
  - `openclaw.plugin.json`
- `scripts/deploy-openclaw-codex-fallback.sh`

## Deploy

```bash
/home/forge/plugins/scripts/deploy-openclaw-codex-fallback.sh --preview
/home/forge/plugins/scripts/deploy-openclaw-codex-fallback.sh --apply --restart
```

## Admin Console Action

```bash
manage-openclaw --run deploy_codex_openai_fallback_plugin
```

This action runs the same deploy script and restarts `openclaw-gateway.service`.
