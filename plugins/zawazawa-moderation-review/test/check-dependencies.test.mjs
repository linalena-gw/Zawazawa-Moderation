import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkDependencies } from "../scripts/check-dependencies.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("ancestor dependencies cannot hide an empty installed cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zawazawa-parent-dependencies-"));
  try {
    const installedRoot = join(directory, "installed-plugin");
    await mkdir(installedRoot);
    await symlink(join(pluginRoot, "node_modules"), join(directory, "node_modules"), "junction");
    const result = await checkDependencies(installedRoot);
    assert.equal(result.ok, false);
    assert.equal(result.category, "dependencies_missing");
    assert.equal(result.issues.length, 5);
    assert.ok(result.issues.every((issue) => issue.errorCode === "ENOENT" && issue.specifier.endsWith("/package.json")));
    assert.equal(JSON.stringify(result).includes(directory), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime dependency check imports the installed plugin entrypoints", async () => {
  assert.deepEqual(await checkDependencies(pluginRoot), {
    ok: true,
    category: "dependencies_available",
    issues: [],
  });
});

test("a matching package manifest cannot hide absent runtime entrypoints", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "zawazawa-dependency-check-"));
  try {
    await copyFile(join(pluginRoot, "package.json"), join(fixtureRoot, "package.json"));
    await copyFile(join(pluginRoot, "package-lock.json"), join(fixtureRoot, "package-lock.json"));
    const manifest = JSON.parse(await readFile(join(fixtureRoot, "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(join(fixtureRoot, "package-lock.json"), "utf8"));

    for (const packageName of Object.keys(manifest.dependencies)) {
      const version = lock.packages[`node_modules/${packageName}`]?.version;
      assert.ok(version, `lockfile has a version for ${packageName}`);
      const packageDirectory = join(fixtureRoot, "node_modules", ...packageName.split("/"));
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        join(packageDirectory, "package.json"),
        JSON.stringify({ name: packageName, version }),
      );
    }

    const result = await checkDependencies(fixtureRoot);
    assert.equal(result.ok, false);
    assert.equal(result.category, "dependencies_missing");
    assert.ok(result.issues.length > 0);
    assert.ok(result.issues.every((issue) => issue.errorCode === "ERR_MODULE_NOT_FOUND" || issue.errorCode === "MODULE_NOT_FOUND"));
    assert.equal(JSON.stringify(result).includes(fixtureRoot), false);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
