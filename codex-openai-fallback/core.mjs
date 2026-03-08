export function createCircuitState() {
  return {
    untilMs: 0,
    lastThrottleAtMs: 0,
    lastThrottleReason: "",
    lastAppliedAtMs: 0,
    appliedCount: 0,
    pinned: false,
    pinReason: "",
    pinSource: "",
    lastAuthOutageAtMs: 0,
    lastAuthOutageError: "",
  };
}

export function remainingSeconds(state, now = Date.now()) {
  if (state.untilMs <= now) {
    return 0;
  }
  return Math.ceil((state.untilMs - now) / 1000);
}

export function isFallbackActive(state, now = Date.now()) {
  return state.pinned === true || state.untilMs > now;
}

export function armFallbackWindow(state, seconds, source = "manual-arm", now = Date.now()) {
  const safeSeconds = Math.max(15, Math.min(3600, Math.floor(seconds)));
  state.untilMs = now + safeSeconds * 1000;
  state.lastThrottleAtMs = now;
  state.lastThrottleReason = `${source}:${safeSeconds}s`;
  return safeSeconds;
}

export function clearFallbackWindow(state, now = Date.now()) {
  const wasActive = state.untilMs > now;
  state.untilMs = 0;
  return wasActive;
}

export function cleanupExpiredFallbackWindow(state, now = Date.now()) {
  if (state.untilMs > 0 && state.untilMs <= now) {
    state.untilMs = 0;
    return true;
  }
  return false;
}

export function pinFallback(state, reason = "pinned", source = "manual-pin") {
  const nextReason = typeof reason === "string" && reason.trim() ? reason.trim() : "pinned";
  const nextSource = typeof source === "string" && source.trim() ? source.trim() : "manual-pin";
  state.pinned = true;
  state.pinReason = nextReason;
  state.pinSource = nextSource;
}

export function releasePinnedFallback(state) {
  const wasPinned = state.pinned === true;
  state.pinned = false;
  state.pinReason = "";
  state.pinSource = "";
  return wasPinned;
}

export function refreshThrottleFallback(state, cooldownMs, reason, now = Date.now()) {
  const wasWindowActive = state.untilMs > now;
  const previousUntilMs = state.untilMs;
  state.untilMs = now + cooldownMs;
  state.lastThrottleAtMs = now;
  state.lastThrottleReason =
    typeof reason === "string" && reason.trim() ? reason.trim() : "rate-limit";
  const previousRemainingSeconds =
    previousUntilMs > now ? Math.ceil((previousUntilMs - now) / 1000) : 0;
  return { wasWindowActive, previousRemainingSeconds };
}
