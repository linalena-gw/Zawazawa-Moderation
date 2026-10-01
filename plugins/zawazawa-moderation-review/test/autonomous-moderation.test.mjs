import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REPORT_DIRECTORY_NAME } from "../server/moderation-report.mjs";

/**
 * 自律処理の経路を端から端まで確かめる。人間の承認に代わる実行許可がどこで生まれ、
 * どこで塞がれ、結果がどう報告されるかを一つの流れとして固定する。
 */

function writeTargetConfig(directory, mode, groupKey = "g") {
  const path = join(directory, "zawazawa.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 4,
      target: { groupKey, displayName: "テストWiki" },
      moderation: { mode },
    }),
  );
  return path;
}

function deleteItem(commentNumber) {
  return {
    id: commentNumber,
    comments: [{ topicNumber: "413", commentNumber }],
    history: [],
    basis: ["運用基準の該当項目"],
    recommendation: {
      targets: [{ commentNumber }],
      operations: [
        {
          operationId: "delete",
          operationType: "comment_delete",
          targetCommentNumbers: [commentNumber],
          messageIds: [],
        },
      ],
      operationCandidates: [],
      messages: [],
    },
  };
}

async function startServer(context, { mode }) {
  // 報告は実行先リポジトリのルート直下へ書くため、設定ファイルの置き場所がそのまま
  // 書き出し先になる。承認ストアとは別のディレクトリにして、両者を取り違えない。
  const repository = mkdtempSync(join(tmpdir(), "zawazawa-autonomous-repo-"));
  const store = mkdtempSync(join(tmpdir(), "zawazawa-autonomous-store-"));
  const configPath = writeTargetConfig(repository, mode);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--no-warnings",
      "--experimental-loader",
      new URL("../test-support/mock-connector-loader.mjs", import.meta.url).pathname,
      new URL("../server/server.mjs", import.meta.url).pathname,
    ],
    env: {
      PATH: process.env.PATH || "",
      ZAWAZAWA_REVIEW_STORE_DIR: store,
      ZAWAZAWA_REVIEW_UI: "off",
      ZAWAZAWA_TARGET_CONFIG: configPath,
    },
  });
  const client = new Client({ name: "autonomous-test", version: "0.1.0" });
  context.after(async () => {
    await client.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });
  await client.connect(transport);
  return { client, repository, store, configPath };
}

async function bind(client) {
  const target = await client.callTool({
    name: "get_moderation_target_config",
    arguments: {},
  });
  assert.equal(target.isError, undefined, JSON.stringify(target));
  return target.structuredContent.targetContextId;
}

/** 自分で判断する案件の一覧。管理者へ提示しない経路で作る。 */
async function prepare(client, targetContextId, batchTitle, items) {
  const prepared = await client.callTool({
    name: "prepare_autonomous_moderation_review",
    arguments: { targetContextId, batchTitle, items },
  });
  assert.equal(prepared.isError, undefined, JSON.stringify(prepared));
  return prepared.structuredContent;
}

test("自律処理は推奨案だけを承認し、実行結果を報告HTMLへ書き出す", async (context) => {
  const { client, repository } = await startServer(context, { mode: "autonomous" });
  const targetContextId = await bind(client);

  // 96517=効果を確認できる、96521=送信後も確定できない、96520=保留する。
  const executed = await prepare(client, targetContextId, "自律処理", [
    deleteItem("96517"),
    deleteItem("96521"),
    deleteItem("96520"),
  ]);

  // 判断の無い処理単位を残したまま送信できない。自律処理では確認する人がいない。
  const partial = await client.callTool({
    name: "submit_autonomous_moderation_decisions",
    arguments: {
      targetContextId,
      batchId: executed.batchId,
      snapshotToken: executed.snapshotToken,
      decisions: [{ itemId: "96517", choice: "approve" }],
    },
  });
  assert.equal(partial.isError, true);
  assert.equal(partial.structuredContent.errorCode, "review_input_invalid");
  assert.match(partial.content[0].text, /全処理単位/u);

  const submitted = await client.callTool({
    name: "submit_autonomous_moderation_decisions",
    arguments: {
      targetContextId,
      batchId: executed.batchId,
      snapshotToken: executed.snapshotToken,
      decisions: [
        { itemId: "96517", choice: "approve" },
        { itemId: "96521", choice: "approve" },
        { itemId: "96520", choice: "hold" },
      ],
    },
  });
  assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
  assert.equal(submitted.structuredContent.submission.authorizedBy, "autonomous");
  assert.equal(submitted.structuredContent.submission.approvedCount, 2);
  assert.equal(submitted.structuredContent.submission.heldCount, 1);

  // 同じ一覧へ人間の承認を後から重ねられない。承認は一回きりである。
  const twice = await client.callTool({
    name: "submit_autonomous_moderation_decisions",
    arguments: {
      targetContextId,
      batchId: executed.batchId,
      snapshotToken: executed.snapshotToken,
      decisions: [
        { itemId: "96517", choice: "hold" },
        { itemId: "96521", choice: "hold" },
        { itemId: "96520", choice: "hold" },
      ],
    },
  });
  assert.equal(twice.isError, true);

  const execute = (itemId) =>
    client.callTool({
      name: "execute_zawazawa_moderation_operation",
      arguments: { targetContextId, batchId: executed.batchId, itemId, operationIndex: 0 },
    });
  assert.equal((await execute("96517")).structuredContent.status, "confirmed");
  assert.equal((await execute("96521")).structuredContent.status, "unknown");
  // 保留した単位は自律処理でも実行許可を持たない。
  const held = await execute("96520");
  assert.equal(held.isError, true);
  assert.equal(held.structuredContent.dispatched, false);

  const report = await client.callTool({
    name: "render_moderation_report",
    arguments: {
      targetContextId,
      batchId: executed.batchId,
    },
  });
  assert.equal(report.isError, undefined, JSON.stringify(report));
  assert.deepEqual(Object.keys(report.structuredContent).sort(), ["itemCount", "reportPath"]);
  const reportPath = report.structuredContent.reportPath;
  assert.equal(reportPath.startsWith(join(repository, REPORT_DIRECTORY_NAME)), true);
  assert.deepEqual(readdirSync(join(repository, REPORT_DIRECTORY_NAME)).length, 1);

  const html = readFileSync(reportPath, "utf8");
  // 報告として埋め込む内容だけを見る。一覧UIの取り込み元には対話用のコードが残る。
  const embedded = /window\.__zawazawaReport = (\{.*?\});<\/script>/su.exec(html);
  assert.ok(embedded, "報告の内容が一覧HTMLへ埋め込まれている");
  const payload = JSON.parse(embedded[1]);
  const [confirmedUnit, unknownUnit, heldUnit] = payload.executed.units;
  // 報告は実行状態を記録どおりに出す。送信結果の分からない操作を実行済みにしない。
  assert.equal(payload.executed.authorizedBy, "autonomous");
  assert.equal(confirmedUnit.steps[0].status, "confirmed");
  assert.equal(unknownUnit.steps[0].status, "unknown");
  assert.equal(heldUnit.choice, "hold");
  assert.deepEqual(heldUnit.steps, []);
  // 実行許可を作れる値と承認境界の内部識別子は、保存されるファイルへ載せない。
  assert.doesNotMatch(embedded[1], /resolvedPlanToken|connector-report-|snapshotToken/u);

  // 同じ一覧の報告は上書きし、実行が進むたびに同じ場所を読み直せる。
  const again = await client.callTool({
    name: "render_moderation_report",
    arguments: { targetContextId, batchId: executed.batchId },
  });
  assert.equal(again.structuredContent.reportPath, reportPath);
});

test("自律処理の判断は代替案を作れず、判断の無い一覧は報告できない", async (context) => {
  const { client } = await startServer(context, { mode: "autonomous" });
  const targetContextId = await bind(client);
  const batch = await prepare(client, targetContextId, "自律処理", [deleteItem("96517")]);

  for (const decision of [
    { itemId: "96517", choice: "alternative" },
    {
      itemId: "96517",
      choice: "approve",
      changes: { selectedTargetCommentNumbers: ["96517"], selectedOperationIds: ["delete"], messageChanges: [] },
    },
    { itemId: "96517", choice: "approve", supplementalReason: "自由文で範囲を広げる" },
  ]) {
    const rejected = await client.callTool({
      name: "submit_autonomous_moderation_decisions",
      arguments: {
        targetContextId,
        batchId: batch.batchId,
        snapshotToken: batch.snapshotToken,
        decisions: [decision],
      },
    });
    assert.equal(rejected.isError, true, JSON.stringify(decision));
  }

  // 判断の無い一覧は実行結果を持たない。報告の対象にしない。
  const tooEarly = await client.callTool({
    name: "render_moderation_report",
    arguments: { targetContextId, batchId: batch.batchId },
  });
  assert.equal(tooEarly.isError, true);
  assert.equal(tooEarly.structuredContent.errorCode, "report_write_failed");
});

test("旧auto-reviewを含む自律承認はrestrictedの実行許可にならない", async (context) => {
  const { client, repository, store } = await startServer(context, { mode: "autonomous" });
  const autonomousContextId = await bind(client);
  const batch = await prepare(client, autonomousContextId, "自律処理", [deleteItem("96517")]);
  const submitted = await client.callTool({
    name: "submit_autonomous_moderation_decisions",
    arguments: {
      targetContextId: autonomousContextId,
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      decisions: [{ itemId: "96517", choice: "approve" }],
    },
  });
  assert.equal(submitted.isError, undefined, JSON.stringify(submitted));

  // 廃止前に保存された承認を再現する。読取時に管理者承認へ寄せてはならない。
  const submissionPath = join(store, `${batch.batchId}.submission.json`);
  const submission = JSON.parse(readFileSync(submissionPath, "utf8"));
  writeFileSync(submissionPath, JSON.stringify({ ...submission, authorizedBy: "auto-review" }));

  // 管理者がrestrictedへ戻す。期限内の旧自律承認が残っていても実行できない。
  writeTargetConfig(repository, "restricted");
  const restrictedContextId = await bind(client);
  const executed = await client.callTool({
    name: "execute_zawazawa_moderation_operation",
    arguments: {
      targetContextId: restrictedContextId,
      batchId: batch.batchId,
      itemId: "96517",
      operationIndex: 0,
    },
  });
  assert.equal(executed.isError, true);
  assert.equal(executed.structuredContent.errorCode, "moderation_mode_unsupported");

  // ブラウザ経路も同じ境界で塞ぐ。外部送信の開始はジャーナルの記録を必ず通る。
  const journaled = await client.callTool({
    name: "record_moderation_execution_event",
    arguments: {
      targetContextId: restrictedContextId,
      batchId: batch.batchId,
      itemId: "96517",
      operationIndex: 0,
      status: "dispatching",
    },
  });
  assert.equal(journaled.isError, true);
  assert.equal(journaled.structuredContent.errorCode, "moderation_mode_unsupported");

  // 提示しない一覧の入口も同じ境界で塞ぐ。運用モードは束縛時ではなく呼び出しごとに
  // 読み直すので、restrictedへ戻した後に束縛し直しても自律処理の一覧は作れない。
  const preparedAfterRevert = await client.callTool({
    name: "prepare_autonomous_moderation_review",
    arguments: {
      targetContextId: restrictedContextId,
      batchTitle: "提示しない一覧",
      items: [deleteItem("96530")],
    },
  });
  assert.equal(preparedAfterRevert.isError, true);
  assert.equal(preparedAfterRevert.structuredContent.errorCode, "moderation_mode_unsupported");
});

test("外部送信を開始した操作の結果は、対象の束縛を失った後でも記録できる", async (context) => {
  const { client, configPath } = await startServer(context, { mode: "autonomous" });
  const targetContextId = await bind(client);
  const batch = await prepare(client, targetContextId, "自律処理", [deleteItem("96517")]);
  const submitted = await client.callTool({
    name: "submit_autonomous_moderation_decisions",
    arguments: {
      targetContextId,
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      decisions: [{ itemId: "96517", choice: "approve" }],
    },
  });
  assert.equal(submitted.isError, undefined, JSON.stringify(submitted));

  const record = (args) =>
    client.callTool({
      name: "record_moderation_execution_event",
      arguments: { batchId: batch.batchId, itemId: "96517", operationIndex: 0, ...args },
    });

  // 外部送信を開く記録は運用モードとの照合を要するので、照合の相手が無ければ通らない。
  const unbound = await record({ status: "dispatching" });
  assert.equal(unbound.isError, true);
  assert.equal(unbound.structuredContent.errorCode, "target_context_invalid");

  const dispatching = await record({ targetContextId, status: "dispatching" });
  assert.equal(dispatching.isError, undefined, JSON.stringify(dispatching));

  // 設定を読めなくなり束縛し直せなくなっても、送信済みの操作の結果は記録できる。
  // ここで記録を失うと、外部送信を開始した操作が未送信として残る。
  rmSync(configPath, { force: true });
  const rebound = await client.callTool({
    name: "get_moderation_target_config",
    arguments: {},
  });
  assert.equal(rebound.isError, true);
  const confirmed = await record({ status: "confirmed" });
  assert.equal(confirmed.isError, undefined, JSON.stringify(confirmed));
  assert.equal(confirmed.structuredContent.status, "confirmed");
});

test("別の対象で作った一覧は自律承認も結果報告も受け付けない", async (context) => {
  const { client, repository } = await startServer(context, { mode: "autonomous" });
  const otherContextId = await bind(client);
  const batch = await prepare(client, otherContextId, "別対象の一覧", [deleteItem("96517")]);

  // 管理者が対象グループを入れ替える。承認ストアは実行先をまたいで共有されうる。
  writeTargetConfig(repository, "autonomous", "otherwiki");
  const currentContextId = await bind(client);

  const submitted = await client.callTool({
    name: "submit_autonomous_moderation_decisions",
    arguments: {
      targetContextId: currentContextId,
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      decisions: [{ itemId: "96517", choice: "approve" }],
    },
  });
  assert.equal(submitted.isError, true);
  assert.equal(submitted.structuredContent.errorCode, "group_not_allowed");

  // 本文を別の実行先リポジトリへ書き出させない。
  const report = await client.callTool({
    name: "render_moderation_report",
    arguments: { targetContextId: currentContextId, batchId: batch.batchId },
  });
  assert.equal(report.isError, true);
  assert.equal(report.structuredContent.errorCode, "group_not_allowed");
});
