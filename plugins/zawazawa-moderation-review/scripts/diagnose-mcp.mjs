import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { homedir, platform as hostPlatform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultConnectorProfileDirectory,
  defaultReviewStoreDirectory,
} from "../server/platform-paths.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = join(PLUGIN_ROOT, "mcp.runtime.json");
const MINIMUM_NODE_MAJOR = 24;
const MCP_TIMEOUT_MS = 20_000;
const MAX_STDERR_BYTES = 16 * 1024;
const IS_INSTALLED_CACHE = /(?:^|[/\\])plugins[/\\]cache[/\\]/iu.test(PLUGIN_ROOT);
const execFile = promisify(execFileCallback);
const DIRECT_SERVER_ENV = "ZAWAZAWA_DIAGNOSTIC_DIRECT_SERVER";
const SDK_CLIENT_SPECIFIERS = [
  "@modelcontextprotocol/sdk/client/index.js",
  "@modelcontextprotocol/sdk/client/stdio.js",
];
const SAFE_IMPORT_ERROR_CODES = new Set([
  "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_INVALID_PACKAGE_CONFIG", "ERR_UNKNOWN_FILE_EXTENSION", "EACCES", "EPERM",
]);

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

export function knownMissingPackage(error, packageNames) {
  const target = /Cannot find (?:module|package) '([^']+)'/u.exec(String(error?.message ?? ""))?.[1]?.replaceAll("\\", "/");
  if (!target) return null;
  return packageNames.find((name) => target === name || target.includes(`/node_modules/${name}/`)) ?? null;
}

async function loadSdkClients() {
  const packageManifestPresent = await exists(join(PLUGIN_ROOT, "node_modules", "@modelcontextprotocol", "sdk", "package.json"));
  let packageNames = [];
  try {
    const lock = JSON.parse(await readFile(join(PLUGIN_ROOT, "package-lock.json"), "utf8"));
    packageNames = Object.keys(lock.packages ?? {})
      .filter((key) => key.includes("node_modules/"))
      .map((key) => key.split("node_modules/").at(-1));
  } catch { /* Missing lock metadata must not hide the original import error. */ }
  const issues = [];
  const results = await Promise.allSettled(SDK_CLIENT_SPECIFIERS.map(async (specifier) => {
    let entrypointResolved = false;
    let entrypointExists = false;
    try {
      const url = import.meta.resolve(specifier);
      entrypointResolved = true;
      entrypointExists = await exists(fileURLToPath(url));
      return await import(specifier);
    } catch (error) {
      issues.push({
        specifier,
        errorCode: SAFE_IMPORT_ERROR_CODES.has(error?.code) ? error.code : "IMPORT_FAILED",
        missingPackage: knownMissingPackage(error, packageNames),
        packageManifestPresent,
        entrypointResolved,
        entrypointExists,
      });
      throw error;
    }
  }));
  issues.sort((a, b) => a.specifier.localeCompare(b.specifier));
  return { issues, results };
}

export const KNOWN_TOOL_NAMES = Object.freeze([
  "get_moderation_target_config",
  "get_zawazawa_open_reports",
  "render_moderation_review",
  "get_moderation_review_snapshot",
]);

function isPresent(value) {
  return typeof value === "string" && value.length > 0;
}

export function isSupportedNodeVersion(version) {
  const major = Number.parseInt(String(version).replace(/^v/u, "").split(".")[0], 10);
  return Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR;
}

/** Resolve configured/default storage paths without creating or reading those paths. */
export function validateDefaultStoragePaths({
  env = process.env,
  platform = hostPlatform(),
  home = homedir(),
} = {}) {
  try {
    defaultReviewStoreDirectory({ env, platform, home });
    defaultConnectorProfileDirectory({ env, platform, home });
    return { ok: true, errorCategory: null };
  } catch (error) {
    return {
      ok: false,
      errorCategory: "platform_storage_invalid",
      failureDetail: /LOCALAPPDATA/iu.test(String(error?.message ?? ""))
        ? "env_missing"
        : "default_path_unavailable",
    };
  }
}

export function parseMcpManifest(manifestText) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw Object.assign(new Error("Invalid MCP manifest"), { code: "MCP_MANIFEST_INVALID" });
  }

  const server = manifest?.mcpServers?.["zawazawa-moderation-review"];
  if (
    !server ||
    typeof server.command !== "string" ||
    server.command.length === 0 ||
    !Array.isArray(server.args) ||
    !server.args.every((argument) => typeof argument === "string") ||
    (server.cwd !== undefined && typeof server.cwd !== "string")
  ) {
    throw Object.assign(new Error("Invalid MCP manifest"), { code: "MCP_MANIFEST_INVALID" });
  }

  return {
    command: server.command,
    args: [...server.args],
    cwd: resolve(PLUGIN_ROOT, server.cwd ?? "."),
  };
}

export function classifyDiagnosticFailure({ error, stderr = "", phase = "startup" } = {}) {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message : "";
  const internalDiagnostics = `${code}\n${message}\n${stderr}`;

  if (code === "DIAGNOSTIC_TIMEOUT" || error?.name === "TimeoutError") return "timeout";
  if (phase === "spawn" && code === "ENOENT") return "node_unavailable";
  if (/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/iu.test(internalDiagnostics)) {
    return "dependencies_missing";
  }
  if (/LOCALAPPDATA/iu.test(internalDiagnostics)) return "env_missing";
  return "startup_failed";
}

export function createSafeReport({
  phase,
  errorCategory = null,
  failureDetail = null,
  toolNames = null,
  pluginVersion = null,
  elapsedMs = null,
  cleanupFailed = false,
  dependencyIssues = null,
  env = process.env,
  platform = hostPlatform(),
  nodeVersion = process.version,
} = {}) {
  const nodeSupported = isSupportedNodeVersion(nodeVersion);
  const platformSupported = platform === "darwin" || platform === "win32";
  const names = Array.isArray(toolNames) ? new Set(toolNames) : null;
  return {
    runtime: {
      nodeVersion,
      pluginVersion,
      platform,
      runtimeSupported: nodeSupported && platformSupported,
      nodeSupported,
      platformSupported,
    },
    scope: "isolated_startup",
    invocation: "direct_process",
    check: process.env[DIRECT_SERVER_ENV] === "1" ? "prepared_runtime_stdio" : "packaged_manifest_stdio",
    realStorageWriteCheck: "not_performed",
    elapsedMs,
    isInstalledCache: IS_INSTALLED_CACHE,
    directStartupOk: Array.isArray(toolNames),
    hostRegistrationChecked: false,
    phase,
    result: errorCategory === null && !cleanupFailed ? "success" : "failure",
    toolCount: names?.size ?? null,
    knownToolsPresent: names
      ? Object.fromEntries(KNOWN_TOOL_NAMES.map((name) => [name, names.has(name)]))
      : null,
    environment: {
      localAppDataPresent: platform === "win32" ? isPresent(env.LOCALAPPDATA) : null,
      reviewStoreOverridePresent: isPresent(env.ZAWAZAWA_REVIEW_STORE_DIR),
      connectorProfileOverridePresent: isPresent(env.ZAWAZAWA_CONNECTOR_PROFILE_DIR),
      targetConfigPresent: isPresent(env.ZAWAZAWA_TARGET_CONFIG),
    },
    errorCategory,
    failureDetail,
    dependencyIssues,
    cleanupCategory: cleanupFailed ? "cleanup_failed" : null,
  };
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error("Diagnostic timed out"), { code: "DIAGNOSTIC_TIMEOUT" }));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readPackagedMetadata() {
  try {
    const [manifestText, packageText] = await Promise.all([
      readFile(MANIFEST_PATH, "utf8"),
      readFile(join(PLUGIN_ROOT, "package.json"), "utf8"),
    ]);
    const packageJson = JSON.parse(packageText);
    if (typeof packageJson.version !== "string") throw new Error("Invalid plugin metadata");
    return {
      server: parseMcpManifest(manifestText),
      pluginVersion: packageJson.version,
    };
  } catch (error) {
    if (error?.code === "MCP_MANIFEST_INVALID") throw error;
    throw Object.assign(new Error("Invalid packaged plugin metadata"), {
      code: "MCP_MANIFEST_INVALID",
    });
  }
}

async function runDiagnostic() {
  const startedAt = Date.now();
  let phase = "runtime";
  let error = null;
  let failureDetail = null;
  let dependencyIssues = null;
  let toolNames = null;
  let pluginVersion = null;
  let stderr = "";
  let temporaryRoot = null;
  let transport = null;
  let client = null;
  let childWasStarted = false;
  let childClosed = false;
  let childClosedPromise = null;
  let resolveChildClosed = null;
  let cleanupFailed = false;

  try {
    if (!isSupportedNodeVersion(process.versions.node)) {
      error = Object.assign(new Error("Unsupported Node.js runtime"), {
        code: "RUNTIME_UNSUPPORTED",
      });
      throw error;
    }

    phase = "manifest";
    const metadata = await readPackagedMetadata();
    const { server } = metadata;
    pluginVersion = metadata.pluginVersion;
    if (process.env[DIRECT_SERVER_ENV] === "1") {
      // Already delegated to the prepared runtime; avoid recursively invoking its launcher.
      server.command = process.execPath;
      server.args = ["./server/server.mjs"];
      server.cwd = PLUGIN_ROOT;
    }

    // Resolve the caller's real defaults first. This is intentionally a read-only check: the
    // values are discarded before a child process can create anything in an operational folder.
    phase = "environment";
    const storagePaths = validateDefaultStoragePaths();
    if (!storagePaths.ok) {
      error = Object.assign(new Error("Storage path configuration is unavailable"), {
        code: storagePaths.errorCategory,
      });
      failureDetail = storagePaths.failureDetail;
      throw error;
    }

    temporaryRoot = await mkdtemp(join(tmpdir(), "zawazawa-mcp-diagnostic-"));
    const temporaryStore = join(temporaryRoot, "reviews");
    const temporaryProfile = join(temporaryRoot, "connector-profile");

    phase = "dependencies";
    const sdk = await loadSdkClients();
    dependencyIssues = sdk.issues;
    const failedImport = sdk.results.find((result) => result.status === "rejected");
    if (failedImport) throw failedImport.reason;
    const { Client } = sdk.results[0].value;
    const { StdioClientTransport } = sdk.results[1].value;

    transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      stderr: "pipe",
      env: {
        ZAWAZAWA_REVIEW_STORE_DIR: temporaryStore,
        ZAWAZAWA_CONNECTOR_PROFILE_DIR: temporaryProfile,
        ZAWAZAWA_REVIEW_UI: "off",
      },
    });
    transport.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.toString("utf8").slice(0, MAX_STDERR_BYTES - stderr.length);
      }
    });

    client = new Client({ name: "zawazawa-mcp-diagnostic", version: "1.0.0" });
    childClosedPromise = new Promise((resolveChild) => {
      resolveChildClosed = resolveChild;
    });
    transport.onclose = () => {
      childClosed = true;
      resolveChildClosed();
    };

    const deadline = Date.now() + MCP_TIMEOUT_MS;
    const remainingMs = () => Math.max(1, deadline - Date.now());
    phase = "spawn";
    await withTimeout(
      client.connect(transport, {
        timeout: remainingMs(),
        maxTotalTimeout: remainingMs(),
      }),
      remainingMs(),
    );

    phase = "tools";
    const result = await withTimeout(
      client.listTools({}, { timeout: remainingMs(), maxTotalTimeout: remainingMs() }),
      remainingMs(),
    );
    toolNames = result.tools.map((tool) => tool.name);
    childWasStarted = true;
  } catch (caught) {
    error = caught;
    childWasStarted ||= Boolean(transport?.pid);
    if (phase === "spawn" && transport?.pid) phase = "initialize";
  } finally {
    // The child must stop before its temporary profile/store are removed (especially on Windows).
    childWasStarted ||= Boolean(transport?.pid);
    try {
      if (client) await client.close();
      else if (transport) await transport.close();
    } catch {
      cleanupFailed = true;
    }
    if (childWasStarted && !childClosed && childClosedPromise) {
      await Promise.race([
        childClosedPromise,
        new Promise((resolveWait) => setTimeout(resolveWait, 500)),
      ]);
    }
    if (childWasStarted && !childClosed) cleanupFailed = true;
    if (temporaryRoot && (!childWasStarted || childClosed)) {
      try {
        await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        cleanupFailed = true;
      }
    } else if (temporaryRoot) {
      cleanupFailed = true;
    }
  }

  let errorCategory = null;
  if (error) {
    if (error.code === "RUNTIME_UNSUPPORTED") errorCategory = "runtime_unsupported";
    else if (error.code === "MCP_MANIFEST_INVALID") errorCategory = "manifest_invalid";
    else if (phase === "environment" && error.code === "platform_storage_invalid") {
      errorCategory = "platform_storage_invalid";
    } else {
      errorCategory = classifyDiagnosticFailure({ error, stderr, phase });
    }
  }
  if (cleanupFailed && errorCategory === null) errorCategory = "cleanup_failed";

  return createSafeReport({
    phase,
    errorCategory,
    failureDetail,
    dependencyIssues,
    toolNames,
    pluginVersion,
    elapsedMs: Date.now() - startedAt,
    cleanupFailed,
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
const invokedRealPath = invokedPath ? await realpath(invokedPath).catch(() => null) : null;
if (invokedRealPath === fileURLToPath(import.meta.url)) {
  let report;
  const startedAt = Date.now();
  let metadata;
  try { metadata = await readPackagedMetadata(); } catch { /* Normal diagnostic reports metadata failures. */ }
  const usesLauncher = metadata?.server.args.some((arg) => arg.replaceAll("\\", "/").endsWith("scripts/runtime-launcher.mjs"));
  if (usesLauncher && process.env[DIRECT_SERVER_ENV] !== "1") {
    try {
      const { stdout: rootOutput } = await execFile(process.execPath, [join(PLUGIN_ROOT, "scripts", "runtime-launcher.mjs"), "--print-root"], {
        timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true,
      });
      const runtimeRoot = rootOutput.trim();
      const { stdout } = await execFile(process.execPath, [join(runtimeRoot, "scripts", "diagnose-mcp.mjs")], {
        env: { ...process.env, [DIRECT_SERVER_ENV]: "1" },
        timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true,
      });
      report = JSON.parse(stdout);
    } catch (error) {
      try { report = JSON.parse(error.stdout); } catch {
        report = createSafeReport({
          phase: "runtime_setup", errorCategory: "runtime_not_prepared",
          pluginVersion: metadata.pluginVersion, elapsedMs: Date.now() - startedAt,
        });
      }
    }
  } else {
    report = await runDiagnostic();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.result !== "success") process.exitCode = 1;
}
