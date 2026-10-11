import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRuntime, runtimeTarget } from "../scripts/runtime-launcher.mjs";
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function createRuntimeFixture(t, { prepare = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zawazawa-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, "cache", "plugin");
  const runtimeDirectory = join(directory, "persistent", "runtimes");
  const browserPath = join(directory, "persistent", "browsers");
  await mkdir(browserPath, { recursive: true });
  const browsersDirectory = await realpath(browserPath);
  const source = await runtimeTarget({ sourceRoot: pluginRoot, runtimeDirectory, browsersDirectory });
  for (const [name, data] of source.entries) {
    await mkdir(dirname(join(sourceRoot, name)), { recursive: true });
    await writeFile(join(sourceRoot, name), data);
  }
  const npmCli = join(directory, "fixture-npm-cli.mjs");
  await writeFile(npmCli, `import { cp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
assert.deepEqual(process.argv.slice(2, 5), ["ci", "--ignore-scripts", "--prefix"]);
assert.equal(await realpath(process.argv[5]), await realpath(process.cwd()));
assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, ${JSON.stringify(browsersDirectory)});
assert.equal(process.env.PLAYWRIGHT_SKIP_BROWSER_GC, "1");
process.stdout.write("fixture npm progress\\n");
await cp(${JSON.stringify(join(pluginRoot, "node_modules"))}, "node_modules", { recursive: true });
await rm("node_modules/playwright-core", { recursive: true, force: true });
await mkdir("node_modules/playwright-core", { recursive: true });
await writeFile("node_modules/playwright-core/package.json", JSON.stringify({ name: "playwright-core", version: "1.0.0", type: "module", exports: "./index.mjs" }));
await writeFile("node_modules/playwright-core/index.mjs", \`import { access } from "node:fs/promises";
import { resolve } from "node:path";
export const chromium = {
  executablePath() { return resolve(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium-fixture", "chrome"); },
  async launch() {
    await access(this.executablePath());
    await access(resolve(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium-fixture", "headless-shell"));
    return { close: async () => {} };
  },
  async launchPersistentContext(profileDirectory, options) {
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH || process.env.PLAYWRIGHT_SKIP_BROWSER_GC !== "1") throw new Error("Dedicated browser cache environment is missing.");
    if (!profileDirectory || options.headless !== false) throw new Error("Interactive auth context was not configured.");
    return {
      pages() { return []; },
      async newPage() { return { async goto() { return { status: () => 200 }; } }; },
      once(event, callback) { if (event === "close") queueMicrotask(callback); return this; },
    };
  },
};\`);
await writeFile("node_modules/playwright-core/cli.js", \`import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
assert.deepEqual(process.argv.slice(2), ["install", "chromium"]);
const executable = resolve(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium-fixture", "chrome");
await mkdir(dirname(executable), { recursive: true });
await writeFile(executable, "fixture browser", { mode: 0o755 });
await writeFile(resolve(dirname(executable), "headless-shell"), "fixture headless shell", { mode: 0o755 });
process.stderr.write("fixture browser install" + String.fromCharCode(10));\`);
`);
  const target = await runtimeTarget({ sourceRoot, runtimeDirectory, browsersDirectory });
  if (prepare) await prepareRuntime(target, { npmCli });
  return { directory, sourceRoot, runtimeDirectory, browsersDirectory, target, npmCli,
    env: { ...process.env, ZAWAZAWA_RUNTIME_DIR: runtimeDirectory,
      CODEX_HOME: join(directory, "codex"),
      PLAYWRIGHT_BROWSERS_PATH: browsersDirectory,
      PLAYWRIGHT_SKIP_BROWSER_GC: "1",
      ZAWAZAWA_REVIEW_STORE_DIR: join(directory, "reviews"),
      ZAWAZAWA_CONNECTOR_PROFILE_DIR: join(directory, "profile") } };
}
