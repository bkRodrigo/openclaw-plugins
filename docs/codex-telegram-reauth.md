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

## Non-Goals

- Do not replace the existing `codex-openai-fallback` plugin.
- Do not run recovery through the normal model response path.
- Do not expose raw OAuth credentials or token-bearing redirect material in chat logs.
- Do not release fallback just because OAuth callback or redirect pasteback completed.

## Repository Layout

Expected plugin source:

- `codex-telegram-reauth/index.ts`
- `codex-telegram-reauth/openclaw.plugin.json`

Expected documentation and tests:

- `docs/codex-telegram-reauth.md`
- `tests/test-codex-telegram-reauth-state.sh`
- `tests/test-codex-telegram-reauth-oauth-detection.sh`
- `tests/test-codex-telegram-reauth-recovery-flow.sh`

Likely helper modules if the implementation grows:

- `codex-telegram-reauth/state.ts`
- `codex-telegram-reauth/oauth.ts`
- `codex-telegram-reauth/telegram.ts`
- `scripts/openclaw-codex-oauth-helper.mjs`

## Architecture

Two-plugin model:

- `codex-openai-fallback`
  - owns provider/model routing
  - must expose deterministic pin/release controls
- `codex-telegram-reauth`
  - owns outage detection
  - owns Telegram operator workflow
  - owns reauth session lifecycle
  - owns primary verification and fallback release decision

The recovery path must bypass the normal LLM chat path. If `openai-codex` auth is broken, the operator still needs a reliable deterministic control surface in the same Telegram chat.

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
- `createdAt`
- `expiresAt`
- `callbackReceivedAt`
- `credentialWriteAt`
- `verificationAttemptAt`
- `verificationPassedAt`
- `lastTelegramNoticeAt`
- `lastFailureReason`

## Trigger Conditions

Automatic trigger source:

- `agent_end`

Trigger only on targeted `openai-codex` auth failures such as:

- `OAuth token refresh failed for openai-codex`
- `refresh_token_reused`
- `Please try again or re-authenticate`
- `401` in codex auth-refresh context

Do not trigger on:

- generic tool failures
- user prompt/content failures
- unrelated provider failures
- rate-limit failures already handled by the fallback plugin

On first valid auth-outage trigger:

1. mark outage active
2. pin fallback
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

## OAuth Flow

Practical flow:

1. plugin generates auth URL
2. plugin sends URL to Telegram
3. operator opens URL in a browser
4. operator completes login
5. completion happens via:
   - preferred: callback received automatically
   - fallback: redirect URL pasted back through Telegram
6. plugin persists refreshed credentials
7. plugin verifies primary
8. plugin releases fallback only if verification passes

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

- auth failure matcher triggers outage only for `openai-codex` auth errors
- non-auth failures do not trigger outage
- duplicate outage does not spam
- fallback pin/release contract behaves correctly
- outage notice emitted once
- `/reauth` creates session and emits URL
- unauthorized Telegram user/chat is rejected
- callback or pasteback completion advances state
- verification success releases fallback
- verification failure keeps fallback pinned and notifies Telegram
- redirect/token material is redacted from logs and chat output

End-to-end host validation should cover:

1. break `openai-codex` auth
2. observe Telegram outage notice
3. complete reauth
4. verify primary success
5. verify fallback release

## Delivery Plan

Recommended delivery order:

1. extend `codex-openai-fallback` with pinned fallback state and gateway controls
2. add tests for pinned fallback semantics
3. scaffold `codex-telegram-reauth`
4. implement auth-outage detection and session persistence
5. implement Telegram notice and control commands
6. implement OAuth helper start/completion
7. implement callback or pasteback completion
8. implement deterministic primary verification
9. implement fallback release only on verified success
10. add docs and live validation

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
