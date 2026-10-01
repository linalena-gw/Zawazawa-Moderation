// インストール済みプラグインと実行先リポジトリが別のディレクトリ木になる起動形態を固定する。
// 既存のtarget-config.testは、実行先を辿れるcwdか、明示した環境変数だけを検証しているため、
// プラグインキャッシュから起動された場合の設定解決をここで受け持つ。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { TARGET_CONFIG_FILENAME } from "../server/target-config.mjs";

const serverPath = new URL("../server/server.mjs", import.meta.url).pathname;
const loaderPath = new URL("../test-support/mock-connector-loader.mjs", import.meta.url).pathname;

function temporaryDirectory(context, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function targetRepository(context, groupKey = "genshinwiki", displayName = "原神Wiki") {
  const directory = temporaryDirectory(context, "zawazawa-target-repo-");
  writeFileSync(
    join(directory, TARGET_CONFIG_FILENAME),
    JSON.stringify({
      version: 4,
      target: { groupKey, displayName },
      moderation: { mode: "restricted" },
    }),
  );
  return { directory, configPath: join(directory, TARGET_CONFIG_FILENAME) };
}

/** 実行先リポジトリのどの祖先からも辿れない位置に置いた、インストール済みプラグインを模す。 */
function installedPluginRoot(context) {
  const directory = temporaryDirectory(context, "zawazawa-plugin-cache-");
  const root = join(directory, "cache", "zawazawa-local", "zawazawa-moderation-review", "0.1.0");
  mkdirSync(root, { recursive: true });
  return root;
}

/** `.mcp.json`の`cwd: "."`と同じく、プラグインルートを作業ディレクトリにして起動する。 */
async function startInstalledServer(context, { cwd }) {
  const storeDirectory = temporaryDirectory(context, "zawazawa-installed-store-");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings", "--experimental-loader", loaderPath, serverPath],
    cwd,
    env: {
      PATH: process.env.PATH || "",
      ZAWAZAWA_REVIEW_STORE_DIR: storeDirectory,
      ZAWAZAWA_REVIEW_UI: "off",
    },
  });
  // 解決した対象は保存済み一覧のURLに現れる。読み出せるよう一覧HTMLの描画を申告する。
  const client = new Client(
    { name: "installed-plugin-test", version: "0.1.0" },
    { capabilities: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } },
  );
  context.after(() => client.close());
  await client.connect(transport);
  return client;
}

function bind(client, configPath) {
  return client.callTool({
    name: "get_moderation_target_config",
    arguments: configPath === undefined ? {} : { configPath },
  });
}

function reviewItem() {
  return {
    id: "96517",
    comments: [{ topicNumber: "413", commentNumber: "96517" }],
    history: [],
    basis: ["運用基準の該当項目"],
    recommendation: {
      targets: [{ commentNumber: "96517" }],
      operations: [
        {
          operationId: "keep",
          operationType: "no_external_action",
          targetCommentNumbers: ["96517"],
          messageIds: [],
        },
      ],
      operationCandidates: [],
      messages: [],
    },
  };
}

/** 承認と実行まで進める処理単位。対象グループは承認済み完全案のURLへ残る。 */
function deleteItem() {
  const item = reviewItem();
  item.recommendation.operations = [
    {
      operationId: "delete",
      operationType: "comment_delete",
      targetCommentNumbers: ["96517"],
      messageIds: [],
    },
  ];
  return item;
}

/** 一覧を作り、サーバーが解決した対象グループを保存済みURLから読み出す。 */
async function renderedGroupKey(client, targetContextId, extraItemArguments = {}) {
  const rendered = await client.callTool({
    name: "render_moderation_review",
    arguments: {
      batchTitle: "解決された対象の確認",
      targetContextId,
      items: [{ ...reviewItem(), ...extraItemArguments }],
    },
  });
  assert.equal(rendered.isError, undefined, JSON.stringify(rendered));
  const snapshot = await client.callTool({
    name: "get_moderation_review_snapshot",
    arguments: {
      batchId: rendered.structuredContent.batchId,
      snapshotToken: rendered.structuredContent.snapshotToken,
    },
  });
  return new URL(snapshot.structuredContent.items[0].publicUrl).pathname.split("/")[1];
}

test("互換経路の暗黙探索は、プラグインキャッシュから実行先へ届かないことを診断できる形で失敗する", async (context) => {
  targetRepository(context);
  const pluginRoot = installedPluginRoot(context);
  const client = await startInstalledServer(context, { cwd: pluginRoot });

  const implicit = await bind(client);
  assert.equal(implicit.isError, true);
  assert.equal(implicit.structuredContent.errorCode, "target_not_configured");
  // 探索開始位置を伝えないと、利用者は「実行先が悪い」のか「起動位置が悪い」のか切り分けられない。
  assert.ok(implicit.content[0].text.includes(pluginRoot));
  assert.ok(implicit.content[0].text.includes(TARGET_CONFIG_FILENAME));
});

test("実行先の設定パスを初回から渡すよう案内し、その対象コンテキストで読み取れる", async (context) => {
  const target = targetRepository(context);
  const client = await startInstalledServer(context, { cwd: installedPluginRoot(context) });

  const { tools } = await client.listTools();
  const targetTool = tools.find((tool) => tool.name === "get_moderation_target_config");
  assert.match(targetTool.description, /configPath on the first call/u);
  assert.doesNotMatch(targetTool.description, /first with no arguments/u);
  assert.match(
    targetTool.inputSchema.properties.configPath.description,
    /Locate it in the execution repository before this call/u,
  );

  const bound = await bind(client, target.configPath);
  assert.equal(bound.isError, undefined);
  assert.equal(bound.structuredContent.groupKey, "genshinwiki");
  assert.equal(bound.structuredContent.displayName, "原神Wiki");
  // 運用モードは以降の工程を分けるので返す。設定ファイルの場所は後続の呼び出しへ
  // 渡らないので、モデル可視の結果へ載せない。
  assert.equal(bound.structuredContent.moderationMode, "restricted");
  assert.equal(bound.structuredContent.configPath, undefined);
  const targetContextId = bound.structuredContent.targetContextId;
  assert.equal(typeof targetContextId, "string");
  // 束縛内容はIDから読み取れず、呼び出し側が作り出すこともできない。
  assert.doesNotMatch(targetContextId, /genshinwiki|原神/u);
  assert.equal(
    Buffer.from(targetContextId.split(".").at(-1), "base64url").includes("genshinwiki"),
    false,
  );

  const reports = await client.callTool({
    name: "get_zawazawa_open_reports",
    arguments: { targetContextId },
  });
  assert.equal(reports.isError, undefined);
  assert.equal(typeof reports.structuredContent.completeness, "string");

  assert.equal(await renderedGroupKey(client, targetContextId), "genshinwiki");
});

test("対象グループを指定する口が無く、渡しても束縛した対象が使われる", async (context) => {
  const target = targetRepository(context);
  const client = await startInstalledServer(context, { cwd: installedPluginRoot(context) });
  const { targetContextId } = (await bind(client, target.configPath)).structuredContent;

  // 対象は対象コンテキストIDだけを出所にする。名指しできなければ取り違えようがない。
  const { tools } = await client.listTools();
  for (const name of [
    "get_zawazawa_open_reports",
    "get_zawazawa_topic_context",
    "get_zawazawa_author_history",
    "check_zawazawa_public_visibility",
    "render_moderation_review",
    "prepare_autonomous_moderation_review",
  ]) {
    const tool = tools.find((entry) => entry.name === name);
    assert.equal(tool.inputSchema.properties.groupKey, undefined, name);
  }
  const itemSchema = tools.find((entry) => entry.name === "render_moderation_review")
    .inputSchema.properties.items.items;
  assert.equal(itemSchema.properties.groupKey, undefined);

  // 別グループを名乗る値が混ざっても、読み取り先は束縛した対象のままになる。
  const strayGroupKey = await client.callTool({
    name: "get_zawazawa_open_reports",
    arguments: { groupKey: "otherwiki", targetContextId },
  });
  assert.equal(strayGroupKey.isError, undefined);
  assert.equal(await renderedGroupKey(client, targetContextId), "genshinwiki");
  // itemへ紛れ込んだ場合は、参照以外を受け取らない入力形式として弾く。
  const strayItemGroupKey = await client.callTool({
    name: "render_moderation_review",
    arguments: {
      batchTitle: "対象外",
      targetContextId,
      items: [{ ...reviewItem(), groupKey: "otherwiki" }],
    },
  });
  assert.equal(strayItemGroupKey.isError, true);
  assert.match(strayItemGroupKey.content[0].text, /Unrecognized key/u);
});

test("実行先設定が無い場合は既定値や別リポジトリへ落ちない", async (context) => {
  const target = targetRepository(context);
  const empty = temporaryDirectory(context, "zawazawa-empty-repo-");
  const client = await startInstalledServer(context, { cwd: installedPluginRoot(context) });

  const missing = await bind(client, join(empty, TARGET_CONFIG_FILENAME));
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.errorCode, "target_not_configured");
  assert.equal(missing.structuredContent.groupKey, undefined);

  // 固定名以外のパスや相対パスを設定の出所にしない。
  for (const configPath of [join(target.directory, "別名.json"), "zawazawa.config.json", "../zawazawa.config.json"]) {
    const rejected = await bind(client, configPath);
    assert.equal(rejected.isError, true, configPath);
    assert.equal(rejected.structuredContent.errorCode, "target_config_invalid", configPath);
  }
});

test("同じサーバープロセスを複数の実行先が共有しても、先に読んだ対象を再利用しない", async (context) => {
  const first = targetRepository(context, "genshinwiki", "原神Wiki");
  const second = targetRepository(context, "otherwiki", "別Wiki");
  const client = await startInstalledServer(context, { cwd: installedPluginRoot(context) });

  const firstBound = (await bind(client, first.configPath)).structuredContent;
  const secondBound = (await bind(client, second.configPath)).structuredContent;
  assert.equal(firstBound.groupKey, "genshinwiki");
  assert.equal(secondBound.groupKey, "otherwiki");
  assert.notEqual(firstBound.targetContextId, secondBound.targetContextId);

  // 後から束縛した対象が、先に束縛した対象コンテキストの読み取り先を書き換えない。
  assert.equal(await renderedGroupKey(client, firstBound.targetContextId), "genshinwiki");
  assert.equal(await renderedGroupKey(client, secondBound.targetContextId), "otherwiki");
});

test("束縛後に設定が変わったら止まり、偽造した対象コンテキストは通らない", async (context) => {
  const target = targetRepository(context);
  const client = await startInstalledServer(context, { cwd: installedPluginRoot(context) });
  const { targetContextId } = (await bind(client, target.configPath)).structuredContent;

  writeFileSync(
    target.configPath,
    JSON.stringify({
      version: 4,
      target: { groupKey: "otherwiki", displayName: "別Wiki" },
      moderation: { mode: "restricted" },
    }),
  );
  const changed = await client.callTool({
    name: "get_zawazawa_open_reports",
    arguments: { targetContextId },
  });
  assert.equal(changed.isError, true);
  assert.equal(changed.structuredContent.errorCode, "target_config_changed");

  const forged = await client.callTool({
    name: "get_zawazawa_open_reports",
    arguments: { targetContextId: "0".repeat(43) },
  });
  assert.equal(forged.isError, true);
  assert.equal(forged.structuredContent.errorCode, "target_context_invalid");
});

test("別の対象へ束縛したまま、承認済み操作を実行できない", async (context) => {
  // 一覧はディスクに残るので、承認した対象と実行時に束縛している対象は食い違いうる。
  // 実行経路の対象グループは承認済み完全案から来るため、解決値では置き換えず照合する。
  const first = targetRepository(context, "genshinwiki", "原神Wiki");
  const second = targetRepository(context, "otherwiki", "別Wiki");
  const client = await startInstalledServer(context, { cwd: installedPluginRoot(context) });
  const firstBound = (await bind(client, first.configPath)).structuredContent;
  const secondBound = (await bind(client, second.configPath)).structuredContent;

  const rendered = await client.callTool({
    name: "render_moderation_review",
    arguments: {
      batchTitle: "承認済み削除",
      targetContextId: firstBound.targetContextId,
      items: [deleteItem()],
    },
  });
  assert.equal(rendered.isError, undefined, JSON.stringify(rendered));
  const identity = {
    batchId: rendered.structuredContent.batchId,
    snapshotToken: rendered.structuredContent.snapshotToken,
  };
  const snapshot = await client.callTool({
    name: "get_moderation_review_snapshot",
    arguments: identity,
  });
  const submitted = await client.callTool({
    name: "submit_moderation_decisions",
    arguments: {
      ...identity,
      decisions: [
        {
          itemId: "96517",
          choice: "approve",
          resolvedPlanToken: snapshot.structuredContent.items[0].recommendedResolvedPlanToken,
        },
      ],
    },
  });
  assert.equal(submitted.isError, undefined, JSON.stringify(submitted));

  const executed = await client.callTool({
    name: "execute_zawazawa_moderation_operation",
    arguments: {
      targetContextId: secondBound.targetContextId,
      batchId: identity.batchId,
      itemId: "96517",
      operationIndex: 0,
    },
  });
  assert.equal(executed.isError, true);
  assert.equal(executed.structuredContent.errorCode, "group_not_allowed");

  // 送信境界へ入っていないことを、記録が残らないことでも確かめる。
  const journal = await client.callTool({
    name: "get_moderation_execution_journal",
    arguments: { batchId: identity.batchId },
  });
  assert.deepEqual(journal.structuredContent.operations, []);
});
