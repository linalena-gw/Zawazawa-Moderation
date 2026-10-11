#!/usr/bin/env node
// This cache-resident bootstrap intentionally uses only Node built-ins.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, constants, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultRuntimeDirectory } from "../server/platform-paths.mjs";
import { checkDependencies } from "./check-dependencies.mjs";

export const READY_MARKER = ".runtime-ready.json";
const ROOT_FILES = ["package.json", "package-lock.json", ".mcp.json"];
const SCRIPT_FILES = ["runtime-launcher.mjs", "check-dependencies.mjs", "diagnose-mcp.mjs", "zawazawa-auth.mjs"];
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

export async function runtimeTarget({ sourceRoot = SOURCE_ROOT, runtimeDirectory = defaultRuntimeDirectory() } = {}) {
  if (!isAbsolute(runtimeDirectory)) throw new Error("Runtime directory must be absolute and outside the plugin/cache tree.");
  const base = await canonicalDirectory(runtimeDirectory);
  const canonicalSource = await canonicalDirectory(sourceRoot);
  const insideSource = relative(canonicalSource, base);
  if (insideSource === "" || (!insideSource.startsWith("..") && !isAbsolute(insideSource)) || /(?:^|[/\\])plugins[/\\]cache(?:[/\\]|$)/iu.test(base) || (process.platform === "win32" && !/^[a-z]:[\\/]/iu.test(base))) {
    throw new Error("Runtime directory must be absolute and outside the plugin/cache tree.");
  }
  const source = await snapshot(sourceRoot);
  return { ...source, root: join(base, source.identity), base };
}

export async function verifyRuntime(target) {
  try {
    const marker = JSON.parse(await readFile(join(target.root, READY_MARKER), "utf8"));
    if (marker.identity !== target.identity || marker.schemaVersion !== 1) return false;
    if ((await snapshot(target.root)).identity !== target.identity) return false;
    await access(join(target.root, "server/server.mjs"), constants.R_OK);
    return (await checkDependencies(target.root)).ok;
  } catch { return false; }
}

async function installDependencies(root, npmCli) {
  if (typeof npmCli !== "string" || !isAbsolute(npmCli) || !(await lstat(npmCli)).isFile()) throw new Error("--npm-cli must name an absolute npm CLI JavaScript file.");
  await new Promise((resolveInstall, reject) => {
    const child = spawn(process.execPath, [npmCli, "ci", "--ignore-scripts", "--prefix", root], {
      cwd: root, stdio: ["ignore", process.stderr, process.stderr], windowsHide: true,
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
export async function prepareRuntime(target, { npmCli } = {}) {
  if (await verifyRuntime(target)) return target.root;
  await mkdir(target.base, { recursive: true });
  const lockPath = join(target.base, `.prepare-${target.identity}.lock`);
  if (!(await acquirePreparationLock(target, lockPath))) return target.root;
  const staging = join(target.base, `.staging-${target.identity}-${randomUUID()}`);
  try {
    if (await verifyRuntime(target)) return target.root;
    await mkdir(staging);
    for (const [name, data] of target.entries) {
      await mkdir(dirname(join(staging, name)), { recursive: true });
      await writeFile(join(staging, name), data);
    }
    await installDependencies(staging, npmCli);
    if (!(await checkDependencies(staging)).ok) throw new Error("Prepared runtime dependency imports failed; runtime was not published.");
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
    cwd: target.root, stdio: "inherit", windowsHide: true,
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

async function main(args) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node.js 24 or newer is required.");
  let prepare = false;
  let printRoot = false;
  let npmCli;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--prepare") prepare = true;
    else if (arg === "--print-root") printRoot = true;
    else if (arg === "--npm-cli" && args[index + 1]) npmCli = args[++index];
    else throw new Error("Unknown runtime launcher argument.");
  }
  if (prepare !== Boolean(npmCli)) throw new Error("--prepare requires --npm-cli <absolute npm CLI path>.");
  const target = await runtimeTarget();
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
