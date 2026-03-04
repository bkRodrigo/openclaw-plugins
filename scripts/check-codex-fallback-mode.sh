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

PLUGIN_HOST_USER="${PLUGIN_HOST_USER:-$(id -un)}"
PLUGIN_HOME="${PLUGIN_HOME:-/home/${PLUGIN_HOST_USER}}"

RUNTIME_USER="${RUNTIME_USER:-}"
RUNTIME_HOME="${RUNTIME_HOME:-}"
RUNTIME_PATH="${RUNTIME_PATH:-${PATH:-}}"
STATE_DIR="${OPENCLAW_STATE_DIR:-${PLUGIN_HOME}/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/openclaw.json}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE:-${STATE_DIR}/workspace}"

COMMAND_TIMEOUT_SECONDS="${COMMAND_TIMEOUT_SECONDS:-120}"
FALLBACK_STATUS_WATCH_SECONDS="${FALLBACK_STATUS_WATCH_SECONDS:-0}"
WATCH_SECONDS="${FALLBACK_STATUS_WATCH_SECONDS}"
JSON_OUTPUT=0

usage() {
  cat <<'USAGE'
Usage:
  check-codex-fallback-mode.sh [options]

Print current fallback mode from codex-fallback.status.

Default output:
  PRIMARY ...
  FALLBACK ...

Options:
  --runtime-user <user>     Run OpenClaw commands via sudo -u <user>
  --runtime-home <path>     HOME for runtime user (default: /home/<runtime-user>)
  --runtime-path <path>     PATH for runtime commands (default: current PATH)
  --state-dir <path>        OPENCLAW_STATE_DIR for runtime commands
  --config-path <path>      OPENCLAW_CONFIG_PATH for runtime commands
  --workspace <path>        OPENCLAW_WORKSPACE for runtime commands
  --cmd-timeout <n>         Timeout per OpenClaw command in seconds (default: 120)
  --watch <n>               Poll every <n> seconds (0 for one-shot, default: 0)
  --json                    Print raw status JSON
  --help                    Show this help

Notes:
  - If present, ../.env is sourced first (override with OPENCLAW_PLUGIN_ENV_FILE).
  - CLI flags override values loaded from .env.
USAGE
}

fail() {
  printf '[check-codex-fallback][FAIL] %s\n' "$1" >&2
  exit 1
}

extract_json() {
  local raw="$1"
  local json
  json="$(printf '%s\n' "$raw" | awk 'BEGIN{capture=0} /^[[:space:]]*[{]/ {capture=1} capture {print}')"
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

fetch_status_json() {
  local raw
  local json
  if ! raw="$(run_openclaw gateway call codex-fallback.status --params '{}' --json 2>&1)"; then
    fail "gateway call failed: $raw"
  fi
  if ! json="$(extract_json "$raw")"; then
    fail "non-JSON gateway response: $raw"
  fi
  printf '%s\n' "$json"
}

emit_human_status() {
  local json="$1"
  local active
  local remaining_ms
  local reason
  local primary
  local fallback
  local mode

  active="$(printf '%s\n' "$json" | jq -r '.active // false')"
  remaining_ms="$(printf '%s\n' "$json" | jq -r '.fallbackRemainingMs // 0')"
  reason="$(printf '%s\n' "$json" | jq -r '.lastThrottleReason // "none"')"
  primary="$(printf '%s\n' "$json" | jq -r '.primaryProvider // "unknown"')"
  fallback="$(printf '%s\n' "$json" | jq -r '.fallbackProvider // "unknown"')/$(printf '%s\n' "$json" | jq -r '.fallbackModel // "unknown"')"

  if [[ "$active" == "true" ]]; then
    mode="FALLBACK"
  else
    mode="PRIMARY"
  fi

  printf '%s active=%s remaining_s=%s reason=%s primary=%s fallback=%s\n' \
    "$mode" \
    "$active" \
    "$(( remaining_ms / 1000 ))" \
    "$reason" \
    "$primary" \
    "$fallback"
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
    --cmd-timeout)
      [[ "$#" -ge 2 ]] || fail "--cmd-timeout requires a value"
      COMMAND_TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --watch)
      [[ "$#" -ge 2 ]] || fail "--watch requires a value"
      WATCH_SECONDS="$2"
      shift 2
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

if ! [[ "$WATCH_SECONDS" =~ ^[0-9]+$ ]]; then
  fail "--watch must be a non-negative integer"
fi

while true; do
  status_json="$(fetch_status_json)"
  if [[ "$JSON_OUTPUT" -eq 1 ]]; then
    printf '%s\n' "$status_json"
  else
    emit_human_status "$status_json"
  fi

  if (( WATCH_SECONDS == 0 )); then
    break
  fi
  sleep "$WATCH_SECONDS"
done
