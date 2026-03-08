import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { pathToFileURL } from "url";

import { isAuthOutageError } from "./auth-outage.mjs";

const require = createRequire(import.meta.url);

let cachedRuntimePromise = null;

function resolveOpenClawDistDir() {
  const openClawEntry = require.resolve("openclaw");
  return path.dirname(openClawEntry);
}

function findDistModuleByPrefix(distDir, prefix) {
  const match = fs
    .readdirSync(distDir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".js"))
    .sort()[0];
  if (!match) {
    throw new Error(`Unable to locate OpenClaw runtime module with prefix "${prefix}" in ${distDir}.`);
  }
  return path.join(distDir, match);
}

function resolveExportAlias(source, symbolName) {
  const match = source.match(new RegExp(`\\b${symbolName}\\s+as\\s+([A-Za-z_$][\\w$]*)\\b`));
  if (!match) {
    throw new Error(`Unable to resolve OpenClaw export alias for "${symbolName}".`);
  }
  return match[1];
}

async function loadOpenClawAuthRuntime() {
  if (!cachedRuntimePromise) {
    cachedRuntimePromise = (async () => {
      const distDir = resolveOpenClawDistDir();
      const modelSelectionPath = findDistModuleByPrefix(distDir, "model-selection-");
      const modelSelectionSource = fs.readFileSync(modelSelectionPath, "utf8");
      const agentScopePath = findDistModuleByPrefix(distDir, "agent-scope-");
      const agentScopeSource = fs.readFileSync(agentScopePath, "utf8");

      const ensureAuthProfileStoreAlias = resolveExportAlias(modelSelectionSource, "ensureAuthProfileStore");
      const resolveAuthProfileOrderAlias = resolveExportAlias(modelSelectionSource, "resolveAuthProfileOrder");
      const resolveApiKeyForProfileAlias = resolveExportAlias(modelSelectionSource, "resolveApiKeyForProfile");
      const resolveApiKeyForProviderAlias = resolveExportAlias(modelSelectionSource, "resolveApiKeyForProvider");
      const resolveOpenClawAgentDirAlias = resolveExportAlias(modelSelectionSource, "resolveOpenClawAgentDir");
      const resolveAgentDirAlias = resolveExportAlias(agentScopeSource, "resolveAgentDir");

      const runtimeModule = await import(pathToFileURL(modelSelectionPath).href);
      const agentScopeModule = await import(pathToFileURL(agentScopePath).href);

      const ensureAuthProfileStore = runtimeModule[ensureAuthProfileStoreAlias];
      const resolveAuthProfileOrder = runtimeModule[resolveAuthProfileOrderAlias];
      const resolveApiKeyForProfile = runtimeModule[resolveApiKeyForProfileAlias];
      const resolveApiKeyForProvider = runtimeModule[resolveApiKeyForProviderAlias];
      const resolveOpenClawAgentDir = runtimeModule[resolveOpenClawAgentDirAlias];
      const resolveAgentDir = agentScopeModule[resolveAgentDirAlias];

      if (typeof ensureAuthProfileStore !== "function") {
        throw new Error("Resolved OpenClaw runtime export ensureAuthProfileStore is not callable.");
      }
      if (typeof resolveAuthProfileOrder !== "function") {
        throw new Error("Resolved OpenClaw runtime export resolveAuthProfileOrder is not callable.");
      }
      if (typeof resolveApiKeyForProfile !== "function") {
        throw new Error("Resolved OpenClaw runtime export resolveApiKeyForProfile is not callable.");
      }
      if (typeof resolveApiKeyForProvider !== "function") {
        throw new Error("Resolved OpenClaw runtime export resolveApiKeyForProvider is not callable.");
      }
      if (typeof resolveOpenClawAgentDir !== "function") {
        throw new Error("Resolved OpenClaw runtime export resolveOpenClawAgentDir is not callable.");
      }
      if (typeof resolveAgentDir !== "function") {
        throw new Error("Resolved OpenClaw runtime export resolveAgentDir is not callable.");
      }

      return {
        ensureAuthProfileStore,
        resolveAuthProfileOrder,
        resolveApiKeyForProfile,
        resolveApiKeyForProvider,
        resolveOpenClawAgentDir,
        resolveAgentDir,
      };
    })();
  }
  return cachedRuntimePromise;
}

function classifyProbeError(error) {
  return {
    available: false,
    kind: isAuthOutageError(error) ? "auth_outage" : "other_error",
    error,
  };
}

export async function probePrimaryAuthAvailability({
  cfg,
  provider,
  agentId,
  agentDir,
  runtimeLoader = loadOpenClawAuthRuntime,
}) {
  const runtime = await runtimeLoader();
  const effectiveAgentDir =
    typeof agentDir === "string" && agentDir.trim().length > 0
      ? agentDir.trim()
      : typeof agentId === "string" && agentId.trim().length > 0
        ? runtime.resolveAgentDir(cfg, agentId.trim())
        : runtime.resolveOpenClawAgentDir();

  const store = runtime.ensureAuthProfileStore(effectiveAgentDir, { allowKeychainPrompt: false });
  const profileOrder = runtime.resolveAuthProfileOrder({
    cfg,
    store,
    provider,
  });

  for (const profileId of profileOrder) {
    try {
      const resolved = await runtime.resolveApiKeyForProfile({
        cfg,
        store,
        profileId,
        agentDir: effectiveAgentDir,
      });
      if (resolved) {
        return {
          available: true,
          kind: "ok",
          agentDir: effectiveAgentDir,
          error: "",
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...classifyProbeError(message),
        agentDir: effectiveAgentDir,
      };
    }
  }

  try {
    await runtime.resolveApiKeyForProvider({
      provider,
      cfg,
      store,
      agentDir: effectiveAgentDir,
    });
    return {
      available: true,
      kind: "ok",
      agentDir: effectiveAgentDir,
      error: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...classifyProbeError(message),
      agentDir: effectiveAgentDir,
    };
  }
}
