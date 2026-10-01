import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(pluginRoot, "scripts", "zawazawa-auth.mjs");

test("認証スクリプトはグループキーの省略を拒否する", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /グループキーが必要/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /genshinwiki/u);
});

test("認証スクリプトは不正なグループキーをブラウザ起動前に拒否する", () => {
  const result = spawnSync(process.execPath, [script, "INVALID!"] , { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /形式が不正/u);
});
