import fs from "fs";
import path from "path";
import crypto from "crypto";

function createEmptySession() {
  return {
    sessionId: "",
    status: "idle",
    chatId: "",
    userId: "",
    authUrl: "",
    createdAt: 0,
    expiresAt: 0,
    callbackReceivedAt: 0,
    credentialWriteAt: 0,
    verificationAttemptAt: 0,
    verificationPassedAt: 0,
  };
}

export function createReauthState() {
  return {
    version: 1,
    outageActive: false,
    outageReason: "",
    fallbackPinned: false,
    fallbackPinReason: "",
    fallbackPinSource: "",
    lastFailureReason: "",
    lastTelegramNoticeAt: 0,
    session: createEmptySession(),
  };
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeSession(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    sessionId: normalizeString(source.sessionId),
    status: normalizeString(source.status) || "idle",
    chatId: normalizeString(source.chatId),
    userId: normalizeString(source.userId),
    authUrl: normalizeString(source.authUrl),
    createdAt: normalizeNumber(source.createdAt),
    expiresAt: normalizeNumber(source.expiresAt),
    callbackReceivedAt: normalizeNumber(source.callbackReceivedAt),
    credentialWriteAt: normalizeNumber(source.credentialWriteAt),
    verificationAttemptAt: normalizeNumber(source.verificationAttemptAt),
    verificationPassedAt: normalizeNumber(source.verificationPassedAt),
  };
}

export function normalizeState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    version: 1,
    outageActive: source.outageActive === true,
    outageReason: normalizeString(source.outageReason),
    fallbackPinned: source.fallbackPinned === true,
    fallbackPinReason: normalizeString(source.fallbackPinReason),
    fallbackPinSource: normalizeString(source.fallbackPinSource),
    lastFailureReason: normalizeString(source.lastFailureReason),
    lastTelegramNoticeAt: normalizeNumber(source.lastTelegramNoticeAt),
    session: normalizeSession(source.session),
  };
}

export function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function loadState(filePath) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    return createReauthState();
  }
}

export function saveState(filePath, state) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, "utf8");
}

export function createSessionId(now = Date.now()) {
  return `${now}-${crypto.randomBytes(4).toString("hex")}`;
}

export function beginOutage(state, details, now = Date.now()) {
  if (state.outageActive && state.session.status !== "idle" && state.session.status !== "recovered") {
    return { changed: false, state };
  }
  state.outageActive = true;
  state.outageReason = normalizeString(details.reason) || "auth-outage";
  state.fallbackPinned = details.fallbackPinned === true;
  state.fallbackPinReason = normalizeString(details.fallbackPinReason) || "auth-outage";
  state.fallbackPinSource = normalizeString(details.fallbackPinSource) || "auth-refresh";
  state.lastFailureReason = normalizeString(details.failureReason);
  state.session = {
    ...createEmptySession(),
    status: "reauth_pending",
    createdAt: now,
  };
  return { changed: true, state };
}

export function startReauthSession(state, params, now = Date.now()) {
  if (!state.outageActive) {
    return { ok: false, reason: "no_outage", state };
  }
  if (state.session.status === "reauth_in_progress" && state.session.sessionId) {
    return { ok: false, reason: "session_active", state };
  }
  state.session = {
    ...createEmptySession(),
    sessionId: normalizeString(params.sessionId),
    status: "reauth_in_progress",
    chatId: normalizeString(params.chatId),
    userId: normalizeString(params.userId),
    authUrl: normalizeString(params.authUrl),
    createdAt: now,
    expiresAt: normalizeNumber(params.expiresAt),
  };
  return { ok: true, state };
}

export function cancelReauthSession(state, params, now = Date.now()) {
  if (!state.session.sessionId && state.session.status !== "reauth_pending" && state.session.status !== "reauth_in_progress") {
    return { ok: false, reason: "no_active_session", state };
  }
  state.lastFailureReason = normalizeString(params.failureReason) || normalizeString(params.reason) || "cancelled";
  state.session = {
    ...state.session,
    status: "reauth_failed",
    expiresAt: state.session.expiresAt || now,
  };
  return { ok: true, state };
}

export function buildStatus(state) {
  const normalized = normalizeState(state);
  return {
    outageActive: normalized.outageActive,
    outageReason: normalized.outageReason || null,
    fallbackPinned: normalized.fallbackPinned,
    fallbackPinReason: normalized.fallbackPinReason || null,
    fallbackPinSource: normalized.fallbackPinSource || null,
    lastFailureReason: normalized.lastFailureReason || null,
    lastTelegramNoticeAt: normalized.lastTelegramNoticeAt || null,
    session: {
      sessionId: normalized.session.sessionId || null,
      status: normalized.session.status,
      chatId: normalized.session.chatId || null,
      userId: normalized.session.userId || null,
      authUrl: normalized.session.authUrl || null,
      createdAt: normalized.session.createdAt || null,
      expiresAt: normalized.session.expiresAt || null,
      callbackReceivedAt: normalized.session.callbackReceivedAt || null,
      credentialWriteAt: normalized.session.credentialWriteAt || null,
      verificationAttemptAt: normalized.session.verificationAttemptAt || null,
      verificationPassedAt: normalized.session.verificationPassedAt || null,
    },
  };
}
