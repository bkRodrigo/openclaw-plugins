#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

HELPER_LOG="${TMP_DIR}/helper.log"
export HELPER_LOG

cat > "${TMP_DIR}/gateway-helper-stub.sh" <<'EOF_HELPER'
#!/usr/bin/env bash
set -euo pipefail

method=""
params="{}"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --method)
      method="$2"
      shift 2
      ;;
    --params)
      params="$2"
      shift 2
      ;;
    --openclaw-bin|--openclaw-package-root|--timeout-ms)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

printf '%s %s\n' "$method" "$params" >> "$HELPER_LOG"
ARM_FILE="$(dirname "$HELPER_LOG")/armed.flag"
case "$method" in
  health)
    printf '{"ok":true}\n'
    ;;
  codex-fallback.status)
    if [[ -f "$ARM_FILE" ]]; then
      printf '{"enabled":true,"active":true,"fallbackRemainingMs":30000,"lastThrottleReason":"manual-arm:120s","primaryProvider":"openai-codex","fallbackProvider":"openai","fallbackModel":"gpt-5.3-codex","appliedCount":2}\n'
    else
      printf '{"enabled":true,"active":false,"fallbackRemainingMs":0,"lastThrottleReason":"none","primaryProvider":"openai-codex","fallbackProvider":"openai","fallbackModel":"gpt-5.3-codex","appliedCount":1}\n'
    fi
    ;;
  codex-fallback.arm)
    touch "$ARM_FILE"
    printf '{"enabled":true,"active":true,"fallbackRemainingMs":30000,"lastThrottleReason":"manual-arm:120s","primaryProvider":"openai-codex","fallbackProvider":"openai","fallbackModel":"gpt-5.3-codex","appliedCount":2}\n'
    ;;
  codex-fallback.disarm)
    rm -f "$ARM_FILE"
    printf '{"enabled":true,"active":false,"fallbackRemainingMs":0,"lastThrottleReason":"manual-disarm","primaryProvider":"openai-codex","fallbackProvider":"openai","fallbackModel":"gpt-5.3-codex","appliedCount":2}\n'
    ;;
  *)
    printf 'unexpected method: %s\n' "$method" >&2
    exit 1
    ;;
esac
EOF_HELPER
chmod +x "${TMP_DIR}/gateway-helper-stub.sh"

cat > "${TMP_DIR}/openclaw-stub.sh" <<'EOF_OPENCLAW'
#!/usr/bin/env bash
set -euo pipefail

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --log-level|--session-id|--message|--thinking)
      shift 2
      ;;
    --no-color|--json|off)
      shift
      ;;
    agent)
      counter_file="$(dirname "$0")/agent-count"
      count=0
      if [[ -f "$counter_file" ]]; then
        count="$(cat "$counter_file")"
      fi
      count=$((count + 1))
      printf '%s' "$count" > "$counter_file"
      if (( count == 1 )); then
        printf '{"result":{"meta":{"agentMeta":{"provider":"openai","model":"gpt-5.3-codex"}}}}\n'
      else
        printf '{"result":{"meta":{"agentMeta":{"provider":"openai-codex","model":"gpt-5.3-codex"}}}}\n'
      fi
      exit 0
      ;;
    gateway)
      printf 'gateway CLI wrapper should not be used in these scripts\n' >&2
      exit 99
      ;;
    *)
      shift
      ;;
  esac
done

printf 'unexpected openclaw stub invocation\n' >&2
exit 1
EOF_OPENCLAW
chmod +x "${TMP_DIR}/openclaw-stub.sh"

TEST_OUTPUT="$({
  OPENCLAW_PLUGIN_ENV_FILE="/tmp/openclaw-plugin-tests-no-env" \
  OPENCLAW_BIN="${TMP_DIR}/openclaw-stub.sh" \
  OPENCLAW_GATEWAY_CALL_HELPER="${TMP_DIR}/gateway-helper-stub.sh" \
  PLUGIN_HOST_USER="$(id -un)" \
  RUNTIME_USER="" \
  COMMAND_TIMEOUT_SECONDS=5 \
  "${REPO_ROOT}/scripts/test-codex-openai-fallback.sh" \
    --expect-fallback openai/gpt-5.3-codex \
    --expect-primary openai-codex/gpt-5.3-codex \
    --json
} )"

printf '%s\n' "${TEST_OUTPUT}" | jq -e '.ok == true and .fallbackTurn == "openai/gpt-5.3-codex" and .postTurn == "openai-codex/gpt-5.3-codex" and .appliedCount.before == 1 and .appliedCount.after == 2' >/dev/null

STATUS_OUTPUT="$({
  OPENCLAW_PLUGIN_ENV_FILE="/tmp/openclaw-plugin-tests-no-env" \
  OPENCLAW_BIN="${TMP_DIR}/openclaw-stub.sh" \
  OPENCLAW_GATEWAY_CALL_HELPER="${TMP_DIR}/gateway-helper-stub.sh" \
  PLUGIN_HOST_USER="$(id -un)" \
  RUNTIME_USER="" \
  COMMAND_TIMEOUT_SECONDS=5 \
  "${REPO_ROOT}/scripts/check-codex-fallback-mode.sh" --json
} )"

printf '%s\n' "${STATUS_OUTPUT}" | jq -e '.enabled == true and .active == false and .fallbackProvider == "openai" and .fallbackModel == "gpt-5.3-codex"' >/dev/null

grep -q '^health ' "${HELPER_LOG}"
grep -q '^codex-fallback.arm ' "${HELPER_LOG}"
grep -q '^codex-fallback.disarm ' "${HELPER_LOG}"
grep -q '^codex-fallback.status ' "${HELPER_LOG}"
printf 'ok\n'
