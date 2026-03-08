import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function isPackageRoot(candidate) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8"));
    return pkg?.name === "openclaw" && fs.existsSync(path.join(candidate, "dist"));
  } catch {
    return false;
  }
}

function walkUpForPackageRoot(startPath) {
  let current = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);
  while (true) {
    if (isPackageRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolveExecutable(commandName) {
  const pathValue = process.env.PATH || "";
  for (const segment of pathValue.split(":")) {
    if (!segment) continue;
    const candidate = path.join(segment, commandName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function stripAnsi(text) {
  return String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

function summarizeReason(value, fallback = "Primary verification failed") {
  const cleaned = stripAnsi(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("[plugins]"))
    .slice(-4)
    .join("\n")
    .trim();
  return cleaned || fallback;
}

export function resolveOpenClawPackageRoot() {
  const envRoot = process.env.OPENCLAW_PACKAGE_ROOT?.trim();
  if (envRoot && isPackageRoot(envRoot)) return fs.realpathSync(envRoot);

  const ownDir = path.dirname(fileURLToPath(import.meta.url));
  const byAncestor = walkUpForPackageRoot(ownDir);
  if (byAncestor) return byAncestor;

  const openclawBin = process.env.OPENCLAW_BIN?.trim() || resolveExecutable("openclaw");
  if (openclawBin) {
    const byBin = walkUpForPackageRoot(fs.realpathSync(openclawBin));
    if (byBin) return byBin;
  }

  const commonGlobal = path.join(process.env.HOME || "/home/openclaw", ".npm-global", "lib", "node_modules", "openclaw");
  if (isPackageRoot(commonGlobal)) return commonGlobal;

  throw new Error("Unable to resolve OpenClaw package root");
}

async function importDistBundle(prefix) {
  const packageRoot = resolveOpenClawPackageRoot();
  const distDir = path.join(packageRoot, "dist");
  const match = fs
    .readdirSync(distDir)
    .filter((entry) => entry.startsWith(`${prefix}-`) && entry.endsWith(".js"))
    .sort()[0];
  if (!match) {
    throw new Error(`Unable to locate dist bundle ${prefix}-*.js under ${distDir}`);
  }
  return import(pathToFileURL(path.join(distDir, match)).href);
}

export async function loadWriteOAuthCredentials() {
  const mod = await importDistBundle("auth-token");
  if (typeof mod?.Ct !== "function") {
    throw new Error("writeOAuthCredentials export not found in OpenClaw auth-token bundle");
  }
  return mod.Ct;
}

export async function callGatewayMethod(method, params = {}) {
  const mod = await importDistBundle("call");
  if (typeof mod?.n !== "function") {
    throw new Error("callGateway export not found in OpenClaw call bundle");
  }
  return mod.n({
    method,
    params,
    clientName: "cli",
    mode: "cli",
  });
}

export function resolveAgentDir(agentId = "main") {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(process.env.HOME || "/home/openclaw", ".openclaw");
  return path.join(stateDir, "agents", agentId, "agent");
}

export function loadStoredCredential({ agentDir, provider = "openai-codex", profileId = "" }) {
  const storePath = path.join(agentDir, "auth-profiles.json");
  const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const profiles = raw?.profiles && typeof raw.profiles === "object" ? raw.profiles : {};

  const requested = typeof profileId === "string" && profileId.trim() ? profileId.trim() : "";
  if (requested && profiles[requested]) {
    return { profileId: requested, credential: profiles[requested] };
  }

  for (const [candidateId, credential] of Object.entries(profiles)) {
    if (credential && typeof credential === "object" && credential.provider === provider) {
      return { profileId: candidateId, credential };
    }
  }

  throw new Error(`No stored auth profile found for ${provider}`);
}

function extractResponseText(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block?.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

export async function verifyPrimaryWithStoredCredential({
  agentDir,
  provider = "openai-codex",
  profileId = "",
  modelRef = "openai-codex/gpt-5.3-codex",
  prompt,
  expectedText,
  loadCredential = loadStoredCredential,
  getModelFn,
  completeFn,
}) {
  try {
    const loaded = await loadCredential({ agentDir, provider, profileId });
    const credential = loaded?.credential ?? {};
    const accessToken =
      typeof credential.access === "string" && credential.access.trim()
        ? credential.access.trim()
        : typeof credential.token === "string" && credential.token.trim()
          ? credential.token.trim()
          : "";
    if (!accessToken) {
      return {
        ok: false,
        reason: "Stored OpenAI Codex credential has no usable access token",
      };
    }

    const modelProvider = modelRef.includes("/") ? modelRef.split("/", 1)[0] : provider;
    const modelId = modelRef.includes("/") ? modelRef.split("/").slice(1).join("/") : modelRef;

    const piAi = getModelFn && completeFn ? null : await import("@mariozechner/pi-ai");
    const getModel = getModelFn || piAi?.getModel;
    const complete = completeFn || piAi?.complete;
    if (typeof getModel !== "function" || typeof complete !== "function") {
      return {
        ok: false,
        reason: "pi-ai runtime is unavailable for primary verification",
      };
    }

    const model = getModel(modelProvider, modelId);
    const response = await complete(
      model,
      {
        systemPrompt: prompt,
        messages: [{ role: "user", content: "Do it now." }],
      },
      {
        apiKey: accessToken,
        maxTokens: 32,
        transport: "sse",
      }
    );

    const text = extractResponseText(response);
    if (text !== expectedText) {
      return {
        ok: false,
        reason: `Unexpected primary verification response: ${text || "<empty>"}`,
      };
    }

    return {
      ok: true,
      profileId: loaded.profileId,
      responseText: text,
    };
  } catch (error) {
    return {
      ok: false,
      reason: summarizeReason(error?.message ?? error),
    };
  }
}
