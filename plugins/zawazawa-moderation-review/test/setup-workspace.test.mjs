import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeWorkspace } from "../skills/zawazawa-setup/scripts/init-workspace.mjs";

function temporaryDestination(context, name = "workspace") {
  const root = mkdtempSync(join(tmpdir(), "zawazawa-setup-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, name);
}

function args(destination, mode = "--apply") {
  return [
    "--destination",
    destination,
    "--admin-url",
    "https://z.wikiwiki.jp/m/examplewiki/comment",
    "--display-name",
    "Example Wiki",
    mode,
  ];
}

test("dry-runは生成内容を返すがフォルダを作らない", (context) => {
  const destination = temporaryDestination(context);
  const result = initializeWorkspace(args(destination, "--dry-run"));
  assert.equal(result.template, "templates");
  assert.equal(result.moderationMode, "restricted");
  assert.equal(result.groupKey, "examplewiki");
  assert.equal(result.files.length, 8);
  assert.ok(result.files.every(({ action }) => action === "create"));
  assert.equal(existsSync(destination), false);
});

test("統一テンプレートは固定名の文書とrestricted設定を生成する", (context) => {
  const destination = temporaryDestination(context);
  const result = initializeWorkspace(args(destination));
  assert.equal(result.template, "templates");
  const config = JSON.parse(readFileSync(join(destination, "zawazawa.config.json"), "utf8"));
  assert.deepEqual(config, {
    version: 4,
    target: { groupKey: "examplewiki", displayName: "Example Wiki" },
    moderation: { mode: "restricted" },
  });
  assert.match(readFileSync(join(destination, "README.md"), "utf8"), /ZAWAZAWA通報対応/u);
  assert.match(readFileSync(join(destination, "AGENTS.md"), "utf8"), /保存禁止情報/u);
  assert.match(readFileSync(join(destination, "CLAUDE.md"), "utf8"), /@AGENTS\.md/u);
  assert.match(readFileSync(join(destination, ".gitignore"), "utf8"), /moderation-reports/u);
  assert.match(readFileSync(join(destination, "運用基準.md"), "utf8"), /通報対応/u);
  assert.match(readFileSync(join(destination, "根拠資料.md"), "utf8"), /通常の通報対応では読まず/u);
  const examples = readFileSync(join(destination, "判断事例.md"), "utf8");
  assert.match(examples, /空のままでも正常/u);
  assert.doesNotMatch(examples, /^### /mu);
});

test("同じ内容への再実行は変更せず再開できる", (context) => {
  const destination = temporaryDestination(context);
  initializeWorkspace(args(destination));
  const resumed = initializeWorkspace(args(destination));
  assert.ok(resumed.files.every(({ action }) => action === "unchanged"));
});

test("既存生成物の変更と未管理ファイルを上書きしない", (context) => {
  const destination = temporaryDestination(context);
  initializeWorkspace(args(destination));
  writeFileSync(join(destination, "README.md"), "管理者が編集した内容\n");
  assert.throws(() => initializeWorkspace(args(destination)), /上書きしません.*README\.md/u);

  const editableDestination = temporaryDestination(context, "editable-workspace");
  initializeWorkspace(args(editableDestination));
  writeFileSync(join(editableDestination, "運用基準.md"), "管理者が編集した内容\n");
  const resumed = initializeWorkspace(args(editableDestination));
  assert.equal(
    resumed.files.find(({ file }) => file === "運用基準.md").action,
    "preserve",
  );
  assert.equal(
    readFileSync(join(editableDestination, "運用基準.md"), "utf8"),
    "管理者が編集した内容\n",
  );

  const otherDestination = temporaryDestination(context, "other-workspace");
  initializeWorkspace(args(otherDestination));
  writeFileSync(join(otherDestination, "unknown.txt"), "unknown\n");
  assert.throws(() => initializeWorkspace(args(otherDestination)), /未管理の項目.*unknown\.txt/u);
});

test("不正な入力はファイル作成前に拒否する", (context) => {
  const destination = temporaryDestination(context);
  assert.throws(
    () => initializeWorkspace(args(destination).map((value) =>
      value === "https://z.wikiwiki.jp/m/examplewiki/comment" ? "https://example.com/m/x" : value)),
    /管理画面URL/u,
  );
  assert.throws(
    () => initializeWorkspace(args("relative/path")),
    /絶対パス/u,
  );
  assert.throws(
    () => initializeWorkspace(args(destination).filter((value) => value !== "Example Wiki")),
    /--display-name(?:は必須|の値がありません)/u,
  );
  assert.throws(
    () => initializeWorkspace([...args(destination), "--dry-run"]),
    /同時に指定/u,
  );
  assert.throws(
    () => initializeWorkspace(["--profile", "generic", ...args(destination)]),
    /未対応の引数/u,
  );
  assert.equal(existsSync(destination), false);
});
