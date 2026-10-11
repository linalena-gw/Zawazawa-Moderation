#!/usr/bin/env node
// This cache-resident bootstrap intentionally uses only Node built-ins.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, constants, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultBrowsersDirectory, defaultRuntimeDirectory } from "../server/platform-paths.mjs";
import { checkDependencies } from "./check-dependencies.mjs";

export const READY_MARKER = ".runtime-ready.json";
const ROOT_FILES = ["package.json", "package-lock.json", "mcp.runtime.json"];
const SCRIPT_FILES = [
  "runtime-launcher.mjs",
  "check-dependencies.mjs",
  "diagnose-mcp.mjs",
  "register-mcp.mjs",
  "zawazawa-auth.mjs",
  "bootstrap.sh",
  "bootstrap.ps1",
  "node-release.json",
];
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BROWSER_PROBE = `
import { access, constants } from "node:fs/promises";
import { chromium } from "playwright-core";
const executablePath = chromium.executablePath();
try { await access(executablePath, constants.X_OK); }
catch { process.stdout.write(JSON.stringify({ found: false, executablePath }) + "\\n"); process.exit(0); }
let missingLaunchExecutable = false;
if (process.argv.includes("--launch")) {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
  } catch (error) {
    const detail = String(error?.message ?? "");
    if (error?.code === "ENOENT" || /Executable doesn't exist at|spawn .* ENOENT/iu.test(detail)) {
      missingLaunchExecutable = true;
    } else throw error;
  }
}
process.stdout.write(JSON.stringify({ found: true, executablePath, missingLaunchExecutable }) + "\\n");
`;

function runtimeChildEnvironment(browserDirectory, env = process.env) {
  return {
    ...env,
    PLAYWRIGHT_BROWSERS_PATH: browserDirectory,
    PLAYWRIGHT_SKIP_BROWSER_GC: "1",
  };
}

function runCaptured(command, args, options) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveProcess({ code, signal, stdout, stderr }));
  });
}

async function probeBrowser(runtimeRoot, browserDirectory, { launch = false } = {}) {
  const result = await runCaptured(
    process.execPath,
    ["--input-type=module", "--eval", BROWSER_PROBE, ...(launch ? ["--", "--launch"] : [])],
    { cwd: runtimeRoot, env: runtimeChildEnvironment(browserDirectory) },
  );
  if (result.code !== 0 || result.signal) {
    throw new Error(launch
      ? "Headless Chromium could not be launched and closed."
      : "The Playwright Chromium executable could not be checked.");
  }
  try {
    const probe = JSON.parse(result.stdout.trim());
    if (typeof probe.found !== "boolean" || typeof probe.executablePath !== "string") throw new Error();
    return probe;
  } catch {
    throw new Error("The Playwright Chromium executable could not be checked.");
  }
}

async function installSharedChromium(runtimeRoot, browserDirectory, env = process.env) {
  const before = await probeBrowser(runtimeRoot, browserDirectory);
  const install = async () => {
    const cli = join(runtimeRoot, "node_modules", "playwright-core", "cli.js");
    if (!(await lstat(cli)).isFile()) throw new Error("The prepared runtime is missing the Playwright CLI.");
    await new Promise((resolveInstall, reject) => {
      const child = spawn(process.execPath, [cli, "install", "chromium"], {
        cwd: runtimeRoot,
        env: runtimeChildEnvironment(browserDirectory, env),
        stdio: ["ignore", process.stderr, process.stderr],
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0
        ? resolveInstall()
        : reject(new Error(`Shared Chromium installation failed (${signal ?? code}).`)));
    });
  };
  if (!before.found) await install();
  const after = await probeBrowser(runtimeRoot, browserDirectory);
  if (!after.found) throw new Error("Shared Chromium installation did not produce its expected executable.");
  let launchResult = await probeBrowser(runtimeRoot, browserDirectory, { launch: true });
  if (launchResult.missingLaunchExecutable) {
    // Playwright keeps the headless shell separately from the full Chromium executable.
    // Repair a partial shared cache once when launch identifies that missing binary.
    await install();
    const repaired = await probeBrowser(runtimeRoot, browserDirectory);
    if (!repaired.found) throw new Error("Shared Chromium installation did not produce its expected executable.");
    launchResult = await probeBrowser(runtimeRoot, browserDirectory, { launch: true });
    if (launchResult.missingLaunchExecutable) throw new Error("Shared Chromium installation did not produce its headless executable.");
  }
}

async function snapshot(sourceRoot) {
  const files = [...ROOT_FILES, ...SCRIPT_FILES.map((name) => `scripts/${name}`)];
  for (const [directory, extension] of [["server", ".mjs"], ["ui", ".html"]]) {
    for (const entry of await readdir(join(sourceRoot, directory), { withFileTypes: true })) {
      if (!entry.name.endsWith(extension)) continue;
      if (!entry.isFile()) throw new Error("Runtime source must contain regular files.");
      files.push(`${directory}/${entry.name}`);
    }
  }
  const entries = [];
  const hash = createHash("sha256");
  for (const name of files.sort()) {
    if (!(await lstat(join(sourceRoot, name))).isFile()) throw new Error("Runtime source must contain regular files.");
    const data = await readFile(join(sourceRoot, name));
    hash.update(name).update("\0").update(String(data.length)).update("\0").update(data);
    entries.push([name, data]);
  }
  const version = JSON.parse(entries.find(([name]) => name === "package.json")[1].toString()).version;
  if (typeof version !== "string" || !/^[a-z0-9][a-z0-9.+-]*$/iu.test(version)) throw new Error("Invalid runtime version.");
  const digest = hash.digest("hex");
  return { entries, identity: `${version}-${digest}`, digest, version };
}

async function canonicalDirectory(directory) {
  let current = resolve(directory);
  const missing = [];
  while (true) {
    try { return join(await realpath(current), ...missing.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

export async function runtimeTarget({
  sourceRoot = SOURCE_ROOT,
  runtimeDirectory = defaultRuntimeDirectory(),
  browsersDirectory = defaultBrowsersDirectory(),
} = {}) {
  if (!isAbsolute(runtimeDirectory)) throw new Error("Runtime directory must be absolute and outside the plugin/cache tree.");
  if (!isAbsolute(browsersDirectory)) throw new Error("Browser directory must be an absolute path.");
  const base = await canonicalDirectory(runtimeDirectory);
  const browserBase = await canonicalDirectory(browsersDirectory);
  const canonicalSource = await canonicalDirectory(sourceRoot);
  const insideSource = relative(canonicalSource, base);
  const insideBrowserSource = relative(canonicalSource, browserBase);
  const isInsideSource = (relativePath) => relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  const isPluginCache = (directory) => /(?:^|[/\\])plugins[/\\]cache(?:[/\\]|$)/iu.test(directory);
  if (isInsideSource(insideSource) || isInsideSource(insideBrowserSource)
    || isPluginCache(base) || isPluginCache(browserBase)
    || (process.platform === "win32" && (!/^[a-z]:[\\/]/iu.test(base) || !/^[a-z]:[\\/]/iu.test(browserBase)))) {
    throw new Error("Runtime directory must be absolute and outside the plugin/cache tree.");
  }
  const source = await snapshot(sourceRoot);
  return { ...source, root: join(base, source.identity), base, browsersDirectory: browserBase };
}

async function verifyRuntimeFiles(target) {
  try {
    const marker = JSON.parse(await readFile(join(target.root, READY_MARKER), "utf8"));
    if (marker.identity !== target.identity || marker.schemaVersion !== 1) return false;
    if ((await snapshot(target.root)).identity !== target.identity) return false;
    await access(join(target.root, "server/server.mjs"), constants.R_OK);
    return (await checkDependencies(target.root, {
      env: runtimeChildEnvironment(target.browsersDirectory),
    })).ok;
  } catch { return false; }
}

export async function verifyRuntime(target) {
  try {
    if (!(await verifyRuntimeFiles(target))) return false;
    return (await probeBrowser(target.root, target.browsersDirectory)).found;
  } catch { return false; }
}

async function installDependencies(root, npmCli, browserDirectory) {
  if (typeof npmCli !== "string" || !isAbsolute(npmCli) || !(await lstat(npmCli)).isFile()) throw new Error("--npm-cli must name an absolute npm CLI JavaScript file.");
  await new Promise((resolveInstall, reject) => {
    const child = spawn(process.execPath, [npmCli, "ci", "--ignore-scripts", "--prefix", root], {
      cwd: root,
      env: runtimeChildEnvironment(browserDirectory),
      stdio: ["ignore", process.stderr, process.stderr],
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveInstall() : reject(new Error(`Runtime dependency installation failed (${signal ?? code}).`)));
  });
}

async function acquirePreparationLock(target, lockPath) {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
      finally { await handle.close(); }
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await verifyRuntime(target)) return false;
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("Malformed preparation lock.");
        try { process.kill(owner.pid, 0); }
        catch (checkError) { if (checkError.code === "ESRCH") await rm(lockPath, { force: true }); }
      } catch {
        // A crash between exclusive creation and writing the PID can leave an empty lock.
        // Recheck file identity/content before reclaiming a sufficiently old malformed file.
        try {
          const before = await lstat(lockPath);
          const content = await readFile(lockPath, "utf8");
          let malformed = false;
          try { const owner = JSON.parse(content); malformed = !Number.isSafeInteger(owner.pid) || owner.pid <= 0; }
          catch { malformed = true; }
          if (malformed && Date.now() - before.mtimeMs > 5_000) {
            const after = await lstat(lockPath);
            if (before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs && before.size === after.size && content === await readFile(lockPath, "utf8")) {
              await rm(lockPath, { force: true });
            }
          }
        } catch { /* A concurrent preparer may have completed or removed the lock. */ }
      }
      if (Date.now() >= deadline) throw new Error("Runtime preparation is busy; retry after the current preparation finishes.");
      await delay(100);
    }
  }
}

/** Explicit preparation is the only operation that may invoke npm/network access. */
export async function prepareRuntime(target, {
  npmCli,
  prepareBrowser = ({ runtimeRoot, browsersDirectory, env }) => installSharedChromium(runtimeRoot, browsersDirectory, env),
} = {}) {
  const prepareSharedBrowser = (runtimeRoot) => prepareBrowser({
    runtimeRoot,
    browsersDirectory: target.browsersDirectory,
    env: runtimeChildEnvironment(target.browsersDirectory),
  });
  await mkdir(target.base, { recursive: true });
  const lockPath = join(target.base, `.prepare-${target.identity}.lock`);
  if (!(await acquirePreparationLock(target, lockPath))) {
    await prepareSharedBrowser(target.root);
    return target.root;
  }
  const staging = join(target.base, `.staging-${target.identity}-${randomUUID()}`);
  try {
    // A published runtime can stay valid when the separately shared browser cache is
    // removed, so repair the browser without repeating npm ci in that case.
    if (await verifyRuntimeFiles(target)) {
      await prepareSharedBrowser(target.root);
      return target.root;
    }
    await mkdir(staging);
    for (const [name, data] of target.entries) {
      await mkdir(dirname(join(staging, name)), { recursive: true });
      await writeFile(join(staging, name), data);
    }
    await installDependencies(staging, npmCli, target.browsersDirectory);
    const childEnv = runtimeChildEnvironment(target.browsersDirectory);
    if (!(await checkDependencies(staging, { env: childEnv })).ok) throw new Error("Prepared runtime dependency imports failed; runtime was not published.");
    await prepareSharedBrowser(staging);
    await writeFile(join(staging, READY_MARKER), JSON.stringify({ schemaVersion: 1, identity: target.identity }));
    // Retire only this generated runtime, never operational config or browser profiles.
    const retired = join(target.base, `.retired-${target.identity}-${randomUUID()}`);
    let hadRetired = false;
    try { await rename(target.root, retired); hadRetired = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    try { await rename(staging, target.root); }
    catch (error) {
      if (hadRetired) await rename(retired, target.root).catch(() => {});
      throw new Error("Runtime publication failed; prepare again.", { cause: error });
    }
    if (hadRetired) await rm(retired, { recursive: true, force: true }).catch(() => {});
    return target.root;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(lockPath, { force: true });
  }
}

export async function launchRuntime(target) {
  if (!(await verifyRuntime(target))) throw new Error("Matching persistent runtime is not prepared or its dependencies are unavailable. Run setup with --prepare --npm-cli <absolute npm CLI path>.");
  const child = spawn(process.execPath, [join(target.root, "server/server.mjs")], {
    cwd: target.root,
    env: runtimeChildEnvironment(target.browsersDirectory),
    stdio: "inherit",
    windowsHide: true,
  });
  const signals = ["SIGINT", "SIGTERM"];
  const forward = new Map(signals.map((signal) => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of forward) process.on(signal, handler);
  try {
    const result = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    if (result.signal) {
      for (const [signal, handler] of forward) process.off(signal, handler);
      process.kill(process.pid, result.signal);
    } else process.exitCode = result.code ?? 1;
  } finally { for (const [signal, handler] of forward) process.off(signal, handler); }
}

async function runAllowedScript(target, name, groupKey) {
  if (name === "auth") {
    if (!(await verifyRuntime(target))) {
      throw new Error("Matching persistent runtime and shared Chromium are not prepared. Run setup with --prepare.");
    }
    const child = spawn(process.execPath, [join(target.root, "scripts/zawazawa-auth.mjs"), groupKey], {
      cwd: target.root,
      env: runtimeChildEnvironment(target.browsersDirectory),
      stdio: "inherit",
      windowsHide: true,
    });
    await forwardChildResult(child);
    return;
  }
  if (name === "diagnose") {
    const prepared = await verifyRuntimeFiles(target);
    const scriptRoot = prepared ? target.root : SOURCE_ROOT;
    const env = runtimeChildEnvironment(target.browsersDirectory);
    if (prepared) env.ZAWAZAWA_DIAGNOSTIC_DIRECT_SERVER = "1";
    const child = spawn(process.execPath, [join(scriptRoot, "scripts/diagnose-mcp.mjs")], {
      cwd: scriptRoot,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    await forwardChildResult(child);
    return;
  }
  if (name === "register" || name === "unregister") {
    const ready = name === "unregister"
      ? await verifyRuntimeFiles(target)
      : await verifyRuntime(target);
    if (!ready) {
      throw new Error(name === "unregister"
        ? "Matching persistent runtime and dependencies are not prepared. Run setup with --prepare."
        : "Matching persistent runtime and shared Chromium are not prepared. Run setup with --prepare.");
    }
    const helperArguments = name === "unregister" ? ["--remove"] : [];
    const child = spawn(process.execPath, [join(target.root, "scripts/register-mcp.mjs"), ...helperArguments], {
      cwd: target.root,
      env: runtimeChildEnvironment(target.browsersDirectory),
      stdio: "inherit",
      windowsHide: true,
    });
    await forwardChildResult(child);
    return;
  }
  throw new Error("Unsupported utility script.");
}

async function forwardChildResult(child) {
  const signals = ["SIGINT", "SIGTERM"];
  const forward = new Map(signals.map((signal) => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of forward) process.on(signal, handler);
  try {
    const result = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    if (result.signal) {
      for (const [signal, handler] of forward) process.off(signal, handler);
      process.kill(process.pid, result.signal);
    } else process.exitCode = result.code ?? 1;
  } finally {
    for (const [signal, handler] of forward) process.off(signal, handler);
  }
}

async function main(args) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node.js 24 or newer is required.");
  let prepare = false;
  let printRoot = false;
  let npmCli;
  let runScript;
  let scriptArguments = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--prepare") prepare = true;
    else if (arg === "--print-root") printRoot = true;
    else if (arg === "--npm-cli" && args[index + 1]) npmCli = args[++index];
    else if (arg === "--run-script" && args[index + 1]) {
      if (runScript) throw new Error("Only one utility script may be selected.");
      runScript = args[++index];
      if (runScript === "auth" && args[index + 1]) scriptArguments = [args[++index]];
      else if (!["diagnose", "auth", "register", "unregister"].includes(runScript)) throw new Error("Unsupported utility script.");
    }
    else throw new Error("Unknown runtime launcher argument.");
  }
  if (runScript && (prepare || printRoot || npmCli)) throw new Error("Utility scripts cannot be combined with runtime preparation or inspection.");
  if (runScript === "auth" && (scriptArguments.length !== 1 || scriptArguments[0].startsWith("--"))) throw new Error("The auth utility requires one group key.");
  if (runScript === "diagnose" && scriptArguments.length !== 0) throw new Error("The diagnose utility accepts no arguments.");
  if (runScript === "register" && scriptArguments.length !== 0) throw new Error("The register utility accepts no arguments.");
  if (runScript === "unregister" && scriptArguments.length !== 0) throw new Error("The unregister utility accepts no arguments.");
  if (prepare !== Boolean(npmCli)) throw new Error("--prepare requires --npm-cli <absolute npm CLI path>.");
  const target = await runtimeTarget();
  if (runScript) {
    await runAllowedScript(target, runScript, scriptArguments[0]);
    return;
  }
  if (prepare) {
    await prepareRuntime(target, { npmCli });
    process.stderr.write("Persistent runtime prepared.\n");
  }
  if (printRoot) {
    if (!(await verifyRuntime(target))) throw new Error("Matching persistent runtime is not prepared.");
    process.stdout.write(`${target.root}\n`);
  } else if (!prepare) await launchRuntime(target);
}

if (process.argv[1] && pathToFileURL(await realpath(resolve(process.argv[1]))).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    // No dependency/npm output ever goes to MCP stdout.
    process.stderr.write(`ZAWAZAWA runtime: ${error.message}\n`);
    process.exitCode = 1;
  });
}
