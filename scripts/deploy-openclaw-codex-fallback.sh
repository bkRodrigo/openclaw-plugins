#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="codex-openai-fallback"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${OPENCLAW_PLUGIN_ENV_FILE:-${REPO_ROOT}/.env}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

PLUGIN_HOST_USER="${PLUGIN_HOST_USER:-$(id -un)}"
PLUGIN_HOME="${PLUGIN_HOME:-/home/${PLUGIN_HOST_USER}}"

SRC_DIR="${REPO_ROOT}/${PLUGIN_ID}"
SRC_INDEX="${SRC_DIR}/index.ts"
SRC_MANIFEST="${SRC_DIR}/openclaw.plugin.json"

OPENCLAW_BIN_DEFAULT="$(command -v openclaw || true)"
OPENCLAW_ROOT_DEFAULT=""
if [[ -n "${OPENCLAW_BIN_DEFAULT}" ]]; then
  OPENCLAW_ROOT_DEFAULT="$(cd "$(dirname "${OPENCLAW_BIN_DEFAULT}")/../lib/node_modules/openclaw" && pwd)"
fi
OPENCLAW_ROOT="${OPENCLAW_ROOT:-${OPENCLAW_ROOT_DEFAULT}}"
DEST_DIR="${OPENCLAW_ROOT}/extensions/${PLUGIN_ID}"
DEST_INDEX="${DEST_DIR}/index.ts"
DEST_MANIFEST="${DEST_DIR}/openclaw.plugin.json"

# Read-only signal so operators can catch missing config while avoiding ACL churn.
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-${PLUGIN_HOME}/.openclaw/openclaw.json}"

DO_PREVIEW=0
DO_APPLY=0
DO_RESTART=0

usage() {
  cat <<USAGE
Usage:
  ${0} --preview
  ${0} --apply [--restart]

Options:
  --preview   Show source/destination state and checksums.
  --apply     Copy plugin files into installed OpenClaw extensions path.
  --restart   Restart openclaw-gateway.service after apply.

Notes:
  - If present, ${REPO_ROOT}/.env is sourced first (override with OPENCLAW_PLUGIN_ENV_FILE).
USAGE
}

fail() {
  printf '[deploy-codex-fallback][FAIL] %s\n' "$1" >&2
  exit 1
}

hash_file() {
  local f="$1"
  if [[ -f "$f" ]]; then
    sha256sum "$f" | awk '{print $1}'
  else
    printf 'MISSING\n'
  fi
}

config_enabled_state() {
  if [[ ! -f "${OPENCLAW_CONFIG}" ]]; then
    printf 'config_file_missing\n'
    return
  fi
  if ! command -v jq >/dev/null 2>&1; then
    printf 'jq_missing\n'
    return
  fi

  local enabled
  enabled="$(jq -r --arg id "${PLUGIN_ID}" '.plugins.entries[$id].enabled // "unset"' "${OPENCLAW_CONFIG}" 2>/dev/null || printf 'parse_error')"
  printf '%s\n' "${enabled}"
}

print_state() {
  local src_index_hash
  local src_manifest_hash
  local dst_index_hash
  local dst_manifest_hash
  local cfg_state

  src_index_hash="$(hash_file "${SRC_INDEX}")"
  src_manifest_hash="$(hash_file "${SRC_MANIFEST}")"
  dst_index_hash="$(hash_file "${DEST_INDEX}")"
  dst_manifest_hash="$(hash_file "${DEST_MANIFEST}")"
  cfg_state="$(config_enabled_state)"

  printf 'plugin_id=%s\n' "${PLUGIN_ID}"
  printf 'source=%s\n' "${SRC_DIR}"
  printf 'destination=%s\n' "${DEST_DIR}"
  printf 'source_index_sha256=%s\n' "${src_index_hash}"
  printf 'dest_index_sha256=%s\n' "${dst_index_hash}"
  printf 'source_manifest_sha256=%s\n' "${src_manifest_hash}"
  printf 'dest_manifest_sha256=%s\n' "${dst_manifest_hash}"
  printf 'config_enabled=%s\n' "${cfg_state}"

  if [[ "${src_index_hash}" == "${dst_index_hash}" && "${src_manifest_hash}" == "${dst_manifest_hash}" ]]; then
    printf 'status=in-sync\n'
  else
    printf 'status=drift-or-missing\n'
  fi

  if [[ "${cfg_state}" != "true" ]]; then
    printf 'warning=plugin_not_enabled_in_config\n'
  fi
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --help)
      usage
      exit 0
      ;;
    --preview)
      DO_PREVIEW=1
      shift
      ;;
    --apply)
      DO_APPLY=1
      shift
      ;;
    --restart)
      DO_RESTART=1
      shift
      ;;
    *)
      usage
      fail "unknown argument: $1"
      ;;
  esac
done

if [[ "${DO_PREVIEW}" -eq 0 && "${DO_APPLY}" -eq 0 ]]; then
  usage
  fail "choose --preview or --apply"
fi

[[ -f "${SRC_INDEX}" ]] || fail "source file not found: ${SRC_INDEX}"
[[ -f "${SRC_MANIFEST}" ]] || fail "source file not found: ${SRC_MANIFEST}"
[[ -n "${OPENCLAW_ROOT}" ]] || fail "could not resolve OpenClaw install root from openclaw binary"
[[ -d "${OPENCLAW_ROOT}" ]] || fail "OpenClaw install root not found: ${OPENCLAW_ROOT}"

if [[ "${DO_PREVIEW}" -eq 1 ]]; then
  print_state
  if [[ "${DO_APPLY}" -eq 0 ]]; then
    exit 0
  fi
fi

mkdir -p "${DEST_DIR}"
install -m 0644 "${SRC_INDEX}" "${DEST_INDEX}"
install -m 0644 "${SRC_MANIFEST}" "${DEST_MANIFEST}"

print_state

if [[ "${DO_RESTART}" -eq 1 ]]; then
  uid="$(id -u)"
  export XDG_RUNTIME_DIR="/run/user/${uid}"
  systemctl --user restart openclaw-gateway.service
  printf 'gateway_restart=ok\n'
fi

printf 'deploy=ok\n'
