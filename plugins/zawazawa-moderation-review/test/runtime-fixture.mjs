import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const source = await runtimeTarget({ sourceRoot: pluginRoot, runtimeDirectory });
  for (const [name, data] of source.entries) {
    await mkdir(dirname(join(sourceRoot, name)), { recursive: true });
    await writeFile(join(sourceRoot, name), data);
  }
  const npmCli = join(directory, "fixture-npm-cli.mjs");
  await writeFile(npmCli, `import { cp, realpath } from "node:fs/promises";
import assert from "node:assert/strict";
assert.deepEqual(process.argv.slice(2, 5), ["ci", "--ignore-scripts", "--prefix"]);
assert.equal(await realpath(process.argv[5]), await realpath(process.cwd()));
process.stdout.write("fixture npm progress\\n");
await cp(${JSON.stringify(join(pluginRoot, "node_modules"))}, "node_modules", { recursive: true });\n`);
  const target = await runtimeTarget({ sourceRoot, runtimeDirectory });
  if (prepare) await prepareRuntime(target, { npmCli });
  return { directory, sourceRoot, runtimeDirectory, target, npmCli,
    env: { ...process.env, ZAWAZAWA_RUNTIME_DIR: runtimeDirectory,
      ZAWAZAWA_REVIEW_STORE_DIR: join(directory, "reviews"),
      ZAWAZAWA_CONNECTOR_PROFILE_DIR: join(directory, "profile") } };
}
