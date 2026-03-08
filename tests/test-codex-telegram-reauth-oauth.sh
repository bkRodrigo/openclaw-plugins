#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'EOF_NODE'
import {
  createAuthorizationStart,
  completeAuthorizationPaste,
} from "/home/forge/plugins/codex-telegram-reauth/oauth.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function base64Url(value) {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

const started = await createAuthorizationStart({
  originator: "telegram-reauth",
  createPkce: async () => ({ verifier: "verifier-1", challenge: "challenge-1" }),
  createState: () => "state-1",
});

assert(started.verifier === "verifier-1", "start should return PKCE verifier");
assert(started.state === "state-1", "start should return expected state");

const authUrl = new URL(started.url);
assert(authUrl.origin === "https://auth.openai.com", "start should use OpenAI auth origin");
assert(authUrl.pathname === "/oauth/authorize", "start should use OpenAI auth path");
assert(authUrl.searchParams.get("state") === "state-1", "auth url should embed generated state");
assert(authUrl.searchParams.get("code_challenge") === "challenge-1", "auth url should embed PKCE challenge");
assert(authUrl.searchParams.get("originator") === "telegram-reauth", "auth url should propagate originator");

const accessToken = `aaa.${base64Url({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
})}.bbb`;

const writes = [];
const completed = await completeAuthorizationPaste({
  input: "http://localhost:1455/auth/callback?code=code-1&state=state-1",
  expectedState: "state-1",
  verifier: "verifier-1",
  agentDir: "/tmp/agent",
  fetchFn: async (_url, opts) => {
    const body = opts?.body instanceof URLSearchParams ? opts.body : new URLSearchParams(String(opts?.body ?? ""));
    assert(body.get("grant_type") === "authorization_code", "completion should request auth code exchange");
    assert(body.get("code") === "code-1", "completion should send pasted auth code");
    assert(body.get("code_verifier") === "verifier-1", "completion should send stored verifier");
    return {
      ok: true,
      async json() {
        return {
          access_token: accessToken,
          refresh_token: "refresh-1",
          expires_in: 3600,
        };
      },
    };
  },
  writeCredentials: async (provider, creds, agentDir, options) => {
    writes.push({ provider, creds, agentDir, options });
    return "openai-codex:test@example.com";
  },
  now: () => 1000,
});

assert(completed.profileId === "openai-codex:test@example.com", "completion should return written profile id");
assert(completed.credentials.accountId === "acct-1", "completion should decode account id from access token");
assert(writes.length === 1, "completion should persist OAuth credentials");
assert(writes[0].provider === "openai-codex", "completion should write OpenAI Codex credentials");
assert(writes[0].options?.syncSiblingAgents === true, "completion should sync sibling agents");

let stateMismatch = false;
try {
  await completeAuthorizationPaste({
    input: "http://localhost:1455/auth/callback?code=code-2&state=wrong-state",
    expectedState: "state-1",
    verifier: "verifier-1",
    agentDir: "/tmp/agent",
    fetchFn: async () => {
      throw new Error("fetch should not run on state mismatch");
    },
    writeCredentials: async () => {
      throw new Error("write should not run on state mismatch");
    },
  });
} catch (error) {
  stateMismatch = String(error?.message ?? error).includes("State mismatch");
}

assert(stateMismatch, "completion should reject mismatched OAuth state");

console.log("ok");
EOF_NODE
