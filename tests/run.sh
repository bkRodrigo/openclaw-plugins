#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash -n "${SCRIPT_DIR}/../scripts/check-codex-fallback-mode.sh"
bash -n "${SCRIPT_DIR}/../scripts/deploy-openclaw-codex-fallback.sh"
bash -n "${SCRIPT_DIR}/../scripts/test-codex-openai-fallback.sh"
bash -n "${SCRIPT_DIR}/test-codex-fallback-core.sh"
bash -n "${SCRIPT_DIR}/test-codex-fallback-debug-state.sh"
bash -n "${SCRIPT_DIR}/test-codex-auth-outage-detection.sh"
bash -n "${SCRIPT_DIR}/test-codex-auth-preflight.sh"
bash -n "${SCRIPT_DIR}/test-codex-fallback-auth-autopin.sh"
bash -n "${SCRIPT_DIR}/test-codex-auth-outage-message-trigger.sh"
bash -n "${SCRIPT_DIR}/test-deploy-codex-fallback.sh"
bash -n "${SCRIPT_DIR}/test-openclaw-gateway-rpc-helper.sh"
bash -n "${SCRIPT_DIR}/test-codex-fallback-shell-scripts.sh"

"${SCRIPT_DIR}/test-codex-fallback-core.sh"
"${SCRIPT_DIR}/test-codex-fallback-debug-state.sh"
"${SCRIPT_DIR}/test-codex-auth-outage-detection.sh"
bash "${SCRIPT_DIR}/test-codex-auth-preflight.sh"
"${SCRIPT_DIR}/test-codex-fallback-auth-autopin.sh"
"${SCRIPT_DIR}/test-codex-auth-outage-message-trigger.sh"
"${SCRIPT_DIR}/test-deploy-codex-fallback.sh"
"${SCRIPT_DIR}/test-openclaw-gateway-rpc-helper.sh"
"${SCRIPT_DIR}/test-codex-fallback-shell-scripts.sh"
