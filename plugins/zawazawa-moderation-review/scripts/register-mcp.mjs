#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { defaultBrowsersDirectory } from "../server/platform-paths.mjs";

const NAME = "zawazawa_moderation_review";
const BEGIN = "# BEGIN ZAWAZAWA managed MCP registration";
const END = "# END ZAWAZAWA managed MCP registration";
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function failure(code) { return Object.assign(new Error(code), { code }); }
async function acquireLock(path) {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
      catch (error) { await handle.close(); await rm(path, { force: true }); throw error; }
      return handle;
    } catch (error) {
      if (error.code !== "EEXIST") throw failure("CODEX_CONFIG_BUSY");
      try {
        const before = await lstat(path);
        const content = await readFile(path, "utf8");
        let stale = false;
        try {
          const pid = JSON.parse(content).pid;
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error();
          try { process.kill(pid, 0); } catch (check) { stale = check.code === "ESRCH"; }
        } catch { stale = Date.now() - before.mtimeMs > 5_000; }
        const after = await lstat(path);
        if (stale && before.ino === after.ino && before.dev === after.dev && before.mtimeMs === after.mtimeMs && content === await readFile(path, "utf8")) await rm(path, { force: true });
      } catch { /* The current writer may have released the lock. */ }
      if (Date.now() >= deadline) throw failure("CODEX_CONFIG_BUSY");
      await delay(50);
    }
  }
}
function withoutManagedBlock(text) {
  const lines = text.split(/(?<=\n)/u);
  const start = lines.findIndex((line) => line.trim() === BEGIN);
  const end = lines.findIndex((line) => line.trim() === END);
  if (start === -1 && end === -1) return { remainder: text, block: null };
  if (start === -1 || end < start || lines.filter((line) => line.trim() === BEGIN || line.trim() === END).length !== 2) {
    throw failure("REGISTRATION_MARKERS_INVALID");
  }
  return { remainder: lines.slice(0, start).join("") + lines.slice(end + 1).join(""), block: lines.slice(start, end + 1).join("") };
}
function validateToml(text) {
  try { return parse(text); } catch { throw failure("CODEX_CONFIG_INVALID"); }
}
function registration(nodePath, root, browsers) {
  if (![nodePath, root, browsers].every(isAbsolute)) throw failure("REGISTRATION_PATH_INVALID");
  const quote = JSON.stringify;
  const body = `[mcp_servers.${NAME}]\ncommand = ${quote(nodePath)}\nargs = [${quote(join(root, "server", "server.mjs"))}]\ncwd = ${quote(root)}\ntool_timeout_sec = 300\nenv = { PLAYWRIGHT_BROWSERS_PATH = ${quote(browsers)}, PLAYWRIGHT_SKIP_BROWSER_GC = "1" }\n`;
  const digest = createHash("sha256").update(body).digest("hex");
  return `${BEGIN}\n# managed-body-sha256: ${digest}\n${body}${END}\n`;
}

/** Preserve all user text outside the explicitly managed block; never replace a manual server. */
export function updateRegistration(text, { remove = false, nodePath = process.execPath, root = runtimeRoot, browsers = defaultBrowsersDirectory() } = {}) {
  const original = validateToml(text);
  const { remainder, block } = withoutManagedBlock(text);
  const remaining = validateToml(remainder);
  if ([NAME, "zawazawa-moderation-review"].some((name) => remaining.mcp_servers?.[name] !== undefined)) throw failure("MCP_REGISTRATION_CONFLICT");
  if (block && original.mcp_servers?.[NAME] === undefined) throw failure("REGISTRATION_MARKERS_INVALID");
  if (block) {
    const normalized = block.replaceAll("\r\n", "\n");
    const lines = normalized.split("\n");
    const expected = /^# managed-body-sha256: ([a-f0-9]{64})$/u.exec(lines[1])?.[1];
    const end = lines.findIndex((line) => line === END);
    const body = lines.slice(2, end).join("\n") + "\n";
    if (!expected || createHash("sha256").update(body).digest("hex") !== expected) throw failure("MANAGED_REGISTRATION_EDITED");
  }
  if (remove) return { text: remainder, status: block ? "removed" : "not_registered" };
  const desiredBlock = registration(nodePath, root, browsers);
  const desired = remainder + (remainder.endsWith("\n") || !remainder ? "" : "\n") + desiredBlock;
  validateToml(desired);
  // Comparison by managed content avoids moving the block or changing surrounding comments on re-run.
  if (block === desiredBlock) return { text, status: "unchanged" };
  return { text: desired, status: "registered" };
}

export async function registerMcp({ configPath, ...options } = {}) {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  let path = configPath ?? join(home, "config.toml");
  if (!isAbsolute(path)) throw failure("CODEX_CONFIG_PATH_INVALID");
  // Retain a user's dotfile symlink rather than replacing it.
  path = await realpath(path).catch((error) => { if (error.code === "ENOENT") return path; throw error; });
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.zawazawa-registration.lock`;
  const lock = await acquireLock(lockPath);
  const temporary = `${path}.zawazawa-${randomUUID()}.tmp`;
  try {
    const read = async () => readFile(path, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    const before = await read();
    const result = updateRegistration(before, options);
    if (result.text === before) return { status: result.status };
    await writeFile(temporary, result.text, { mode: 0o600 });
    if (await read() !== before) throw failure("CODEX_CONFIG_CHANGED");
    await rename(temporary, path);
    return { status: result.status };
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

const invoked = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 1 || args[0] !== "--remove")) throw failure("REGISTRATION_ARGUMENT_INVALID");
    process.stdout.write(`${JSON.stringify(await registerMcp({ remove: args[0] === "--remove" }))}\n`);
  } catch (error) {
    const code = /^[A-Z_]+$/u.test(error?.code ?? "") ? error.code : "REGISTRATION_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "failure", errorCategory: code })}\n`);
    process.exitCode = 1;
  }
}
