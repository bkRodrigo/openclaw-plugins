#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${OPENCLAW_PLUGIN_ENV_FILE:-${REPO_ROOT}/.env}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
PLUGIN_PREFIX="codex-fallback"

PLUGIN_HOST_USER="${PLUGIN_HOST_USER:-$(id -un)}"
PLUGIN_HOME="${PLUGIN_HOME:-/home/${PLUGIN_HOST_USER}}"

RUNTIME_USER="${RUNTIME_USER:-}"
RUNTIME_HOME="${RUNTIME_HOME:-}"
RUNTIME_PATH="${RUNTIME_PATH:-${PATH:-}}"
STATE_DIR="${OPENCLAW_STATE_DIR:-${PLUGIN_HOME}/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/openclaw.json}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE:-${STATE_DIR}/workspace}"

ARM_SECONDS="${ARM_SECONDS:-120}"
COMMAND_TIMEOUT_SECONDS="${COMMAND_TIMEOUT_SECONDS:-120}"
SKIP_POST_CHECK=0
KEEP_ARMED=0
JSON_OUTPUT=0

EXPECTED_PRIMARY="${EXPECTED_PRIMARY:-}"
EXPECTED_FALLBACK="${EXPECTED_FALLBACK:-}"

usage() {
  cat <<'USAGE'
Usage:
  test-codex-openai-fallback.sh [options]

Deterministic fallback drill:
  1) health check
  2) read plugin status
  3) arm fallback
  4) run agent turn and verify fallback provider/model
  5) disarm
  6) run post turn and verify return to primary provider/model

Options:
  --runtime-user <user>     Run OpenClaw commands via sudo -u <user>
  --runtime-home <path>     HOME for runtime user (default: /home/<runtime-user>)
  --runtime-path <path>     PATH for runtime commands (default: current PATH)
  --state-dir <path>        OPENCLAW_STATE_DIR for runtime commands
  --config-path <path>      OPENCLAW_CONFIG_PATH for runtime commands
  --workspace <path>        OPENCLAW_WORKSPACE for runtime commands
  --arm-seconds <n>         Arm duration in seconds (default: 120)
  --cmd-timeout <n>         Timeout per OpenClaw command in seconds (default: 120)
  --expect-primary <p/m>    Expected post-recovery provider/model (optional)
  --expect-fallback <p/m>   Expected fallback provider/model (optional)
  --skip-post-check         Skip post-disarm primary verification turn
  --keep-armed              Do not disarm at the end
  --json                    Emit machine-readable summary JSON
  --help                    Show this help

Notes:
  - If present, ../.env is sourced first (override with OPENCLAW_PLUGIN_ENV_FILE).
  - CLI flags override values loaded from .env.
USAGE
}

fail() {
  printf '[fallback-test][FAIL] %s\n' "$1" >&2
  exit 1
}

log() {
  printf '[fallback-test] %s\n' "$1"
}

extract_json() {
  local raw="$1"
  local json
  json="$(printf '%s\n' "$raw" | awk 'BEGIN{capture=0} /^[[:space:]]*[{[]/ {capture=1} capture {print}')"
  [[ -n "$json" ]] || return 1
  printf '%s\n' "$json" | jq -e . >/dev/null 2>&1 || return 1
  printf '%s\n' "$json"
}

build_exec_cmd() {
  local -a base_cmd
  local -a exec_cmd

  base_cmd=("$OPENCLAW_BIN" "--log-level" "error" "--no-color" "$@")

  if [[ "$COMMAND_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] && (( COMMAND_TIMEOUT_SECONDS > 0 )) && command -v timeout >/dev/null 2>&1; then
    exec_cmd=(timeout --foreground "${COMMAND_TIMEOUT_SECONDS}" "${base_cmd[@]}")
  else
    exec_cmd=("${base_cmd[@]}")
  fi

  printf '%s\n' "${exec_cmd[@]}"
}

run_openclaw() {
  local -a exec_cmd
  local -a env_args
  mapfile -t exec_cmd < <(build_exec_cmd "$@")

  if [[ -n "$RUNTIME_USER" && "$(id -un)" != "$RUNTIME_USER" ]]; then
    env_args=()
    [[ -n "$RUNTIME_HOME" ]] && env_args+=("HOME=$RUNTIME_HOME")
    [[ -n "$RUNTIME_PATH" ]] && env_args+=("PATH=$RUNTIME_PATH")
    [[ -n "$STATE_DIR" ]] && env_args+=("OPENCLAW_STATE_DIR=$STATE_DIR")
    [[ -n "$CONFIG_PATH" ]] && env_args+=("OPENCLAW_CONFIG_PATH=$CONFIG_PATH")
    [[ -n "$WORKSPACE_DIR" ]] && env_args+=("OPENCLAW_WORKSPACE=$WORKSPACE_DIR")

    if [[ "${#env_args[@]}" -gt 0 ]]; then
      sudo -n -u "$RUNTIME_USER" /usr/bin/env "${env_args[@]}" "${exec_cmd[@]}"
    else
      sudo -n -u "$RUNTIME_USER" "${exec_cmd[@]}"
    fi
    return
  fi

  env_args=()
  [[ -n "$RUNTIME_PATH" ]] && env_args+=("PATH=$RUNTIME_PATH")
  [[ -n "$STATE_DIR" ]] && env_args+=("OPENCLAW_STATE_DIR=$STATE_DIR")
  [[ -n "$CONFIG_PATH" ]] && env_args+=("OPENCLAW_CONFIG_PATH=$CONFIG_PATH")
  [[ -n "$WORKSPACE_DIR" ]] && env_args+=("OPENCLAW_WORKSPACE=$WORKSPACE_DIR")

  if [[ "${#env_args[@]}" -gt 0 ]]; then
    /usr/bin/env "${env_args[@]}" "${exec_cmd[@]}"
  else
    "${exec_cmd[@]}"
  fi
}

run_gateway_call() {
  local method="$1"
  local params="$2"
  local raw
  local json

  if ! raw="$(run_openclaw gateway call "$method" --params "$params" --json 2>&1)"; then
    fail "gateway call failed for $method: $raw"
  fi

  if ! json="$(extract_json "$raw")"; then
    fail "non-JSON response for $method: $raw"
  fi

  printf '%s\n' "$json"
}

run_agent_turn() {
  local session_id="$1"
  local message="$2"
  local raw
  local json

  if ! raw="$(run_openclaw agent --session-id "$session_id" --message "$message" --thinking off --json 2>&1)"; then
    fail "agent run failed for $session_id: $raw"
  fi

  if ! json="$(extract_json "$raw")"; then
    fail "agent returned non-JSON output for $session_id: $raw"
  fi

  printf '%s\n' "$json"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --runtime-user)
      [[ "$#" -ge 2 ]] || fail "--runtime-user requires a value"
      RUNTIME_USER="$2"
      shift 2
      ;;
    --runtime-home)
      [[ "$#" -ge 2 ]] || fail "--runtime-home requires a value"
      RUNTIME_HOME="$2"
      shift 2
      ;;
    --runtime-path)
      [[ "$#" -ge 2 ]] || fail "--runtime-path requires a value"
      RUNTIME_PATH="$2"
      shift 2
      ;;
    --state-dir)
      [[ "$#" -ge 2 ]] || fail "--state-dir requires a value"
      STATE_DIR="$2"
      shift 2
      ;;
    --config-path)
      [[ "$#" -ge 2 ]] || fail "--config-path requires a value"
      CONFIG_PATH="$2"
      shift 2
      ;;
    --workspace)
      [[ "$#" -ge 2 ]] || fail "--workspace requires a value"
      WORKSPACE_DIR="$2"
      shift 2
      ;;
    --arm-seconds)
      [[ "$#" -ge 2 ]] || fail "--arm-seconds requires a value"
      ARM_SECONDS="$2"
      shift 2
      ;;
    --cmd-timeout)
      [[ "$#" -ge 2 ]] || fail "--cmd-timeout requires a value"
      COMMAND_TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --expect-primary)
      [[ "$#" -ge 2 ]] || fail "--expect-primary requires a value"
      EXPECTED_PRIMARY="$2"
      shift 2
      ;;
    --expect-fallback)
      [[ "$#" -ge 2 ]] || fail "--expect-fallback requires a value"
      EXPECTED_FALLBACK="$2"
      shift 2
      ;;
    --skip-post-check)
      SKIP_POST_CHECK=1
      shift
      ;;
    --keep-armed)
      KEEP_ARMED=1
      shift
      ;;
    --json)
      JSON_OUTPUT=1
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      usage
      fail "unknown argument: $1"
      ;;
  esac
done

if [[ "$OPENCLAW_BIN" != /* ]]; then
  OPENCLAW_BIN_RESOLVED="$(command -v "$OPENCLAW_BIN" || true)"
  [[ -n "$OPENCLAW_BIN_RESOLVED" ]] || fail "openclaw binary not found in PATH: $OPENCLAW_BIN"
  OPENCLAW_BIN="$OPENCLAW_BIN_RESOLVED"
fi
[[ -x "$OPENCLAW_BIN" ]] || fail "openclaw binary is not executable: $OPENCLAW_BIN"
command -v jq >/dev/null 2>&1 || fail "jq is required"

if [[ -n "$RUNTIME_USER" && -z "$RUNTIME_HOME" ]]; then
  RUNTIME_HOME="/home/$RUNTIME_USER"
fi

if ! [[ "$ARM_SECONDS" =~ ^[0-9]+$ ]]; then
  fail "--arm-seconds must be an integer"
fi
if (( ARM_SECONDS < 15 || ARM_SECONDS > 3600 )); then
  fail "--arm-seconds must be between 15 and 3600"
fi

if ! [[ "$COMMAND_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  fail "--cmd-timeout must be an integer"
fi
if (( COMMAND_TIMEOUT_SECONDS < 0 )); then
  fail "--cmd-timeout must be >= 0"
fi

health_json="$(run_gateway_call "health" "{}")"
if ! printf '%s\n' "$health_json" | jq -e '.ok == true' >/dev/null; then
  fail "gateway health is not ok"
fi

status_before="$(run_gateway_call "${PLUGIN_PREFIX}.status" "{}")"
plugin_enabled="$(printf '%s\n' "$status_before" | jq -r '.enabled')"
[[ "$plugin_enabled" == "true" ]] || fail "plugin is not enabled"

primary_provider="$(printf '%s\n' "$status_before" | jq -r '.primaryProvider // empty')"
fallback_provider="$(printf '%s\n' "$status_before" | jq -r '.fallbackProvider // empty')"
fallback_model="$(printf '%s\n' "$status_before" | jq -r '.fallbackModel // empty')"
applied_before="$(printf '%s\n' "$status_before" | jq -r '.appliedCount // 0')"

[[ -n "$primary_provider" ]] || fail "primaryProvider is empty"
[[ -n "$fallback_provider" ]] || fail "fallbackProvider is empty"
[[ -n "$fallback_model" ]] || fail "fallbackModel is empty"

if [[ -n "$EXPECTED_FALLBACK" ]]; then
  if [[ "$EXPECTED_FALLBACK" != "$fallback_provider/$fallback_model" ]]; then
    fail "fallback config mismatch: expected $EXPECTED_FALLBACK got $fallback_provider/$fallback_model"
  fi
fi

run_gateway_call "${PLUGIN_PREFIX}.arm" "{\"seconds\":${ARM_SECONDS}}" >/dev/null
status_armed="$(run_gateway_call "${PLUGIN_PREFIX}.status" "{}")"
armed_active="$(printf '%s\n' "$status_armed" | jq -r '.active')"
[[ "$armed_active" == "true" ]] || fail "fallback did not arm"

sid_fallback="fallback-test-armed-$(date -u +%Y%m%dT%H%M%SZ)"
fallback_turn="$(run_agent_turn "$sid_fallback" "Reply with exactly FALLBACK_TEST_ARMED_OK")"
turn_fallback_provider="$(printf '%s\n' "$fallback_turn" | jq -r '.result.meta.agentMeta.provider // empty')"
turn_fallback_model="$(printf '%s\n' "$fallback_turn" | jq -r '.result.meta.agentMeta.model // empty')"

if [[ "$turn_fallback_provider" != "$fallback_provider" ]]; then
  fail "fallback provider not applied: expected $fallback_provider got $turn_fallback_provider"
fi
if [[ "$turn_fallback_model" != "$fallback_model" ]]; then
  fail "fallback model not applied: expected $fallback_model got $turn_fallback_model"
fi

status_after_fallback="$(run_gateway_call "${PLUGIN_PREFIX}.status" "{}")"
applied_after="$(printf '%s\n' "$status_after_fallback" | jq -r '.appliedCount // 0')"
if (( applied_after <= applied_before )); then
  fail "appliedCount did not increase (before=$applied_before after=$applied_after)"
fi

post_turn_provider=""
post_turn_model=""

if [[ "$KEEP_ARMED" -eq 0 ]]; then
  run_gateway_call "${PLUGIN_PREFIX}.disarm" "{}" >/dev/null
  disarmed_status="$(run_gateway_call "${PLUGIN_PREFIX}.status" "{}")"
  disarmed_active="$(printf '%s\n' "$disarmed_status" | jq -r '.active')"
  [[ "$disarmed_active" == "false" ]] || fail "fallback remained active after disarm"

  if [[ "$SKIP_POST_CHECK" -eq 0 ]]; then
    sid_post="fallback-test-post-$(date -u +%Y%m%dT%H%M%SZ)"
    post_turn="$(run_agent_turn "$sid_post" "Reply with exactly FALLBACK_TEST_POST_OK")"
    post_turn_provider="$(printf '%s\n' "$post_turn" | jq -r '.result.meta.agentMeta.provider // empty')"
    post_turn_model="$(printf '%s\n' "$post_turn" | jq -r '.result.meta.agentMeta.model // empty')"

    if [[ -n "$EXPECTED_PRIMARY" ]]; then
      if [[ "$post_turn_provider/$post_turn_model" != "$EXPECTED_PRIMARY" ]]; then
        fail "post-recovery model mismatch: expected $EXPECTED_PRIMARY got $post_turn_provider/$post_turn_model"
      fi
    else
      if [[ "$post_turn_provider" != "$primary_provider" ]]; then
        fail "did not return to primary provider: expected $primary_provider got $post_turn_provider"
      fi
    fi
  fi
fi

if [[ "$JSON_OUTPUT" -eq 1 ]]; then
  jq -n \
    --arg runtimeUser "${RUNTIME_USER:-$(id -un)}" \
    --arg primaryProvider "$primary_provider" \
    --arg fallbackProvider "$fallback_provider" \
    --arg fallbackModel "$fallback_model" \
    --arg fallbackTurnProvider "$turn_fallback_provider" \
    --arg fallbackTurnModel "$turn_fallback_model" \
    --arg postTurnProvider "$post_turn_provider" \
    --arg postTurnModel "$post_turn_model" \
    --argjson appliedBefore "$applied_before" \
    --argjson appliedAfter "$applied_after" \
    --argjson armSeconds "$ARM_SECONDS" \
    --argjson cmdTimeoutSeconds "$COMMAND_TIMEOUT_SECONDS" \
    '{ok:true,runtimeUser:$runtimeUser,armSeconds:$armSeconds,cmdTimeoutSeconds:$cmdTimeoutSeconds,primaryProvider:$primaryProvider,fallbackTarget:($fallbackProvider+"/"+$fallbackModel),fallbackTurn:($fallbackTurnProvider+"/"+$fallbackTurnModel),postTurn:(if ($postTurnProvider|length)>0 then ($postTurnProvider+"/"+$postTurnModel) else null end),appliedCount:{before:$appliedBefore,after:$appliedAfter}}'
  exit 0
fi

log "health=ok"
log "armed_fallback=${fallback_provider}/${fallback_model}"
log "fallback_turn_provider=${turn_fallback_provider}/${turn_fallback_model}"
log "applied_count_before=${applied_before} after=${applied_after}"
if [[ -n "$post_turn_provider" ]]; then
  log "post_turn_provider=${post_turn_provider}/${post_turn_model}"
fi
log "result=PASS"
