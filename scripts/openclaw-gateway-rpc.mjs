#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  console.error(`[openclaw-gateway-rpc][FAIL] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    openclawBin: process.env.OPENCLAW_BIN || "openclaw",
    openclawPackageRoot: process.env.OPENCLAW_PACKAGE_ROOT || "",
    method: "",
    paramsRaw: "{}",
    timeoutMs: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--openclaw-bin":
        out.openclawBin = argv[++i] || "";
        break;
      case "--openclaw-package-root":
        out.openclawPackageRoot = argv[++i] || "";
        break;
      case "--method":
        out.method = argv[++i] || "";
        break;
      case "--params":
        out.paramsRaw = argv[++i] || "{}";
        break;
      case "--timeout-ms": {
        const raw = argv[++i] || "";
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) fail(`invalid --timeout-ms: ${raw}`);
        out.timeoutMs = parsed;
        break;
      }
      case "--help":
        console.log([
          "Usage:",
          "  openclaw-gateway-rpc.mjs --method <name> [--params <json>] [--timeout-ms <n>] [--openclaw-bin <path>] [--openclaw-package-root <path>]",
          "",
          "Calls the lower-level OpenClaw gateway client directly.",
        ].join("\n"));
        process.exit(0);
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  if (!out.method.trim()) fail("--method is required");
  return out;
}

function resolveFromPath(commandName) {
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

function resolveExecutable(commandOrPath) {
  const trimmed = commandOrPath.trim();
  if (!trimmed) fail("openclaw binary is empty");
  const candidate = trimmed.includes("/") ? trimmed : resolveFromPath(trimmed);
  if (!candidate) fail(`unable to resolve executable: ${trimmed}`);
  return fs.realpathSync(candidate);
}

function isPackageRoot(candidate) {
  return fs.existsSync(path.join(candidate, "package.json")) && fs.existsSync(path.join(candidate, "dist"));
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

function resolvePackageRoot(options) {
  if (options.openclawPackageRoot.trim()) {
    const candidate = fs.realpathSync(options.openclawPackageRoot.trim());
    if (!isPackageRoot(candidate)) fail(`package root is missing package.json/dist: ${candidate}`);
    return candidate;
  }

  const openclawBin = resolveExecutable(options.openclawBin);
  const packageRoot = walkUpForPackageRoot(openclawBin);
  if (!packageRoot) {
    fail(`unable to derive package root from openclaw binary: ${openclawBin}`);
  }
  return packageRoot;
}

function resolveCallModulePath(packageRoot) {
  const distDir = path.join(packageRoot, "dist");
  if (!fs.existsSync(distDir)) fail(`dist directory not found: ${distDir}`);
  const candidates = fs
    .readdirSync(distDir)
    .filter((entry) => /^call-.*\.js$/.test(entry))
    .sort();
  if (candidates.length === 0) fail(`no call-*.js bundle found under ${distDir}`);
  return path.join(distDir, candidates[0]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageRoot = resolvePackageRoot(options);
  const modulePath = resolveCallModulePath(packageRoot);

  let params;
  try {
    params = JSON.parse(options.paramsRaw || "{}");
  } catch (error) {
    fail(`invalid --params JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (params === null || Array.isArray(params) || typeof params !== "object") {
    fail("--params must decode to a JSON object");
  }

  const mod = await import(pathToFileURL(modulePath).href);
  const callGateway = mod?.n;
  if (typeof callGateway !== "function") {
    fail(`callGateway export not found in ${modulePath}`);
  }

  try {
    const result = await callGateway({
      method: options.method,
      params,
      clientName: "cli",
      mode: "cli",
      ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {}),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

await main();
