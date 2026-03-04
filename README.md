# OpenClaw Local Plugins (forge)

Deterministic local source for custom OpenClaw plugins used on this host.

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

## Admin console action

```bash
manage-openclaw --run deploy_codex_openai_fallback_plugin
```

This action runs the same deploy script and restarts `openclaw-gateway.service`.
