#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'EOF_NODE'
import {
  verifyPrimaryWithStoredCredential,
} from "/home/forge/plugins/codex-telegram-reauth/runtime.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

let modelRequest = null;
const ok = await verifyPrimaryWithStoredCredential({
  agentDir: "/tmp/agent",
  provider: "openai-codex",
  modelRef: "openai-codex/gpt-5.3-codex",
  prompt: "Reply with PRIMARY_REAUTH_OK and nothing else.",
  expectedText: "PRIMARY_REAUTH_OK",
  loadCredential: async () => ({
    profileId: "openai-codex:default",
    credential: {
      type: "oauth",
      provider: "openai-codex",
      access: "jwt-token",
    },
  }),
  getModelFn: (provider, modelId) => ({ provider, id: modelId }),
  completeFn: async (model, context, options) => {
    modelRequest = { model, context, options };
    return {
      content: [{ type: "text", text: "PRIMARY_REAUTH_OK" }],
    };
  },
});

assert(ok.ok === true, "verification should succeed on expected exact response");
assert(ok.profileId === "openai-codex:default", "verification should report verified profile id");
assert(modelRequest.model.provider === "openai-codex", "verification should target openai-codex provider");
assert(modelRequest.model.id === "gpt-5.3-codex", "verification should use primary model id");
assert(modelRequest.options.apiKey === "jwt-token", "verification should use stored OAuth access token as api key");
assert(modelRequest.context.systemPrompt === "Reply with PRIMARY_REAUTH_OK and nothing else.", "verification should send configured system prompt");
assert(modelRequest.context.messages[0].content === "Do it now.", "verification should send deterministic user nudge");

const mismatch = await verifyPrimaryWithStoredCredential({
  agentDir: "/tmp/agent",
  provider: "openai-codex",
  modelRef: "openai-codex/gpt-5.3-codex",
  prompt: "Reply with PRIMARY_REAUTH_OK and nothing else.",
  expectedText: "PRIMARY_REAUTH_OK",
  loadCredential: async () => ({
    profileId: "openai-codex:default",
    credential: {
      type: "oauth",
      provider: "openai-codex",
      access: "jwt-token",
    },
  }),
  getModelFn: (_provider, modelId) => ({ provider: "openai-codex", id: modelId }),
  completeFn: async () => ({
    content: [{ type: "text", text: "WRONG" }],
  }),
});

assert(mismatch.ok === false, "verification should fail on mismatched text");
assert(mismatch.reason.includes("Unexpected primary verification response"), "verification should report clean mismatch reason");

console.log("ok");
EOF_NODE
