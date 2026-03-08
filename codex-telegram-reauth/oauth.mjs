import crypto from "node:crypto";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function defaultCreatePkce() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createState() {
  return crypto.randomBytes(16).toString("hex");
}

export async function createAuthorizationStart({
  originator = "pi",
  createPkce = defaultCreatePkce,
  createState: createStateFn = createState,
} = {}) {
  const { verifier, challenge } = await createPkce();
  const state = createStateFn();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return {
    verifier,
    state,
    url: url.toString(),
  };
}

export function parseAuthorizationInput(input) {
  const value = String(input ?? "").trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // fall through
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

function decodeJwt(token) {
  try {
    const parts = String(token ?? "").split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1] ?? "";
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
}

async function exchangeAuthorizationCode({ code, verifier, fetchFn = fetch, redirectUri = REDIRECT_URI }) {
  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  if (!response?.ok) {
    const text = await response?.text?.().catch(() => "");
    throw new Error(`Token exchange failed (${response?.status ?? "unknown"}${text ? `: ${text.slice(0, 200)}` : ""})`);
  }
  const json = await response.json();
  if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== "number") {
    throw new Error("Token exchange returned incomplete OAuth credentials");
  }
  const accountId = extractAccountId(json.access_token);
  if (!accountId) {
    throw new Error("Failed to extract accountId from OpenAI access token");
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId,
  };
}

export async function completeAuthorizationPaste({
  input,
  expectedState,
  verifier,
  agentDir,
  fetchFn = fetch,
  writeCredentials,
}) {
  if (typeof writeCredentials !== "function") {
    throw new Error("writeCredentials is required");
  }
  const parsed = parseAuthorizationInput(input);
  if (parsed.state && parsed.state !== expectedState) {
    throw new Error("State mismatch");
  }
  if (!parsed.code) {
    throw new Error("Missing authorization code");
  }
  if (!verifier) {
    throw new Error("Missing stored PKCE verifier");
  }
  const credentials = await exchangeAuthorizationCode({
    code: parsed.code,
    verifier,
    fetchFn,
  });
  const profileId = await writeCredentials("openai-codex", credentials, agentDir, {
    syncSiblingAgents: true,
  });
  return {
    profileId,
    credentials,
  };
}

export { AUTHORIZE_URL, REDIRECT_URI, TOKEN_URL };
