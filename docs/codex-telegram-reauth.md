[Back to Main](../README.md)

# Codex Telegram Reauth

## Purpose

Provide an operator recovery path for `openai-codex` SSO outages from the main Telegram chat while keeping API fallback active until primary SSO is verified healthy again.

## Goals

- Detect `openai-codex` auth-refresh outages automatically.
- Keep the main agent usable by pinning API fallback during the outage.
- Open a deterministic Telegram recovery flow without relying on LLM reasoning.
- Let the operator complete the browser-based SSO login from a URL delivered in Telegram.
- Verify primary `openai-codex` works before releasing fallback.
- Notify the operator in Telegram when recovery succeeds or when reauth completes but primary is still broken.

## Current Status

Completed in `codex-openai-fallback`:

- pinned fallback state and explicit gateway controls
  - `codex-fallback.pin`
  - `codex-fallback.release`
- auth-outage detection for `openai-codex`
- debug/status telemetry for live drills
- preflight auth probing in `before_model_resolve`
- live Telegram validation that SSO outage now falls back to `openai/gpt-5.3-codex`

Completed in `codex-telegram-reauth`:

- plugin scaffold and persisted session state are in place
- deterministic gateway control surface exists for status, outage start, session start, and session cancel
- deterministic Telegram operator workflow exists:
  - `/reauth_status`
  - `/reauth`
  - `/reauth_cancel`
  - `/reauth_paste <redirect-url>`
- real OpenAI Codex OAuth URL issuance is implemented
- redirect pasteback completion is implemented
- refreshed OAuth credentials are written back to the OpenClaw auth profile store
- primary verification runs in-process via `pi-ai complete()` against `openai-codex`
- fallback is released only after primary verification passes

Still to build in `codex-telegram-reauth`:

- automatic Telegram outage notification when fallback enters auth-outage mode
- browser callback endpoint as an alternative to redirect pasteback
- broader recovery UX polish and failure telemetry

## Validated Operator Flow

Validated live on this host:

1. `openai-codex` SSO refresh fails on the main Telegram agent.
2. `codex-openai-fallback` pins fallback and the main agent continues replying through `openai/gpt-5.3-codex`.
3. Operator runs `/reauth` in the same Telegram chat.
4. Plugin returns a real OpenAI authorization URL.
5. Operator completes browser login and sends `/reauth_paste <redirect-url>`.
6. Plugin stores refreshed OAuth credentials in the `openai-codex` auth profile.
7. Plugin verifies primary in-process with a deterministic prompt expecting `PRIMARY_REAUTH_OK`.
8. On verification success, fallback is released and subsequent Telegram turns return to `openai-codex/gpt-5.3-codex`.

Expected steady-state after successful recovery:

- `/reauth_status` reports `Outage active: no`
- `/reauth_status` reports `Fallback pinned: no`
- latest Telegram session entries show `provider=openai-codex` and `model=gpt-5.3-codex`

## Non-Goals

- Do not replace the existing `codex-openai-fallback` plugin.
- Do not run recovery through the normal model response path.
- Do not expose raw OAuth credentials or token-bearing redirect material in chat logs.
- Do not release fallback just because OAuth callback or redirect pasteback completed.

## Repository Layout

Expected plugin source:

- `codex-telegram-reauth/index.ts`
- `codex-telegram-reauth/openclaw.plugin.json`

Current documentation and tests:

- `docs/codex-telegram-reauth.md`
- `tests/test-codex-telegram-reauth-state.sh`
- `tests/test-codex-telegram-reauth-store.sh`
- `tests/test-codex-telegram-reauth-commands.sh`
- `tests/test-codex-telegram-reauth-oauth.sh`
- `tests/test-codex-telegram-reauth-paste-command.sh`

Current helper modules:

- `codex-telegram-reauth/state.mjs`
- `codex-telegram-reauth/store.mjs`
- `codex-telegram-reauth/commands.mjs`
- `codex-telegram-reauth/oauth.mjs`
- `codex-telegram-reauth/runtime.mjs`

## Architecture

Two-plugin model:

- `codex-openai-fallback`
  - owns provider/model routing
  - owns auth-outage detection for live traffic
  - must expose deterministic pin/release controls and observable status
- `codex-telegram-reauth`
  - owns Telegram operator workflow
  - owns reauth session lifecycle
  - owns primary verification and fallback release decision

The recovery path must bypass the normal LLM chat path. If `openai-codex` auth is broken, the operator still needs a reliable deterministic control surface in the same Telegram chat.

Reality check from live testing:

- `before_model_resolve` is the last reliable plugin hook before the broken `openai-codex` OAuth refresh path executes
- `agent_end` is not reliable as the first/only outage trigger for Telegram first-turn failures
- `message_sending` is useful for observation only when a user-facing failure message is actually emitted

Design consequence:

- outage detection must remain in `codex-openai-fallback`
- `codex-telegram-reauth` should consume fallback outage state instead of trying to rediscover the outage independently

Verification implementation detail:

- the verifier runs in-process through `@mariozechner/pi-ai`
- it uses `complete()` with the verification prompt in `context.systemPrompt`
- a plain user-message-only call is not sufficient for this Codex provider path and can return `Instructions are required`

## Fallback Coordination Contract

The reauth plugin depends on explicit fallback controls in `codex-openai-fallback`.

Required fallback methods:

- `codex-fallback.status`
- `codex-fallback.arm`
- `codex-fallback.disarm`

Additional controls required for this design:

- `codex-fallback.pin`
- `codex-fallback.release`

Fallback status should eventually include:

- `pinned`
- `pinReason`
- `pinSource`

Fallback status already includes:

- `pinned`
- `pinReason`
- `pinSource`
- `lastAuthOutageAtMs`
- `lastAuthOutageError`
- debug counters and last-hook snapshots

Recommended coordination rule for the reauth plugin:

- treat `pinReason=auth-outage` as the canonical outage signal
- do not implement a separate competing outage detector unless a new hook/path forces it

Behavioral rule:

- fallback remains active if cooldown is active or pin state is active
- cooldown expiry must not release a pin
- reauth plugin releases only the auth-outage pin it owns

## State Machine

Global states:

- `healthy`
- `auth_outage`
- `reauth_pending`
- `reauth_in_progress`
- `primary_verifying`
- `recovered`
- `reauth_failed`

State semantics:

- `healthy`
  - primary SSO path is the expected route
  - no recovery session exists
- `auth_outage`
  - `openai-codex` auth failure detected
  - fallback pinned on
- `reauth_pending`
  - outage announced in Telegram
  - waiting for operator to begin or continue reauth
- `reauth_in_progress`
  - auth URL issued
  - waiting for callback or redirect pasteback
- `primary_verifying`
  - credentials updated
  - fallback still pinned
  - deterministic primary test in progress
- `recovered`
  - primary verified healthy
  - fallback released
- `reauth_failed`
  - reauth completed or was attempted
  - primary verification failed or credential write failed
  - fallback remains pinned

## Persistent Session State

Persist under:

- `/home/forge/.openclaw/state/plugins/codex-telegram-reauth/state.json`

Suggested fields:

- `outageActive`
- `outageReason`
- `fallbackPinned`
- `sessionId`
- `sessionStatus`
- `chatId`
- `userId`
- `authUrl`
- `verifier`
- `expectedState`
- `profileId`
- `createdAt`
- `expiresAt`
- `callbackReceivedAt`
- `credentialWriteAt`
- `verificationAttemptAt`
- `verificationPassedAt`
- `lastTelegramNoticeAt`
- `lastFailureReason`

Successful recovery should end with:

- `outageActive=false`
- `fallbackPinned=false`
- `session.status=recovered`
- `session.verificationPassedAt` populated

## Trigger Conditions

Canonical trigger source for the reauth plugin:

- `codex-openai-fallback` status/state indicating an auth outage pin

Canonical outage indicators:

- `pinned=true`
- `pinReason=auth-outage`
- `pinSource=auth-refresh`

The fallback plugin already classifies targeted `openai-codex` auth failures such as:

- `OAuth token refresh failed for openai-codex`
- `refresh_token_reused`
- `Please try again or re-authenticate`
- `401` in codex auth-refresh context

Do not trigger Telegram reauth flow on:

- generic tool failures
- user prompt/content failures
- unrelated provider failures
- rate-limit failures already handled by cooldown fallback

On first observed auth-outage pin:

1. mark outage active in reauth plugin state
2. keep fallback pinned
3. send one operator notification in Telegram
4. create or reopen recovery session

## Telegram UX

This flow belongs in the main Telegram chat, but it must be deterministic plugin-owned behavior, not LLM-owned behavior.

Automatic outage notice:

- `OpenAI Codex SSO is unavailable.`
- `API fallback is now active.`
- `Re-auth is required to restore primary.`
- `Reply /reauth to continue.`

Supported commands:

- `/reauth`
- `/reauth_status`
- `/reauth_cancel`
- `/reauth_paste <redirect-url>`
- `/fallback_status`

Current live command contract:

- `/reauth_status`
  - returns outage state, fallback state, session status, session id, and last failure reason
- `/reauth`
  - starts a reauth session and returns a real OpenAI auth URL
- `/reauth_paste <redirect-url>`
  - completes the OAuth flow using the redirect URL from the browser redirect
- `/reauth_cancel`
  - cancels the active session and leaves fallback pinned if the outage is still active

Reauth start response:

- reauth session started
- browser URL
- expiry time
- short instructions

Progress responses:

- waiting for browser completion
- callback received
- verifying primary

Success response:

- `OpenAI Codex SSO restored.`
- `Primary verification passed.`
- `API fallback released.`

Failure response:

- `OpenAI Codex SSO re-auth completed, but primary verification failed.`
- `API fallback remains active.`
- sanitized reason
- `Retry with /reauth.`

Current implementation note:

- `/reauth_paste` is the live completion path today
- automatic callback completion is still pending

## OAuth Flow

Practical flow:

1. plugin generates auth URL
2. plugin sends URL to Telegram
3. operator opens URL in a browser
4. operator completes login
5. completion happens via:
   - current live path: redirect URL pasted back through Telegram
   - future path: callback received automatically
6. plugin persists refreshed credentials
7. plugin performs a deterministic primary model call using the stored `openai-codex` OAuth access token
8. fallback is released only if that model call returns the expected exact text

OpenClaw already has browser-based `openai-codex` OAuth behavior in runtime code. This plugin should reuse that behavior rather than inventing a new auth flow.

## Callback And Pasteback

Preferred completion:

- plugin registers callback handler and finishes the OAuth flow automatically

Fallback completion:

- operator sends `/reauth_paste <redirect-url>`
- plugin parses the redirect URL locally
- plugin completes the flow

Security rule:

- no raw redirect query material should be echoed back into chat after parsing

## Primary Verification

Verification must be deterministic and non-destructive.

Recommended check:

- run a tiny `openai-codex` primary turn
- expect an exact output such as `PRIMARY_REAUTH_OK`

Current implementation:

- verification prompt is configured via `verificationPrompt`
- the exact expected reply is configured via `verificationExpectedText`
- the verifier uses the stored `openai-codex` OAuth credential directly instead of shelling out through the OpenClaw CLI

Verification contract:

- success means primary path is actually usable again
- failure means fallback remains pinned

Behavioral rule:

- fallback is never released before a successful primary verification turn

If verification fails:

- keep fallback active
- keep outage session open or recoverable
- send explicit Telegram warning

## Security Model

Restrict access by:

- Telegram chat IDs
- Telegram user IDs

Operational safeguards:

- one active reauth session at a time
- expiring one-time reauth sessions
- no raw OAuth token logging
- sanitize provider errors before sending to Telegram
- rate-limit repeated outage alerts during the same incident

## Configuration

Expected config values:

- `enabled`
- `telegramChatIds`
- `telegramUserIds`
- `sessionTtlSeconds`
- `alertCooldownSeconds`
- `autoStartReauth`
- `allowPasteRedirect`
- `provider`
- `primaryModelRef`
- `fallbackPluginId`
- `verificationPrompt`
- `verificationExpectedText`

Likely `.env.example` additions once implemented:

- `CODEX_REAUTH_ENABLED=true`
- `CODEX_REAUTH_ALLOWED_CHAT_IDS=...`
- `CODEX_REAUTH_ALLOWED_USER_IDS=...`
- `CODEX_REAUTH_SESSION_TTL_SECONDS=900`
- `CODEX_REAUTH_ALERT_COOLDOWN_SECONDS=300`
- `CODEX_REAUTH_ALLOW_PASTEBACK=true`
- `CODEX_REAUTH_PRIMARY_PROVIDER=openai-codex`
- `CODEX_REAUTH_PRIMARY_MODEL=openai-codex/gpt-5.3-codex`

## Failure Modes

Must handle:

- Telegram notification failure
- repeated auth failures during same outage
- operator starts reauth while a session is already active
- session expiry
- invalid pasted redirect URL
- callback received but credential write fails
- credential write succeeds but primary verification fails
- fallback plugin unavailable

Operator-visible distinctions should be preserved:

- reauth not completed
- reauth completed but credential write failed
- reauth completed but primary verification failed

## Tests

Required tests:

- fallback pin/release contract behaves correctly
- preflight auth probing identifies `openai-codex` auth-refresh outages before the normal run path fails
- Telegram first-turn outage routes through fallback after preflight auth detection
- duplicate outage does not spam
- outage notice emitted once
- `/reauth` creates session and emits URL
- unauthorized Telegram user/chat is rejected
- callback or pasteback completion advances state
- verification success releases fallback
- verification failure keeps fallback pinned and notifies Telegram
- redirect/token material is redacted from logs and chat output

End-to-end host validation should cover:

1. break `openai-codex` auth
2. verify main Telegram agent still replies through fallback
3. observe Telegram outage notice from reauth plugin
4. complete reauth
5. verify primary success
6. verify fallback release

## Delivery Plan

Recommended delivery order:

Completed:

1. extend `codex-openai-fallback` with pinned fallback state and gateway controls
2. add tests for pinned fallback semantics
3. add auth-outage detection plus Telegram-path preflight routing in `codex-openai-fallback`
4. add live debug telemetry and regression coverage
5. validate live Telegram fallback under real `openai-codex` SSO outage

Remaining:

6. scaffold `codex-telegram-reauth`
7. implement persisted reauth session state and deterministic gateway control surface
8. implement Telegram notice/control commands
9. implement OAuth helper start/completion
10. implement callback or pasteback completion
11. implement deterministic primary verification
12. implement fallback release only on verified success
13. add docs and live validation for the reauth workflow

Now completed:

6. scaffold `codex-telegram-reauth`
7. implement persisted reauth session state and deterministic gateway control surface
8. implement Telegram control commands
9. implement OAuth helper start/completion
10. implement redirect pasteback completion
11. implement deterministic primary verification
12. implement fallback release only on verified success
13. add docs and live validation for the reauth workflow

Still remaining:

14. automatic Telegram outage notification when auth-outage fallback is pinned
15. optional browser callback endpoint to avoid redirect pasteback
16. additional recovery UX and telemetry polish

## MVP Decision

Recommended MVP:

- outage detection
- fallback pin
- Telegram notification
- `/reauth`
- browser URL issuance
- redirect pasteback
- primary verification
- fallback release on verified success

Callback auto-completion can be added after the MVP if pasteback is sufficient.
