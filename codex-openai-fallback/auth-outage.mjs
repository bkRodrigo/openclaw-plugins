import { pinFallback } from "./core.mjs";

export const AUTH_OUTAGE_PIN_REASON = "auth-outage";
export const AUTH_OUTAGE_PIN_SOURCE = "auth-refresh";

const OPENAI_CODEX_RE = /openai[-_ ]?codex/i;
const AUTH_SIGNAL_PATTERNS = [
  /oauth\s+token\s+refresh\s+failed/i,
  /failed\s+to\s+refresh\s+oauth\s+token/i,
  /refresh[_ -]?token[_ -]?reused/i,
  /re-?authenticate/i,
  /invalid_grant/i,
  /token\s+refresh/i,
];
const REFRESH_CONTEXT_PATTERNS = [/refresh/i, /oauth/i, /token/i];
const HTTP_401_RE = /\b401\b/;

function normalizeErrorText(error) {
  return typeof error === "string" ? error.trim() : "";
}

function buildAuthOutageClassification(error) {
  const normalized = normalizeErrorText(error);
  return {
    kind: "auth_outage",
    reason: AUTH_OUTAGE_PIN_REASON,
    source: AUTH_OUTAGE_PIN_SOURCE,
    error: normalized,
  };
}

export function isAuthOutageError(error) {
  const message = normalizeErrorText(error);
  if (!message) {
    return false;
  }
  if (!OPENAI_CODEX_RE.test(message)) {
    return false;
  }
  if (AUTH_SIGNAL_PATTERNS.some((pattern) => pattern.test(message))) {
    return true;
  }
  return HTTP_401_RE.test(message) && REFRESH_CONTEXT_PATTERNS.every((pattern) => pattern.test(message));
}

export function classifyAgentFailure(event) {
  if (!event || event.success) {
    return { kind: "none" };
  }
  const error = normalizeErrorText(event.error);
  if (!error) {
    return { kind: "none" };
  }
  if (!isAuthOutageError(error)) {
    return { kind: "none" };
  }
  return buildAuthOutageClassification(error);
}

export function classifyMessageSendingEvent(event) {
  const content = normalizeErrorText(event?.content);
  if (!content) {
    return { kind: "none" };
  }
  const marker = "Agent failed before reply:";
  const markerIndex = content.indexOf(marker);
  if (markerIndex === -1) {
    return { kind: "none" };
  }
  const failureText = content.slice(markerIndex + marker.length).split("\n", 1)[0]?.trim() ?? "";
  if (!failureText || !isAuthOutageError(failureText)) {
    return { kind: "none" };
  }
  return buildAuthOutageClassification(failureText);
}

export function applyAgentFailureToCircuit(state, event, now = Date.now()) {
  const classified = classifyAgentFailure(event);
  if (classified.kind !== "auth_outage") {
    return null;
  }
  const wasPinned = state.pinned === true;
  pinFallback(state, classified.reason, classified.source);
  state.lastAuthOutageAtMs = now;
  state.lastAuthOutageError = classified.error;
  return {
    ...classified,
    wasPinned,
  };
}

export function applyMessageSendingEventToCircuit(state, event, now = Date.now()) {
  const classified = classifyMessageSendingEvent(event);
  if (classified.kind !== "auth_outage") {
    return null;
  }
  const wasPinned = state.pinned === true;
  pinFallback(state, classified.reason, classified.source);
  state.lastAuthOutageAtMs = now;
  state.lastAuthOutageError = classified.error;
  return {
    ...classified,
    wasPinned,
  };
}
