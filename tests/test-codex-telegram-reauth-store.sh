#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'EOF_NODE'
import fs from "fs";
import os from "os";
import path from "path";

import { createStateStore } from "/home/forge/plugins/codex-telegram-reauth/store.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-reauth-store-"));
const statePath = path.join(tmpDir, "state.json");
const store = createStateStore(statePath);

const initial = store.read();
assert(initial.session.status === "idle", "new store should default to idle state");

fs.writeFileSync(
  statePath,
  JSON.stringify(
    {
      version: 1,
      outageActive: true,
      outageReason: "auth-outage",
      fallbackPinned: true,
      fallbackPinReason: "auth-outage",
      fallbackPinSource: "auth-refresh",
      lastFailureReason: "external mutation",
      lastTelegramNoticeAt: 0,
      session: {
        sessionId: "",
        status: "reauth_pending",
        chatId: "",
        userId: "",
        authUrl: "",
        createdAt: 0,
        expiresAt: 0,
        callbackReceivedAt: 0,
        credentialWriteAt: 0,
        verificationAttemptAt: 0,
        verificationPassedAt: 0,
      },
    },
    null,
    2
  ) + "\n",
  "utf8"
);

const reloaded = store.read();
assert(reloaded.outageActive === true, "store should reload external file mutations");
assert(reloaded.session.status === "reauth_pending", "store should expose externally updated session state");

store.update((state) => {
  state.session.status = "reauth_in_progress";
  state.session.sessionId = "session-123";
});

const updated = JSON.parse(fs.readFileSync(statePath, "utf8"));
assert(updated.session.status === "reauth_in_progress", "update should persist modified state");
assert(updated.session.sessionId === "session-123", "update should persist modified session id");

console.log("ok");
EOF_NODE
