#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

OPENCLAW_ROOT="${TMP_DIR}/openclaw-root"
CONFIG_PATH="${TMP_DIR}/openclaw.json"
DEST_DIR="${OPENCLAW_ROOT}/extensions/codex-openai-fallback"
mkdir -p "${OPENCLAW_ROOT}/extensions"

cat > "${CONFIG_PATH}" <<'EOF'
{
  "plugins": {
    "entries": {
      "codex-openai-fallback": {
        "enabled": true
      }
    }
  }
}
EOF

OUTPUT="$(
  OPENCLAW_PLUGIN_ENV_FILE="/tmp/openclaw-plugin-tests-no-env" \
  OPENCLAW_ROOT="${OPENCLAW_ROOT}" \
  OPENCLAW_CONFIG="${CONFIG_PATH}" \
  "${REPO_ROOT}/scripts/deploy-openclaw-codex-fallback.sh" --apply
)"

printf '%s\n' "${OUTPUT}" | grep -q '^deploy=ok$'
printf '%s\n' "${OUTPUT}" | grep -q '^status=in-sync$'
printf '%s\n' "${OUTPUT}" | grep -q '^source_tree_sha256='
printf '%s\n' "${OUTPUT}" | grep -q '^dest_tree_sha256='

[[ -f "${DEST_DIR}/index.ts" ]]
[[ -f "${DEST_DIR}/openclaw.plugin.json" ]]
[[ -f "${DEST_DIR}/core.mjs" ]]
[[ -f "${DEST_DIR}/auth-outage.mjs" ]]

src_tree="$(printf '%s\n' "${OUTPUT}" | awk -F= '/^source_tree_sha256=/{print $2}')"
dst_tree="$(printf '%s\n' "${OUTPUT}" | awk -F= '/^dest_tree_sha256=/{print $2}')"
[[ -n "${src_tree}" && "${src_tree}" == "${dst_tree}" ]]

printf 'stale\n' > "${DEST_DIR}/obsolete-file.tmp"
OUTPUT_AFTER_STALE="$(
  OPENCLAW_PLUGIN_ENV_FILE="/tmp/openclaw-plugin-tests-no-env" \
  OPENCLAW_ROOT="${OPENCLAW_ROOT}" \
  OPENCLAW_CONFIG="${CONFIG_PATH}" \
  "${REPO_ROOT}/scripts/deploy-openclaw-codex-fallback.sh" --apply
)"

printf '%s\n' "${OUTPUT_AFTER_STALE}" | grep -q '^status=in-sync$'
[[ ! -e "${DEST_DIR}/obsolete-file.tmp" ]]

printf 'ok\n'
