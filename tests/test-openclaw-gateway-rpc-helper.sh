#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

PKG_ROOT="${TMP_DIR}/openclaw"
mkdir -p "${PKG_ROOT}/dist"
cat > "${PKG_ROOT}/package.json" <<'JSON'
{"name":"openclaw","version":"test","type":"module"}
JSON
cat > "${PKG_ROOT}/openclaw.mjs" <<'EOF_OPENCLAW'
#!/usr/bin/env node
console.log('stub openclaw entry')
EOF_OPENCLAW
chmod +x "${PKG_ROOT}/openclaw.mjs"
cat > "${PKG_ROOT}/dist/call-test.js" <<'EOF_JS'
export async function n(opts) {
  return {
    ok: true,
    method: opts.method,
    params: opts.params,
    timeoutMs: opts.timeoutMs,
    clientName: opts.clientName,
    mode: opts.mode,
  };
}
EOF_JS

OUTPUT_EXPLICIT="$(${REPO_ROOT}/scripts/openclaw-gateway-rpc.mjs \
  --openclaw-package-root "${PKG_ROOT}" \
  --openclaw-bin /bin/true \
  --method codex-fallback.status \
  --params '{"seconds":30}' \
  --timeout-ms 1234)"

printf '%s\n' "${OUTPUT_EXPLICIT}" | jq -e '.ok == true and .method == "codex-fallback.status" and .params.seconds == 30 and .timeoutMs == 1234 and .clientName == "cli" and .mode == "cli"' >/dev/null

BIN_DIR="${TMP_DIR}/bin"
mkdir -p "${BIN_DIR}"
ln -s "${PKG_ROOT}/openclaw.mjs" "${BIN_DIR}/openclaw"
PATH="${BIN_DIR}:${PATH}" OUTPUT_DERIVED="$(${REPO_ROOT}/scripts/openclaw-gateway-rpc.mjs \
  --openclaw-bin openclaw \
  --method health \
  --params '{}' \
  --timeout-ms 987)"

printf '%s\n' "${OUTPUT_DERIVED}" | jq -e '.ok == true and .method == "health" and .timeoutMs == 987' >/dev/null
printf 'ok\n'
