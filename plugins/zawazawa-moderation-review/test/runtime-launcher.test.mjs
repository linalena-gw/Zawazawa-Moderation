import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { READY_MARKER, prepareRuntime, runtimeTarget, verifyRuntime } from "../scripts/runtime-launcher.mjs";
import { createRuntimeFixture } from "./runtime-fixture.mjs";
const run = promisify(execFile);
const launcher = (fixture) => join(fixture.sourceRoot, "scripts/runtime-launcher.mjs");
test("registered absolute paths start MCP even while the plugin cache is absent", async (t) => {
  const fixture = await createRuntimeFixture(t);
  await run(process.execPath, [launcher(fixture), "--run-script", "register"], { env: fixture.env });
  const config = parseToml(await readFile(join(fixture.env.CODEX_HOME, "config.toml"), "utf8"));
  const server = config.mcp_servers.zawazawa_moderation_review;
  await rm(fixture.sourceRoot, { recursive: true });
  const client = new Client({ name: "registered-runtime-fixture", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: server.command, args: server.args, cwd: server.cwd,
    env: { ...fixture.env, ...server.env }, stderr: "pipe",
  });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 15);
  } finally { await client.close(); }
});
test("runtime aliases cannot redirect persistent code into source or cache", async (t) => {
  const fixture = await createRuntimeFixture(t, { prepare: false });
  const alias = join(fixture.directory, "source-alias");
  await symlink(fixture.sourceRoot, alias, "junction");
  await assert.rejects(runtimeTarget({ sourceRoot: fixture.sourceRoot, runtimeDirectory: join(alias, "missing", "runtime") }), /outside/u);
  const cache = join(fixture.directory, "plugins", "cache");
  await mkdir(cache, { recursive: true });
  const cacheAlias = join(fixture.directory, "cache-alias");
  await symlink(cache, cacheAlias, "junction");
  await assert.rejects(runtimeTarget({ sourceRoot: fixture.sourceRoot, runtimeDirectory: join(cacheAlias, "missing", "runtime") }), /outside/u);
});
test("preparation reclaims a stale malformed lock left by a crashed creator", async (t) => {
  const fixture = await createRuntimeFixture(t, { prepare: false });
  await mkdir(fixture.target.base, { recursive: true });
  const lock = join(fixture.target.base, `.prepare-${fixture.target.identity}.lock`);
  await writeFile(lock, "");
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  await prepareRuntime(fixture.target, { npmCli: fixture.npmCli });
  assert.equal(await verifyRuntime(fixture.target), true);
  await assert.rejects(access(lock));
});
test("unprepared launch fails with empty stdout and never installs", async (t) => {
  const fixture = await createRuntimeFixture(t, { prepare: false });
  await assert.rejects(run(process.execPath, [launcher(fixture)], { env: fixture.env }), (error) => {
    assert.equal(error.stdout, ""); assert.match(error.stderr, /not prepared/u); return true;
  });
  await assert.rejects(access(fixture.target.root));
});
test("explicit preparation checks imports and keeps npm output off stdout", async (t) => {
  const fixture = await createRuntimeFixture(t, { prepare: false });
  const result = await run(process.execPath, [launcher(fixture), "--prepare", "--npm-cli", fixture.npmCli, "--print-root"], { env: fixture.env });
  assert.equal(result.stdout, `${fixture.target.root}\n`);
  assert.match(result.stderr, /fixture npm progress/u);
  assert.equal(await verifyRuntime(fixture.target), true);
  assert.equal(JSON.parse(await readFile(join(fixture.target.root, READY_MARKER), "utf8")).identity, fixture.target.identity);
  const repeated = await run(process.execPath, [launcher(fixture), "--prepare", "--npm-cli", fixture.npmCli], { env: fixture.env });
  assert.equal(repeated.stdout, ""); assert.doesNotMatch(repeated.stderr, /fixture npm progress/u);
});
test("preparation repairs a deleted shared browser without reinstalling runtime dependencies", async (t) => {
  const fixture = await createRuntimeFixture(t);
  await rm(fixture.browsersDirectory, { recursive: true, force: true });
  const result = await run(process.execPath, [launcher(fixture), "--prepare", "--npm-cli", fixture.npmCli], { env: fixture.env });
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /fixture npm progress/u);
  assert.match(result.stderr, /fixture browser install/u);
  assert.equal(await verifyRuntime(fixture.target), true);
});
test("preparation repairs a missing headless shell when the full Chromium executable remains", async (t) => {
  const fixture = await createRuntimeFixture(t);
  await rm(join(fixture.browsersDirectory, "chromium-fixture", "headless-shell"));
  const result = await run(process.execPath, [launcher(fixture), "--prepare", "--npm-cli", fixture.npmCli], { env: fixture.env });
  assert.doesNotMatch(result.stderr, /fixture npm progress/u);
  assert.match(result.stderr, /fixture browser install/u);
  assert.equal(await verifyRuntime(fixture.target), true);
});
test("failed imports never publish an incomplete runtime", async (t) => {
  const fixture = await createRuntimeFixture(t, { prepare: false });
  await writeFile(fixture.npmCli, "process.stdout.write('installation without modules\\n');");
  await assert.rejects(prepareRuntime(fixture.target, { npmCli: fixture.npmCli }), /dependency imports failed/u);
  await assert.rejects(access(fixture.target.root));
});
test("identity changes for lockfile and runtime code", async (t) => {
  const fixture = await createRuntimeFixture(t, { prepare: false });
  await writeFile(join(fixture.sourceRoot, "package-lock.json"), `${await readFile(join(fixture.sourceRoot, "package-lock.json"), "utf8")}\n`);
  const lockChanged = await runtimeTarget(fixture);
  assert.notEqual(lockChanged.identity, fixture.target.identity);
  await writeFile(join(fixture.sourceRoot, "server/server.mjs"), `${await readFile(join(fixture.sourceRoot, "server/server.mjs"), "utf8")}\n`);
  assert.notEqual((await runtimeTarget(fixture)).identity, lockChanged.identity);
});
test("concurrent preparation publishes immutable complete runtime; missing dependency invalidates it", async (t) => {
  const fixture = await createRuntimeFixture(t, { prepare: false });
  const roots = await Promise.all([prepareRuntime(fixture.target, { npmCli: fixture.npmCli }), prepareRuntime(fixture.target, { npmCli: fixture.npmCli })]);
  assert.deepEqual(roots, [fixture.target.root, fixture.target.root]);
  assert.equal(await verifyRuntime(fixture.target), true);
  await rm(join(fixture.target.root, "node_modules/zod"), { recursive: true });
  assert.equal(await verifyRuntime(fixture.target), false);
  await prepareRuntime(fixture.target, { npmCli: fixture.npmCli });
  assert.equal(await verifyRuntime(fixture.target), true);
});
test("manifest exposes identical tools after cache deletion and recreation without dependencies", async (t) => {
  const fixture = await createRuntimeFixture(t);
  const tools = async () => {
    const config = JSON.parse(await readFile(join(fixture.sourceRoot, "mcp.runtime.json"), "utf8")).mcpServers["zawazawa-moderation-review"];
    const transport = new StdioClientTransport({ command: process.execPath, args: config.args, cwd: fixture.sourceRoot, env: fixture.env, stderr: "pipe" });
    const client = new Client({ name: "runtime-lifecycle-fixture", version: "1.0.0" });
    try { await client.connect(transport); return (await client.listTools()).tools.map((tool) => tool.name).sort(); }
    finally { await client.close(); }
  };
  const before = await tools(); assert.ok(before.length > 0);
  const restoredCache = join(fixture.directory, "restored-cache");
  await cp(fixture.sourceRoot, restoredCache, { recursive: true });
  await rm(fixture.sourceRoot, { recursive: true });
  await cp(restoredCache, fixture.sourceRoot, { recursive: true });
  await assert.rejects(access(join(fixture.sourceRoot, "node_modules")));
  assert.deepEqual(await tools(), before);
});

test("runtime CLI dispatches only approved utilities with dedicated child environments", async (t) => {
  const fixture = await createRuntimeFixture(t);
  const auth = await run(process.execPath, [launcher(fixture), "--run-script", "auth", "fixture_group"], { env: fixture.env });
  assert.match(auth.stdout, /専用ブラウザ/u);
  const diagnostic = await run(process.execPath, [launcher(fixture), "--run-script", "diagnose"], { env: fixture.env });
  assert.equal(typeof JSON.parse(diagnostic.stdout).result, "string");
  const registered = await run(process.execPath, [launcher(fixture), "--run-script", "register"], { env: fixture.env });
  assert.deepEqual(JSON.parse(registered.stdout), { status: "registered" });
  const codexConfig = join(fixture.directory, "codex", "config.toml");
  const registration = await readFile(codexConfig, "utf8");
  assert.ok(registration.includes(join(fixture.target.root, "server/server.mjs")));
  assert.ok(registration.includes(fixture.browsersDirectory));
  const repeatedRegistration = await run(process.execPath, [launcher(fixture), "--run-script", "register"], { env: fixture.env });
  assert.deepEqual(JSON.parse(repeatedRegistration.stdout), { status: "unchanged" });
  await rm(fixture.browsersDirectory, { recursive: true, force: true });
  const unregistered = await run(process.execPath, [launcher(fixture), "--run-script", "unregister"], { env: fixture.env });
  assert.deepEqual(JSON.parse(unregistered.stdout), { status: "removed" });
  await assert.rejects(access(join(fixture.browsersDirectory, "chromium-fixture", "chrome")));
  assert.equal((await readFile(codexConfig, "utf8")).trim(), "");
  await assert.rejects(
    run(process.execPath, [launcher(fixture), "--run-script", "arbitrary"], { env: fixture.env }),
    (error) => { assert.match(error.stderr, /Unsupported utility script/u); return true; },
  );
});
