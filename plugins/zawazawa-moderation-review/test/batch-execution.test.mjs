import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizeReviewInput } from "../server/review-input.mjs";
import { createReviewStore } from "../server/review-store.mjs";
import { createExecutionJournal } from "../server/execution-journal.mjs";
import { buildModerationReport } from "../server/moderation-report.mjs";
import { approvedRecommendation, review } from "../test-support/review-fixtures.mjs";

function item(number, types = ["comment_delete"], group) {
  const result = review(1).items[0];
  result.id = number;
  result.history = [];
  result.comments = [{ commentNumber: number, body: "テスト本文", currentState: "公開中" }];
  result.reports = [{ reportId: `connector-report-${number}`, targetCommentNumber: number, reason: "テスト理由" }];
  result.recommendation = {
    targets: [{ commentNumber: number, currentState: "公開中", url: `https://z.wikiwiki.jp/g/topic/413/${number}` }],
    operations: types.map((operationType, index) => ({ operationId: `action-${index}`,
      operationType, targetCommentNumbers: [number], messageIds: [] })), messages: [],
  };
  result.dependencyGroup = group;
  return result;
}

async function setup(t, items, { expired = false, hold = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "zawazawa-batch-test-"));
  const configPath = join(directory, "zawazawa.config.json");
  const logPath = join(directory, "calls.jsonl");
  const config = { version: 4, target: { groupKey: "g", displayName: "テストWiki" }, moderation: { mode: "restricted" } };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(logPath, "");
  const store = createReviewStore({ directory, ...(expired ? { now: () => Date.now() - 25 * 3600000 } : {}) });
  const batch = store.create(normalizeReviewInput({ batchTitle: "テスト一覧", items }));
  store.submit({ batchId: batch.batchId, snapshotToken: batch.snapshotToken,
    decisions: items.map(({ id }) => hold.includes(id) ? { itemId: id, choice: "hold" } : approvedRecommendation(store, batch, id)) });
  const journal = createExecutionJournal({ directory: join(directory, "execution-journal") });
  let client;
  const connect = async () => {
    client = new Client({ name: "batch-test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["--no-warnings", "--experimental-loader",
        new URL("../test-support/mock-connector-loader.mjs", import.meta.url).href,
        fileURLToPath(new URL("../server/server.mjs", import.meta.url))],
      env: { PATH: process.env.PATH || "", ZAWAZAWA_REVIEW_STORE_DIR: directory,
        ZAWAZAWA_REVIEW_UI: "off", ZAWAZAWA_TARGET_CONFIG: configPath, ZAWAZAWA_TEST_EXECUTION_LOG: logPath },
    }));
  };
  await connect();
  t.after(async () => { await client.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = await client.callTool({ name: "get_moderation_target_config", arguments: {} });
  const base = { batchId: batch.batchId, targetContextId: target.structuredContent.targetContextId };
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: { ...base, ...args } })).structuredContent;
  const key = (itemId, operationIndex = 0) => {
    const submission = store.get(batch.batchId, { scope: "execution" }).submission;
    const plan = submission.authorizedPlans.find((entry) => entry.itemId === itemId);
    const step = plan.resolvedPlan.executionSteps[operationIndex];
    return { batchId: batch.batchId, submissionId: submission.submissionId, itemId, operationIndex,
      resolvedPlanToken: plan.resolvedPlanToken, operationType: step.operationType,
      targetCommentNumber: step.targetCommentNumber };
  };
  return { call, key, journal, store, batch, config, configPath,
    releasePrepare: () => writeFileSync(`${logPath}.release`, ""),
    restart: async () => {
      await client.close(); await connect();
      const target = await client.callTool({ name: "get_moderation_target_config", arguments: {} });
      base.targetContextId = target.structuredContent.targetContextId;
    },
    calls: () => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) };
}
const execute = "execute_zawazawa_moderation_batch";
const reconcile = "reconcile_zawazawa_moderation_operation";

test("上限と再開で成功済みを再送しない", async (t) => {
  const ctx = await setup(t, [item("96517", ["comment_delete", "author_auto_ignore", "report_complete"]), item("96551")]);
  const first = await ctx.call(execute, { maxOperations: 2 });
  assert.equal(first.attemptedOperations, 2);
  assert.equal(first.remaining.length, 2);
  assert.ok(first.remaining.every((entry) => entry.reason === "limit"));
  await ctx.restart();
  const next = await ctx.call(execute);
  assert.equal(next.attemptedOperations, 2);
  assert.equal(next.complete, true);
  assert.equal(ctx.calls().filter((entry) => entry.type === "submit").length, 4);
  assert.equal((await ctx.call(execute)).attemptedOperations, 0);
  assert.equal(ctx.calls().length, 4);
});

test("unknownを再送せず、依存範囲を止めて独立した残件を実行する", async (t) => {
  const ctx = await setup(t, [item("96551", ["comment_delete"], "shared"), item("96518", ["comment_delete"], "shared"), item("96517")]);
  ctx.journal.save({ ...ctx.key("96518"), status: "dispatching" });
  ctx.journal.save({ ...ctx.key("96518"), status: "unknown" });
  const result = await ctx.call(execute);
  assert.equal(result.complete, false);
  assert.deepEqual(result.remaining.map((entry) => entry.itemId), ["96551"]);
  assert.deepEqual(ctx.calls().map((entry) => entry.commentNumber), ["96517"]);
  const recovered = await ctx.call(reconcile, { itemId: "96518", operationIndex: 0 });
  assert.equal(recovered.status, "confirmed");
  assert.equal(recovered.dispatched, false);
  assert.equal(ctx.calls().filter((entry) => entry.type === "submit").length, 1);
  assert.equal((await ctx.call(execute)).complete, true);
  assert.equal(ctx.calls().filter((entry) => entry.type === "submit").length, 2);
  assert.equal(buildModerationReport({ store: ctx.store, executionJournal: ctx.journal,
    batchId: ctx.batch.batchId, displayName: "テストWiki" }).executed.units[1].steps[0].status, "confirmed");
});

test("中断復旧は期限切れでも照合だけでき、後続は実行しない", async (t) => {
  const ctx = await setup(t, [item("96518", ["comment_delete", "report_complete"])], { expired: true });
  ctx.journal.save({ ...ctx.key("96518"), status: "dispatching" });
  assert.equal((await ctx.call(reconcile, { itemId: "96518", operationIndex: 0 })).status, "confirmed");
  const result = await ctx.call(execute);
  assert.equal(result.complete, false);
  assert.equal(result.remaining.length, 1);
  assert.ok(ctx.calls().every((entry) => entry.type === "readback"));
  assert.deepEqual(ctx.journal.getOperation(ctx.key("96518")).history.map((entry) => entry.status),
    ["dispatching", "unknown", "confirmed"]);
});

test("証拠不足と通報の閉鎖はunknownを維持し、未送信は照合で確定しない", async (t) => {
  const ctx = await setup(t, [item("96521"), item("96518", ["report_complete"]), item("96517")]);
  for (const id of ["96521", "96518"]) {
    ctx.journal.save({ ...ctx.key(id), status: "dispatching" });
    assert.equal((await ctx.call(reconcile, { itemId: id, operationIndex: 0 })).status, "unknown");
  }
  assert.equal((await ctx.call(reconcile, { itemId: "96517", operationIndex: 0 })).errorCode, "journal_conflict");
  assert.deepEqual(ctx.calls().map((entry) => entry.type), ["readback"]);
});

test("複数通報の無視は通報単位で部分成功を残し、新規通報へ広げない", async (t) => {
  const target = item("96550", ["report_ignore"]);
  target.reports = ["r-c", "r-a", "r-b"].map((reportId) => ({ reportId, targetCommentNumber: "96550", reason: "テスト理由" }));
  const ctx = await setup(t, [target, item("96517")]);
  const result = await ctx.call(execute);
  assert.equal(result.complete, false);
  assert.deepEqual(ctx.journal.getBatch(ctx.batch.batchId).operations.filter((entry) => entry.itemId === "96550")
    .map((entry) => entry.status), ["confirmed", "unknown"]);
  assert.deepEqual(ctx.calls().filter((entry) => entry.commentNumber === "96550").map((entry) => entry.reportIds), [["r-a"], ["r-b"]]);
  await ctx.call(execute);
  assert.equal(ctx.calls().length, 3);
});

test("既に処理済みの通報だけを送らず、残りの承認済み無視を続行する", async (t) => {
  const target = item("96551", ["report_ignore"]);
  target.reports = ["r-a", "r-b", "r-c"].map((reportId) => ({ reportId, targetCommentNumber: "96551", reason: "テスト理由" }));
  const ctx = await setup(t, [target]);
  const result = await ctx.call(execute);
  assert.equal(result.complete, true);
  assert.deepEqual(result.results.map((entry) => entry.status), ["no_action_needed", "confirmed", "confirmed"]);
  assert.deepEqual(ctx.calls().map((entry) => entry.reportIds), [["r-b"], ["r-c"]]);
});

test("対象とモードの変更、承認保留の依存範囲はバッチ実行を止める", async (t) => {
  const ctx = await setup(t, [item("96551", ["comment_delete"], "shared"), item("96518", ["comment_delete"], "shared"), item("96517")], { hold: ["96518"] });
  const result = await ctx.call(execute);
  assert.equal(result.complete, false);
  assert.deepEqual(ctx.calls().map((entry) => entry.commentNumber), ["96517"]);
  ctx.config.moderation.mode = "autonomous";
  writeFileSync(ctx.configPath, JSON.stringify(ctx.config));
  assert.equal((await ctx.call(execute)).errorCode, "target_config_changed");
  ctx.config.target.groupKey = "other-group";
  writeFileSync(ctx.configPath, JSON.stringify(ctx.config));
  assert.equal((await ctx.call(reconcile, { itemId: "96517", operationIndex: 0 })).errorCode, "target_config_changed");
  assert.equal(ctx.calls().length, 1);
});

test("代表的な4操作はモデル側実行ツール1呼出しで完了する", async (t) => {
  const ctx = await setup(t, [item("96517", ["comment_delete", "author_auto_ignore", "report_complete"]), item("96551")]);
  const result = await ctx.call(execute);
  assert.equal(result.complete, true);
  assert.equal(result.attemptedOperations, 4);
  assert.equal(ctx.calls().length, 4);
});

test("旧承認の複数ID無視を再分解せず、操作番号とトークンを維持する", async (t) => {
  const target = item("96550", ["report_ignore"]);
  target.reports = ["r-a", "r-b"].map((reportId) => ({ reportId, targetCommentNumber: "96550", reason: "テスト理由" }));
  const ctx = await setup(t, [target]);
  const { createResolvedPlanToken } = await import("../server/resolved-plan.mjs");
  const path = join(ctx.store.directory, `${ctx.batch.batchId}.submission.json`);
  const old = JSON.parse(readFileSync(path, "utf8"));
  const decision = old.decisions[0];
  const plan = decision.resolvedPlan;
  plan.executionSteps = [{ ...plan.executionSteps[0], reportIds: ["r-a", "r-b"] }];
  decision.resolvedPlanToken = createResolvedPlanToken({ batchId: ctx.batch.batchId,
    snapshotToken: ctx.batch.snapshotToken, resolvedPlan: plan });
  writeFileSync(path, JSON.stringify(old));
  const result = await ctx.call(execute);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].errorCode, "browser_required");
  assert.equal(ctx.key("96550").resolvedPlanToken, decision.resolvedPlanToken);
  assert.deepEqual(ctx.calls(), []);
  ctx.journal.save({ ...ctx.key("96550"), status: "dispatching" });
  const retry = await ctx.call("execute_zawazawa_moderation_operation", { itemId: "96550", operationIndex: 0 });
  assert.equal(retry.errorCode, "already_dispatched");
  assert.equal(retry.browserFallbackAllowed, false);
  assert.deepEqual(ctx.calls(), []);
});


test("取得中に依存単位が結果不明になった場合は送信前に止まる", async (t) => {
  const ctx = await setup(t, [item("96552", ["comment_delete"], "shared"),
    item("96518", ["comment_delete"], "shared")]);
  const pending = ctx.call("execute_zawazawa_moderation_operation", { itemId: "96552", operationIndex: 0 });
  try {
    const deadline = Date.now() + 5000;
    while (!ctx.calls().some((entry) => entry.type === "prepare_waiting") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(ctx.calls().some((entry) => entry.type === "prepare_waiting"));
    ctx.journal.save({ ...ctx.key("96518"), status: "dispatching" });
    ctx.journal.save({ ...ctx.key("96518"), status: "unknown" });
  } finally { ctx.releasePrepare(); }
  const result = await pending;
  assert.equal(result.errorCode, "operation_order_blocked");
  assert.equal(result.dispatched, false);
  assert.equal(ctx.journal.getOperation(ctx.key("96552")), null);
  assert.ok(ctx.calls().every((entry) => entry.type !== "submit"));
});


test("送信前停止が上限を消費しても、再開位置から独立残件を進められる", async (t) => {
  const ctx = await setup(t, [item("96519", ["comment_delete", "report_complete"], "shared"),
    item("96551", ["comment_delete"], "shared"), item("96517")]);
  const first = await ctx.call(execute, { maxOperations: 1 });
  assert.equal(first.attemptedOperations, 1);
  assert.equal(first.nextStartAtOperation, 3);
  assert.equal(first.remaining.at(-1).reason, "limit");
  const resumed = await ctx.call(execute, { maxOperations: 1, startAtOperation: first.nextStartAtOperation });
  assert.equal(resumed.attemptedOperations, 1);
  assert.equal(resumed.complete, false);
  assert.equal(resumed.nextStartAtOperation, undefined);
  assert.deepEqual(resumed.remaining.map((entry) => [entry.itemId, entry.reason]),
    [["96519", "skipped"], ["96519", "skipped"], ["96551", "skipped"]]);
  assert.deepEqual(ctx.calls().map((entry) => entry.commentNumber), ["96517"]);
  // 任意の位置を申告しても、飛ばした未送信操作の同一単位や依存先は実行しない。
  const middle = await ctx.call(execute, { startAtOperation: 1 });
  assert.equal(middle.attemptedOperations, 0);
  assert.deepEqual(ctx.calls().map((entry) => entry.commentNumber), ["96517"]);
  const invalid = await ctx.call(execute, { startAtOperation: 5 });
  assert.ok(invalid.errorCode);
  assert.equal(ctx.calls().length, 1);
});
