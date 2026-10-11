import assert from "node:assert/strict";
import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isMainModule } from "../server/script-entry.mjs";

test("main module detection compares file identity across aliases", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zawazawa-script-entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, "entry.mjs");
  const alias = join(directory, "alias.mjs");
  const other = join(directory, "other.mjs");
  await writeFile(entry, "export const fixture = true;\n");
  await writeFile(other, "export const fixture = true;\n");
  await link(entry, alias);
  const url = pathToFileURL(entry);
  assert.equal(await isMainModule(url, [process.execPath, entry]), true);
  assert.equal(await isMainModule(url, [process.execPath, alias]), true);
  assert.equal(await isMainModule(url, [process.execPath, other]), false);
  assert.equal(await isMainModule(url, [process.execPath, join(directory, "missing.mjs")]), false);
  assert.equal(await isMainModule(url, [process.execPath]), false);
  if (process.platform === "win32") {
    assert.equal(await isMainModule(url, [process.execPath, entry.toUpperCase()]), true);
    // Windows CI's tmpdir may itself use an 8.3 short name; the URL can use a long name.
    const { realpath } = await import("node:fs/promises");
    assert.equal(await isMainModule(pathToFileURL(await realpath(entry)), [process.execPath, entry]), true);
  }
});
