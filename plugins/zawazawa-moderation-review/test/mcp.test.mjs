import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

function writeTargetConfig(directory, groupKey = "g") {
  const path = join(directory, "zawazawa.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 4,
      target: { groupKey, displayName: "テストWiki" },
      moderation: { mode: "restricted" },
    }),
  );
  return path;
}

function noActionItem(commentNumber, fact = "対象と文脈を確認") {
  return {
    id: commentNumber,
    comments: [
      {
        topicNumber: "413",
        commentNumber,
      },
    ],
    history: [],
    basis: ["運用基準の該当項目"],
    recommendation: {
      targets: [{ commentNumber }],
      operations: [
        {
          operationId: "keep",
          operationType: "no_external_action",
          targetCommentNumbers: [commentNumber],
          messageIds: [],
        },
      ],
      operationCandidates: [],
      messages: [],
    },
  };
}

/**
 * `ui://`の一覧HTMLを描画できると申告するホスト。app-onlyツールの呼び出し元に
 * なりうるのはこの種類のホストだけなので、サーバーはこの申告を見て有効化する。
 */
function appHostClient(name) {
  return new Client(
    { name, version: "0.1.0" },
    { capabilities: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } },
  );
}

/** 読み取りと一覧表示は対象コンテキストIDを必須にするので、接続直後に対象を束縛する。 */
async function bindTargetContext(client) {
  const target = await client.callTool({
    name: "get_moderation_target_config",
    arguments: {},
  });
  assert.equal(target.isError, undefined, JSON.stringify(target));
  return target.structuredContent.targetContextId;
}

test("MCPサーバーが一覧表示ツールとUIリソースを公開する", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "zawazawa-review-mcp-"));
  const otherTargetDirectory = mkdtempSync(join(tmpdir(), "zawazawa-review-other-target-"));
  const otherTargetConfig = writeTargetConfig(otherTargetDirectory, "other-group");
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
      ZAWAZAWA_REVIEW_STORE_DIR: directory,
      ZAWAZAWA_REVIEW_UI: "off",
      ZAWAZAWA_TARGET_CONFIG: writeTargetConfig(directory),
    },
  });
  const client = appHostClient("plugin-test");
  context.after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(otherTargetDirectory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const targetContextId = await bindTargetContext(client);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      "check_zawazawa_public_visibility",
      "execute_zawazawa_moderation_batch",
      "execute_zawazawa_moderation_operation",
      "get_moderation_execution_journal",
      "get_moderation_review",
      "get_moderation_review_snapshot",
      "get_moderation_target_config",
      "get_zawazawa_author_history",
      "get_zawazawa_open_reports",
      "get_zawazawa_topic_context",
      "prepare_autonomous_moderation_review",
      "preview_moderation_decision",
      "reconcile_zawazawa_moderation_operation",
      "record_moderation_execution_event",
      "render_moderation_report",
      "render_moderation_review",
      "submit_autonomous_moderation_decisions",
      "submit_moderation_decisions",
    ],
  );
  // ジャーナル取得は記録を書き換えない。1操作1レコードで復旧追記を持たない。
  const journalTool = tools.tools.find(
    (tool) => tool.name === "get_moderation_execution_journal",
  );
  assert.equal(journalTool.annotations.readOnlyHint, true);
  const historyTool = tools.tools.find((tool) => tool.name === "get_zawazawa_author_history");
  assert.equal(historyTool.inputSchema.properties.limit.default, 10);
  assert.ok(!historyTool.inputSchema.required.includes("limit"));
  const renderTool = tools.tools.find((tool) => tool.name === "render_moderation_review");
  assert.deepEqual(renderTool._meta.ui.visibility, ["model"]);
  // 自律処理の一覧は表示経路を持たない。ホストが描画する宣言をどちらの形でも持たない。
  const prepareTool = tools.tools.find(
    (tool) => tool.name === "prepare_autonomous_moderation_review",
  );
  assert.equal(prepareTool._meta?.ui, undefined);
  assert.equal(prepareTool._meta?.["openai/outputTemplate"], undefined);
  assert.deepEqual(
    Object.keys(prepareTool.inputSchema.properties).sort(),
    Object.keys(renderTool.inputSchema.properties).sort(),
  );
  const reportTool = tools.tools.find((tool) => tool.name === "render_moderation_report");
  assert.deepEqual(Object.keys(reportTool.inputSchema.properties).sort(), [
    "batchId",
    "targetContextId",
  ]);
  // restrictedでは自分で判断する一覧そのものを作れない。承認は必ず管理者が行う。
  const preparedInRestricted = await client.callTool({
    name: "prepare_autonomous_moderation_review",
    arguments: {
      targetContextId,
      batchTitle: "提示しない一覧",
      items: [noActionItem("96515")],
    },
  });
  assert.equal(preparedInRestricted.isError, true);
  assert.equal(
    preparedInRestricted.structuredContent.errorCode,
    "moderation_mode_unsupported",
  );
  for (const name of [
    "get_moderation_review_snapshot",
    "preview_moderation_decision",
    "submit_moderation_decisions",
  ]) {
    const tool = tools.tools.find((entry) => entry.name === name);
    assert.deepEqual(tool._meta.ui.visibility, ["app"]);
  }
  const itemInputSchema = renderTool.inputSchema.properties.items.items;
  assert.equal(itemInputSchema.additionalProperties, false);
  assert.equal(itemInputSchema.properties.reports, undefined);
  assert.equal(itemInputSchema.properties.publicUrl, undefined);
  assert.equal(itemInputSchema.properties.adminUrl, undefined);
  assert.equal(itemInputSchema.properties.comments.items.additionalProperties, false);
  assert.equal(itemInputSchema.properties.comments.items.properties.body, undefined);
  const recommendationSchema =
    itemInputSchema.properties.recommendation;
  assert.ok(
    recommendationSchema.properties.operations.items.required.includes("operationType"),
  );
  assert.ok(
    recommendationSchema.properties.operations.items.required.includes("targetCommentNumbers"),
  );
  assert.ok(
    recommendationSchema.properties.operations.items.required.includes("messageIds"),
  );
  assert.ok(
    recommendationSchema.properties.operationCandidates.items.required.includes(
      "targetCommentNumbers",
    ),
  );
  assert.ok(
    recommendationSchema.properties.operationCandidates.items.required.includes("messageIds"),
  );
  assert.ok(recommendationSchema.properties.messages.items.required.includes("messageId"));
  assert.equal(recommendationSchema.properties.targets.items.properties.currentState, undefined);
  assert.equal(recommendationSchema.properties.targets.items.properties.url, undefined);
  // 役割も関係の説明もサーバーの解決結果から決まる。モデルは語を渡す口を持たない。
  assert.equal(recommendationSchema.properties.targets.items.properties.relationship, undefined);
  assert.equal(itemInputSchema.properties.comments.items.properties.relationship, undefined);

  const resources = await client.listResources();
  assert.equal(resources.resources[0].uri, "ui://zawazawa-moderation-review/list-v1.html");

  const copiedEvidenceItem = structuredClone(noActionItem("96516"));
  copiedEvidenceItem.reports = [{ reason: "手渡しの通報" }];
  copiedEvidenceItem.publicUrl = "https://example.com/copied";
  copiedEvidenceItem.comments[0].body = "手渡しの本文";
  copiedEvidenceItem.recommendation.targets[0].currentState = "公開中";
  copiedEvidenceItem.comments[0].relationship = "通報対象";
  const copiedEvidence = await client.callTool({
    name: "render_moderation_review",
    arguments: { targetContextId, batchTitle: "手渡し証拠を拒否", items: [copiedEvidenceItem] },
  });
  assert.equal(copiedEvidence.isError, true);
  assert.match(copiedEvidence.content[0].text, /Unrecognized key/u);

  // 表題もサーバーが組み立てるので、モデルが書いた表題を受け取る口を持たない。
  const copiedTitleItem = structuredClone(noActionItem("96516"));
  copiedTitleItem.title = "雑談 #96516";
  const copiedTitle = await client.callTool({
    name: "render_moderation_review",
    arguments: { targetContextId, batchTitle: "表題の手渡しを拒否", items: [copiedTitleItem] },
  });
  assert.equal(copiedTitle.isError, true);
  assert.match(copiedTitle.content[0].text, /Unrecognized key/u);

  const rendered = await client.callTool({
    name: "render_moderation_review",
    arguments: {
      targetContextId,
      batchTitle: "未処理通報レビュー",
      items: [
        {
          id: "96517",
          comments: [
            {
              topicNumber: "413",
              commentNumber: "96517",
            },
          ],
          history: [
            {
              topicNumber: "413",
              commentNumber: "96441",
            },
          ],
          basis: ["運用基準の該当項目"],
          recommendation: {
            targets: [{ commentNumber: "96517" }],
            operations: [
              {
                operationId: "delete",
                operationType: "comment_delete",
                targetCommentNumbers: ["96517"],
                messageIds: [],
              },
              {
                operationId: "complete",
                operationType: "report_complete",
                targetCommentNumbers: ["96517"],
                messageIds: ["report-message"],
              },
              {
                operationId: "notice",
                operationType: "public_notice",
                targetCommentNumbers: ["96517"],
                messageIds: ["notice-message"],
              },
            ],
            operationCandidates: [
              {
                operationId: "keep",
                operationType: "no_external_action",
                targetCommentNumbers: ["96517"],
                messageIds: [],
                highImpact: false,
              },
            ],
            messages: [
              { messageId: "report-message", label: "通報者への案内", text: "削除しました。" },
              { messageId: "notice-message", label: "公開案内", text: "対応しました。" },
            ],
          },
        },
      ],
    },
  });
  assert.equal(rendered.isError, undefined, JSON.stringify(rendered));
  assert.equal(rendered.structuredContent.itemCount, 1);
  assert.equal(rendered.structuredContent.items, undefined);
  assert.doesNotMatch(
    JSON.stringify(rendered.structuredContent),
    /管理画面から解決した対象本文|管理画面から解決した通報理由/u,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(rendered.structuredContent)) < 2_000);

  const identity = {
    batchId: rendered.structuredContent.batchId,
    snapshotToken: rendered.structuredContent.snapshotToken,
  };
  const snapshot = await client.callTool({
    name: "get_moderation_review_snapshot",
    arguments: identity,
  });
  assert.equal(
    snapshot.structuredContent.items[0].comments[0].body,
    "管理画面から解決した対象本文",
  );
  // 表題はモデルの入力ではなく、解決したトピック名と処置対象から組み立てる。
  assert.equal(snapshot.structuredContent.items[0].title, "雑談/オデット #96517");
  assert.equal(snapshot.structuredContent.items[0].reportCount, 1);
  assert.equal(
    snapshot.structuredContent.items[0].reports[0].reportId,
    "connector-report-96517",
  );
  assert.equal(
    snapshot.structuredContent.items[0].publicUrl,
    "https://z.wikiwiki.jp/g/topic/413/96517",
  );
  assert.equal(
    snapshot.structuredContent.items[0].adminUrl,
    "https://z.wikiwiki.jp/m/g/comment/413/96517",
  );
  assert.equal(
    snapshot.structuredContent.items[0].recommendation.targets[0].currentState,
    "公開中",
  );

  const changes = {
    selectedTargetCommentNumbers: ["96517"],
    selectedOperationIds: ["keep", "complete", "notice"],
    messageChanges: [
      {
        messageId: "report-message",
        action: "replace",
        replacement: { label: "通報者への案内", text: "確認のうえ維持しました。" },
      },
      {
        messageId: "notice-message",
        action: "keep",
      },
    ],
  };
  const preview = await client.callTool({
    name: "preview_moderation_decision",
    arguments: { ...identity, itemId: "96517", changes },
  });
  assert.deepEqual(
    // 実行順は候補の宣言順で決まり、選択の入力順には従わない。
    preview.structuredContent.resolvedPlan.operations.map((operation) => operation.operationId),
    ["complete", "notice", "keep"],
  );
  assert.deepEqual(preview.structuredContent.resolvedPlan.executionSteps, [
    {
      operationIndex: 0,
      planOperationId: "complete",
      operationType: "report_complete",
      targetCommentNumber: "96517",
      reportIds: ["connector-report-96517"],
      messages: [
        {
          messageId: "report-message",
          label: "通報者への案内",
          text: "確認のうえ維持しました。",
        },
      ],
    },
    {
      operationIndex: 1,
      planOperationId: "notice",
      operationType: "public_notice",
      targetCommentNumber: "96517",
      reportIds: ["connector-report-96517"],
      messages: [
        {
          messageId: "notice-message",
          label: "公開案内",
          text: "対応しました。",
        },
      ],
    },
  ]);
  const beforeSubmit = await client.callTool({
    name: "get_moderation_review",
    arguments: { batchId: identity.batchId, scope: "summary" },
  });
  assert.equal(beforeSubmit.structuredContent.submission, null);
  const beforeSubmitDiff = await client.callTool({
    name: "get_moderation_review",
    arguments: { targetContextId, batchId: identity.batchId, scope: "decision_diff" },
  });
  assert.equal(beforeSubmitDiff.isError, true);

  const submitted = await client.callTool({
    name: "submit_moderation_decisions",
    arguments: {
      ...identity,
      decisions: [
        {
          itemId: "96517",
          choice: "alternative",
          changes,
          resolvedPlanToken: preview.structuredContent.resolvedPlanToken,
        },
      ],
    },
  });
  assert.equal(submitted.structuredContent.submission.alternativeCount, 1);
  assert.equal(submitted.structuredContent.items, undefined);
  assert.doesNotMatch(JSON.stringify(submitted.structuredContent), /確認のうえ維持しました/u);
  assert.ok(Buffer.byteLength(JSON.stringify(submitted.structuredContent)) < 1_500);

  const decisionDiff = await client.callTool({
    name: "get_moderation_review",
    arguments: { targetContextId, batchId: identity.batchId, scope: "decision_diff" },
  });
  assert.equal(decisionDiff.isError, undefined, JSON.stringify(decisionDiff));
  assert.deepEqual(decisionDiff.structuredContent.changedItemIds, ["96517"]);
  assert.equal(decisionDiff.structuredContent.units[0].decisionType, "alternative");
  assert.deepEqual(decisionDiff.structuredContent.units[0].changedFields, [
    "operations",
    "messages",
  ]);
  assert.equal(decisionDiff.structuredContent.unit, undefined);
  assert.doesNotMatch(JSON.stringify(decisionDiff.structuredContent), /resolvedPlanToken/u);

  const decisionDetail = await client.callTool({
    name: "get_moderation_review",
    arguments: {
      targetContextId,
      batchId: identity.batchId,
      scope: "decision_diff",
      itemId: "96517",
    },
  });
  assert.equal(
    decisionDetail.structuredContent.unit.context.comments[0].body,
    "管理画面から解決した対象本文",
  );
  assert.deepEqual(decisionDetail.structuredContent.unit.recommendation.basis, [
    "運用基準の該当項目",
  ]);
  assert.equal(
    decisionDetail.structuredContent.unit.finalDecision.resolvedPlan.messages[0].text,
    "確認のうえ維持しました。",
  );
  assert.doesNotMatch(JSON.stringify(decisionDetail.structuredContent), /resolvedPlanToken/u);

  const unboundDecisionDiff = await client.callTool({
    name: "get_moderation_review",
    arguments: { batchId: identity.batchId, scope: "decision_diff" },
  });
  assert.equal(unboundDecisionDiff.isError, true);
  const otherTarget = await client.callTool({
    name: "get_moderation_target_config",
    arguments: { configPath: otherTargetConfig },
  });
  const mismatchedDecisionDiff = await client.callTool({
    name: "get_moderation_review",
    arguments: {
      targetContextId: otherTarget.structuredContent.targetContextId,
      batchId: identity.batchId,
      scope: "decision_diff",
    },
  });
  assert.equal(mismatchedDecisionDiff.isError, true);
  assert.equal(mismatchedDecisionDiff.structuredContent.errorCode, "group_not_allowed");

  const execution = await client.callTool({
    name: "get_moderation_review",
    arguments: { batchId: identity.batchId, scope: "execution" },
  });
  assert.deepEqual(
    execution.structuredContent.submission.executableAuthorizedItemIds,
    ["96517"],
  );
  // 通常の実行取得は原子操作を指す値だけを返し、承認済み本文を再掲しない。
  assert.doesNotMatch(JSON.stringify(execution.structuredContent), /確認のうえ維持しました/u);
  assert.deepEqual(execution.structuredContent.submission.executionManifest, [
    {
      itemId: "96517",
      operations: [
        {
          operationIndex: 0,
          operationType: "report_complete",
          targetCommentNumber: "96517",
        },
        {
          operationIndex: 1,
          operationType: "public_notice",
          targetCommentNumber: "96517",
        },
      ],
    },
  ]);

  // 完全案は、ブラウザ経路が要る単位に限って取得する。
  const browserPlan = await client.callTool({
    name: "get_moderation_review",
    arguments: { batchId: identity.batchId, scope: "browser_plan", itemId: "96517" },
  });
  assert.equal(browserPlan.structuredContent.submission.executable, true);
  assert.equal(
    browserPlan.structuredContent.submission.authorizedPlan.resolvedPlan.messages[0].text,
    "確認のうえ維持しました。",
  );
  // 取得範囲と処理単位の指定は対で扱い、片方だけの指定を読み替えない。
  const missingItemId = await client.callTool({
    name: "get_moderation_review",
    arguments: { batchId: identity.batchId, scope: "browser_plan" },
  });
  assert.equal(missingItemId.isError, true);
  const unusableItemId = await client.callTool({
    name: "get_moderation_review",
    arguments: { batchId: identity.batchId, scope: "execution", itemId: "96517" },
  });
  assert.equal(unusableItemId.isError, true);

  const journalBase = {
    targetContextId,
    batchId: identity.batchId,
    itemId: "96517",
    operationIndex: 0,
  };
  // ブラウザ経路でも、先行操作を確定せず後続の送信前状態を記録できない。
  const reversedBrowserOperation = await client.callTool({
    name: "record_moderation_execution_event",
    arguments: { ...journalBase, operationIndex: 1, status: "dispatching" },
  });
  assert.equal(reversedBrowserOperation.isError, true);
  assert.equal(
    reversedBrowserOperation.structuredContent.errorCode,
    "operation_order_blocked",
  );
  assert.equal(reversedBrowserOperation.structuredContent.nextAction, "stop");
  const journalAfterReversedBrowserOperation = await client.callTool({
    name: "get_moderation_execution_journal",
    arguments: { batchId: identity.batchId },
  });
  assert.deepEqual(journalAfterReversedBrowserOperation.structuredContent.operations, []);
  // 承認済み完全案にない操作番号は記録できない。対象と操作種別はサーバーが承認済み
  // 完全案から取るため、呼び出し側が申告する口を持たない。
  const rejectedIndex = await client.callTool({
    name: "record_moderation_execution_event",
    arguments: { ...journalBase, operationIndex: 99, status: "ready" },
  });
  assert.equal(rejectedIndex.isError, true);

  // 外部送信を開始する前に結果は記録できない。
  const tooEarly = await client.callTool({
    name: "record_moderation_execution_event",
    arguments: { ...journalBase, status: "confirmed" },
  });
  assert.equal(tooEarly.isError, true);

  for (const status of ["ready", "dispatching", "confirmed"]) {
    const recorded = await client.callTool({
      name: "record_moderation_execution_event",
      arguments: { ...journalBase, status },
    });
    assert.equal(recorded.isError, undefined, JSON.stringify(recorded));
    // 対象と操作種別は承認済み完全案から取るため、記録できた状態だけを返す。
    assert.deepEqual(recorded.structuredContent, { status });
  }

  // 送信境界へ入った操作は開き直せず、確定した結果も上書きできない。
  for (const status of ["ready", "dispatching", "unknown"]) {
    const rejected = await client.callTool({
      name: "record_moderation_execution_event",
      arguments: { ...journalBase, status },
    });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent.errorCode, "journal_conflict");
  }

  // 送信を開始したまま結果が確定しない操作。プロセスが止まっても未送信に見えない。
  const danglingBase = { ...journalBase, operationIndex: 1 };
  for (const status of ["ready", "dispatching"]) {
    const recorded = await client.callTool({
      name: "record_moderation_execution_event",
      arguments: { ...danglingBase, status },
    });
    assert.equal(recorded.isError, undefined, JSON.stringify(recorded));
  }

  const journal = await client.callTool({
    name: "get_moderation_execution_journal",
    arguments: { batchId: identity.batchId },
  });
  assert.deepEqual(
    journal.structuredContent.operations.map((operation) => [
      operation.operationIndex,
      operation.status,
    ]),
    [
      [0, "confirmed"],
      [1, "dispatching"],
    ],
  );
  // 成功時に常に同じ値となる説明的なフラグはツール説明が持ち、結果へ載せない。
  assert.equal(journal.structuredContent.authorization, undefined);
  assert.equal(journal.structuredContent.liveStateAuthority, undefined);
  assert.equal(journal.structuredContent.batchId, undefined);
  assert.deepEqual(Object.keys(journal.structuredContent.operations[0]).sort(), [
    "itemId",
    "operationIndex",
    "operationType",
    "status",
    "targetCommentNumber",
  ]);

  const resolvedUnknown = await client.callTool({
    name: "record_moderation_execution_event",
    arguments: { ...danglingBase, status: "unknown" },
  });
  assert.equal(resolvedUnknown.isError, undefined);
  assert.equal(resolvedUnknown.structuredContent.status, "unknown");

  const directRendered = await client.callTool({
    name: "render_moderation_review",
    arguments: {
      targetContextId,
      batchTitle: "推奨案の直接承認",
      items: [noActionItem("96600")],
    },
  });
  assert.equal(directRendered.isError, undefined, JSON.stringify(directRendered));
  const directIdentity = {
    batchId: directRendered.structuredContent.batchId,
    snapshotToken: directRendered.structuredContent.snapshotToken,
  };
  const directSnapshot = await client.callTool({
    name: "get_moderation_review_snapshot",
    arguments: directIdentity,
  });
  const directItem = directSnapshot.structuredContent.items[0];
  assert.equal(directItem.recommendedResolvedPlan.operations[0].operationTypeLabel, "外部操作なし");
  assert.deepEqual(directItem.recommendedResolvedPlan.executionSteps, []);
  assert.match(directItem.recommendedResolvedPlanToken, /^[0-9a-f]{64}$/u);

  const missingRecommendedToken = await client.callTool({
    name: "submit_moderation_decisions",
    arguments: {
      ...directIdentity,
      decisions: [{ itemId: "96600", choice: "approve" }],
    },
  });
  assert.equal(missingRecommendedToken.isError, true);
  const directSubmitted = await client.callTool({
    name: "submit_moderation_decisions",
    arguments: {
      ...directIdentity,
      decisions: [
        {
          itemId: "96600",
          choice: "approve",
          resolvedPlanToken: directItem.recommendedResolvedPlanToken,
        },
      ],
    },
  });
  assert.equal(directSubmitted.structuredContent.submission.approvedCount, 1);
  const directExecution = await client.callTool({
    name: "get_moderation_review",
    arguments: {
      batchId: directIdentity.batchId,
      scope: "browser_plan",
      itemId: "96600",
    },
  });
  const directBrowserPlan =
    directExecution.structuredContent.submission.authorizedPlan.resolvedPlan;
  // ブラウザ経路だけが管理画面URLを受け取る。承認済み完全案はそれ以外変わらない。
  assert.deepEqual(
    directBrowserPlan.targets.map((target) => target.adminUrl),
    ["https://z.wikiwiki.jp/m/g/comment/413/96600"],
  );
  assert.deepEqual(
    {
      ...directBrowserPlan,
      targets: directBrowserPlan.targets.map(({ adminUrl, ...target }) => target),
    },
    directItem.recommendedResolvedPlan,
  );

  // モデル可視のrender/submit応答は、100単位の長本文でもほぼ固定サイズに保つ。
  const longFact = "長".repeat(4_000);
  const bulkRendered = await client.callTool({
    name: "render_moderation_review",
    arguments: {
      targetContextId,
      batchTitle: "100件の長本文レビュー",
      items: Array.from({ length: 100 }, (_, index) =>
        noActionItem(String(97000 + index), longFact)),
    },
  });
  assert.equal(bulkRendered.isError, undefined, JSON.stringify(bulkRendered));
  const modelVisible = (result) => JSON.stringify({
    content: result.content,
    structuredContent: result.structuredContent,
  });
  const directRenderBytes = Buffer.byteLength(modelVisible(directRendered));
  const bulkRenderBytes = Buffer.byteLength(modelVisible(bulkRendered));
  assert.doesNotMatch(modelVisible(bulkRendered), /長{20}/u);
  assert.ok(bulkRenderBytes < 2_500, `bulk render bytes=${bulkRenderBytes}`);
  assert.ok(
    Math.abs(bulkRenderBytes - directRenderBytes) < 512,
    `render bytes: direct=${directRenderBytes}, bulk=${bulkRenderBytes}`,
  );

  const bulkIdentity = {
    batchId: bulkRendered.structuredContent.batchId,
    snapshotToken: bulkRendered.structuredContent.snapshotToken,
  };
  const bulkSnapshot = await client.callTool({
    name: "get_moderation_review_snapshot",
    arguments: bulkIdentity,
  });
  assert.equal(bulkSnapshot.structuredContent.items.length, 100);
  const bulkSubmitted = await client.callTool({
    name: "submit_moderation_decisions",
    arguments: {
      ...bulkIdentity,
      decisions: bulkSnapshot.structuredContent.items.map((item) => ({
        itemId: item.id,
        choice: "approve",
        resolvedPlanToken: item.recommendedResolvedPlanToken,
      })),
    },
  });
  assert.equal(bulkSubmitted.structuredContent.submission.approvedCount, 100);
  const directSubmitBytes = Buffer.byteLength(modelVisible(directSubmitted));
  const bulkSubmitBytes = Buffer.byteLength(modelVisible(bulkSubmitted));
  assert.ok(bulkSubmitBytes < 2_000, `bulk submit bytes=${bulkSubmitBytes}`);
  assert.ok(
    Math.abs(bulkSubmitBytes - directSubmitBytes) < 512,
    `submit bytes: direct=${directSubmitBytes}, bulk=${bulkSubmitBytes}`,
  );
});

test("モデル可視の結果は次の判断に要る値だけを返す", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "zawazawa-review-projection-mcp-"));
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
      ZAWAZAWA_REVIEW_STORE_DIR: directory,
      ZAWAZAWA_REVIEW_UI: "off",
      ZAWAZAWA_TARGET_CONFIG: writeTargetConfig(directory),
    },
  });
  const client = appHostClient("projection-test");
  context.after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect(transport);

  const target = await client.callTool({
    name: "get_moderation_target_config",
    arguments: {},
  });
  // 後続の呼び出しへ渡る値、ブラウザ経路の対象照合に使う表示名、以降の工程を分ける
  // 運用モードだけを返す。
  assert.deepEqual(Object.keys(target.structuredContent).sort(), [
    "displayName",
    "groupKey",
    "moderationMode",
    "targetContextId",
  ]);
  const targetContextId = target.structuredContent.targetContextId;

  const reports = await client.callTool({
    name: "get_zawazawa_open_reports",
    arguments: { targetContextId },
  });
  // 入力の再掲と、completenessから決まる値は返さない。完全性の解釈自体は省かない。
  assert.deepEqual(Object.keys(reports.structuredContent).sort(), [
    "completeness",
    "reports",
    "totalCount",
  ]);
  assert.equal(reports.content.length, 1);
  assert.doesNotMatch(reports.content[0].text, /completeness|complete|0件/u);

  const rendered = await client.callTool({
    name: "render_moderation_review",
    arguments: {
      targetContextId,
      batchTitle: "モデル可視結果の射影",
      items: [deleteItem("96517")],
    },
  });
  // ループバックURLは一覧UIを描画しないホストの唯一の経路なので、URLか、
  // 用意できなかった理由のどちらかを返す。
  assert.deepEqual(Object.keys(rendered.structuredContent).sort(), [
    "batchId",
    "expiresAt",
    "itemCount",
    "reviewUrlError",
    "snapshotToken",
  ]);

  const identity = {
    batchId: rendered.structuredContent.batchId,
    snapshotToken: rendered.structuredContent.snapshotToken,
  };
  const snapshot = await client.callTool({
    name: "get_moderation_review_snapshot",
    arguments: identity,
  });
  await client.callTool({
    name: "submit_moderation_decisions",
    arguments: {
      ...identity,
      decisions: snapshot.structuredContent.items.map((item) => ({
        itemId: item.id,
        choice: "approve",
        resolvedPlanToken: item.recommendedResolvedPlanToken,
      })),
    },
  });

  const execution = await client.callTool({
    name: "get_moderation_review",
    arguments: { batchId: identity.batchId, scope: "execution" },
  });
  assert.deepEqual(Object.keys(execution.structuredContent).sort(), [
    "expired",
    "expiresAt",
    "submission",
  ]);
  assert.deepEqual(Object.keys(execution.structuredContent.submission).sort(), [
    "blockedDependencyGroups",
    "executableAuthorizedItemIds",
    "executionManifest",
  ]);
  // 実行ツールへ渡す口が無い承認ストア内部の識別子は返さない。完全案も、実行ツールが
  // 承認ストアから解決するため、この取得には載せない。
  const [manifestItem] = execution.structuredContent.submission.executionManifest;
  assert.deepEqual(Object.keys(manifestItem).sort(), ["itemId", "operations"]);
  assert.ok(manifestItem.operations.length > 0);
  assert.deepEqual(Object.keys(manifestItem.operations[0]).sort(), [
    "operationIndex",
    "operationType",
    "targetCommentNumber",
  ]);

  // 実行を止めた結果は、理由の文言ではなくコードと再試行判断の状態を返す。
  const stopped = await client.callTool({
    name: "execute_zawazawa_moderation_operation",
    arguments: {
      targetContextId,
      batchId: identity.batchId,
      itemId: "96517",
      operationIndex: 99,
    },
  });
  assert.equal(stopped.isError, true);
  assert.deepEqual(Object.keys(stopped.structuredContent).sort(), [
    "browserFallbackAllowed",
    "dispatched",
    "errorCode",
    "nextAction",
  ]);
  assert.equal(stopped.structuredContent.nextAction, "stop");
  assert.match(stopped.content[0].text, /^\[review_input_invalid\]/u);
});

test("renderは参照を一度だけ解決しconnector由来の通報確認状態を保持する", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "zawazawa-review-reference-mcp-"));
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
      ZAWAZAWA_REVIEW_STORE_DIR: directory,
      ZAWAZAWA_REVIEW_UI: "off",
      ZAWAZAWA_TARGET_CONFIG: writeTargetConfig(directory),
    },
  });
  const client = appHostClient("reference-resolution-test");
  context.after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const targetContextId = await bindTargetContext(client);

  const rendered = await client.callTool({
    name: "render_moderation_review",
    arguments: {
      targetContextId,
      batchTitle: "参照解決の一回性",
      items: [
        {
          id: "96517",
          comments: [
            {
              topicNumber: "413",
              commentNumber: "96517",
            },
            { topicNumber: "413", commentNumber: "96518" },
          ],
          history: [],
          basis: ["運用基準の該当項目"],
          recommendation: {
            targets: [
              { commentNumber: "96517" },
              { commentNumber: "96518" },
            ],
            operations: [
              {
                operationId: "keep",
                operationType: "no_external_action",
                targetCommentNumbers: ["96517", "96518"],
                messageIds: [],
              },
            ],
            operationCandidates: [],
            messages: [],
          },
        },
      ],
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
  const [item] = snapshot.structuredContent.items;
  assert.equal(item.comments[0].body, "管理画面から解決した対象本文");
  assert.equal(item.reportCount, 2);
  assert.deepEqual(
    item.reports.map((report) => report.reportId),
    ["connector-report-96517", "connector-report-96518"],
  );
});

test("承認ストアと実行ジャーナルの失敗もerrorCodeとnextActionで返す", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "zawazawa-review-errorcode-"));
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
      ZAWAZAWA_REVIEW_STORE_DIR: directory,
      ZAWAZAWA_REVIEW_UI: "off",
      ZAWAZAWA_TARGET_CONFIG: writeTargetConfig(directory),
    },
  });
  const client = new Client({ name: "review-errorcode-test", version: "0.1.0" });
  context.after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect(transport);

  const targetContextId = await bindTargetContext(client);

  // skillは文言ではなくerrorCodeで行動を決めるため、承認の取得と記録の失敗も
  // コネクタや対象設定と同じ形で判別できなければならない。
  const unknownBatchId = "00000000-0000-4000-8000-0000000000ff";
  const missing = await client.callTool({
    name: "get_moderation_review",
    arguments: { batchId: unknownBatchId, scope: "execution" },
  });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.errorCode, "review_input_invalid");
  // 文言を読まなくても次の行動を決められる形で返す。
  assert.equal(missing.structuredContent.nextAction, "stop");
  assert.match(missing.content[0].text, /^\[review_input_invalid\]/u);

  // 実行許可の無い単位はジャーナルへも記録できない。
  const unauthorized = await client.callTool({
    name: "record_moderation_execution_event",
    arguments: {
      targetContextId,
      batchId: unknownBatchId,
      itemId: "96517",
      operationIndex: 0,
      status: "dispatching",
    },
  });
  assert.equal(unauthorized.isError, true);
  assert.equal(unauthorized.structuredContent.errorCode, "review_input_invalid");
});

test("MCP Appsを申告しないホストではapp-onlyツールを公開しない", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "zawazawa-review-visibility-"));
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
      ZAWAZAWA_REVIEW_STORE_DIR: directory,
      ZAWAZAWA_REVIEW_UI: "off",
      ZAWAZAWA_TARGET_CONFIG: writeTargetConfig(directory),
    },
  });
  // `ui://`を描画しないホスト。`_meta.ui.visibility`を読む主体がいないため、
  // 公開したツールはそのままモデルから呼べる前提で確認する。
  const client = new Client({ name: "no-app-host-test", version: "0.1.0" });
  context.after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const targetContextId = await bindTargetContext(client);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const name of [
    "get_moderation_review_snapshot",
    "preview_moderation_decision",
    "submit_moderation_decisions",
  ]) {
    assert.ok(!names.includes(name), `${name}が公開されています`);
  }
  // 調査、一覧作成、承認取得はこのホストでも従来どおり使える。
  for (const name of [
    "get_moderation_target_config",
    "get_zawazawa_open_reports",
    "render_moderation_review",
    "get_moderation_review",
  ]) {
    assert.ok(names.includes(name), `${name}が公開されていません`);
  }

  const rendered = await client.callTool({
    name: "render_moderation_review",
    arguments: {
      batchTitle: "可視性の確認",
      targetContextId,
      items: [noActionItem("96517")],
    },
  });
  assert.equal(rendered.isError, undefined, JSON.stringify(rendered));
  const { batchId, snapshotToken } = rendered.structuredContent;

  // モデル可視のbatchIdとsnapshotTokenだけでは、保存済み本文も承認記録も作れない。
  const snapshot = await client.callTool({
    name: "get_moderation_review_snapshot",
    arguments: { batchId, snapshotToken },
  });
  assert.equal(snapshot.isError, true);
  assert.equal(snapshot.structuredContent, undefined);
  const submitted = await client.callTool({
    name: "submit_moderation_decisions",
    arguments: {
      batchId,
      snapshotToken,
      decisions: [{ itemId: "96517", choice: "approve", resolvedPlanToken: "0".repeat(64) }],
    },
  });
  assert.equal(submitted.isError, true);

  // 承認が記録されていないことを、モデル可視の取得ツール側からも確認する。
  const review = await client.callTool({
    name: "get_moderation_review",
    arguments: { batchId },
  });
  assert.equal(review.structuredContent.submission, null);
});

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

// 削除と通報完了を同じ単位に持ち、完了には承認時に確定した代替本文を束ねる。どちらの
// 本文を送るかは、同じ処理単位の削除が送信境界へ入ったかどうかで分かれる。
function deleteAndCompleteItem(commentNumber) {
  const item = deleteItem(commentNumber);
  item.recommendation.operations.push({
    operationId: "complete",
    operationType: "report_complete",
    targetCommentNumbers: [commentNumber],
    messageIds: ["reply"],
  });
  item.recommendation.messages = [
    {
      messageId: "reply",
      label: "通報者への回答",
      text: "通常の回答です。",
      alreadyDeletedText: "削除済みだった場合の回答です。",
    },
  ];
  return item;
}

function reportCompleteItem(commentNumber) {
  const item = deleteItem(commentNumber);
  item.recommendation.operations = [
    {
      operationId: "complete",
      operationType: "report_complete",
      targetCommentNumbers: [commentNumber],
      messageIds: [],
    },
  ];
  return item;
}

test("承認済み操作をMCPから送信し結果をジャーナルへ確定する", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "zawazawa-review-execute-mcp-"));
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
      ZAWAZAWA_REVIEW_STORE_DIR: directory,
      ZAWAZAWA_REVIEW_UI: "off",
      ZAWAZAWA_TARGET_CONFIG: writeTargetConfig(directory),
    },
  });
  const client = appHostClient("execution-test");
  context.after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const targetContextId = await bindTargetContext(client);

  // 96517=効果を確認できる、96518=応答が効果の不在を示す、96519=送信前に拒否される、
  // 96521=送信後も読み戻しでも確定できない。
  const numbers = ["96517", "96518", "96519", "96521", "96541", "96542", "96543"];
  const rendered = await client.callTool({
    name: "render_moderation_review",
    arguments: {
      targetContextId,
      batchTitle: "承認済み削除の送信",
      items: numbers.map((number) => deleteItem(number)),
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
      decisions: snapshot.structuredContent.items.map((item) => ({
        itemId: item.id,
        choice: "approve",
        resolvedPlanToken: item.recommendedResolvedPlanToken,
      })),
    },
  });
  assert.equal(submitted.isError, undefined, JSON.stringify(submitted));

  const execute = (itemId, operationIndex = 0) =>
    client.callTool({
      name: "execute_zawazawa_moderation_operation",
      arguments: { targetContextId, batchId: identity.batchId, itemId, operationIndex },
    });

  const confirmed = await execute("96517");
  assert.equal(confirmed.isError, undefined, JSON.stringify(confirmed));
  assert.equal(confirmed.structuredContent.status, "confirmed");
  assert.equal(confirmed.structuredContent.dispatched, true);
  assert.equal(confirmed.structuredContent.browserFallbackAllowed, false);
  // 承認済みplanと入力値は成功結果へ再掲せず、結果と再試行判断に要る状態だけを返す。
  assert.deepEqual(Object.keys(confirmed.structuredContent).sort(), [
    "browserFallbackAllowed",
    "dispatched",
    "status",
  ]);

  // 送信境界へ入った操作は、同じ承認では二度と開き直せない。
  const repeated = await execute("96517");
  assert.equal(repeated.isError, true);
  assert.equal(repeated.structuredContent.errorCode, "already_dispatched");
  assert.equal(repeated.structuredContent.dispatched, false);
  // 送信済みの操作はブラウザ経路でも押し直さないので、次の行動もbrowserにしない。
  assert.equal(repeated.structuredContent.nextAction, "stop");

  // 効果の不在を読めても、送信を開始した以上は結果不明として扱いやり直さない。
  const absent = await execute("96518");
  assert.equal(absent.structuredContent.status, "unknown");
  assert.equal(absent.structuredContent.browserFallbackAllowed, false);
  const afterAbsent = await execute("96518");
  assert.equal(afterAbsent.isError, true);
  assert.equal(afterAbsent.structuredContent.errorCode, "already_dispatched");

  // 送信前の失敗はZAWAZAWAを変えていない。ブラウザ経路へ移ってよい。
  const blocked = await execute("96519");
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.errorCode, "blocked");
  assert.equal(blocked.structuredContent.dispatched, false);
  assert.equal(blocked.structuredContent.browserFallbackAllowed, true);
  assert.equal(blocked.structuredContent.nextAction, "browser");
  // 送信していないので記録も残らず、承認を取り直さずに再試行できる。
  const retried = await execute("96519");
  assert.equal(retried.structuredContent.errorCode, "blocked");

  // 送信前でも、復旧分類が禁じた代替経路を実行側で許可しない。
  for (const [itemId, errorCode, nextAction] of [
    ["96541", "rate_limited", "retry"],
    ["96542", "profile_locked", "retry"],
    ["96543", "not_found", "stop"],
  ]) {
    const failure = await execute(itemId);
    assert.equal(failure.isError, true);
    assert.deepEqual(failure.structuredContent, {
      errorCode, nextAction, browserFallbackAllowed: false, dispatched: false,
    });
  }

  // 結果不明は成功にも失敗にも寄せず、やり直しも許さない。
  const unknown = await execute("96521");
  assert.equal(unknown.structuredContent.status, "unknown");
  assert.equal(unknown.structuredContent.dispatched, true);
  assert.equal(unknown.structuredContent.browserFallbackAllowed, false);
  const afterUnknown = await execute("96521");
  assert.equal(afterUnknown.isError, true);
  assert.equal(afterUnknown.structuredContent.errorCode, "already_dispatched");

  // 承認の無い操作番号と対象は送信できない。
  const unauthorized = await execute("96517", 5);
  assert.equal(unauthorized.isError, true);

  const journal = await client.callTool({
    name: "get_moderation_execution_journal",
    arguments: { batchId: identity.batchId },
  });
  assert.deepEqual(
    journal.structuredContent.operations.map((operation) => [
      operation.itemId,
      operation.status,
    ]),
    [
      ["96517", "confirmed"],
      ["96518", "unknown"],
      ["96521", "unknown"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(journal.structuredContent), /本文|通報理由/u);
});

test("実行直前照合は停止・対応不要・送信の三つへ分ける", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "zawazawa-review-precheck-mcp-"));
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
      ZAWAZAWA_REVIEW_STORE_DIR: directory,
      ZAWAZAWA_REVIEW_UI: "off",
      ZAWAZAWA_TARGET_CONFIG: writeTargetConfig(directory),
    },
  });
  const client = appHostClient("precheck-test");
  context.after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const targetContextId = await bindTargetContext(client);

  // 操作ごとに必要な条件だけを照合する。96523=通報完了で通報表を読めない、
  // 96524=通報完了で対象通報が未処理にも処理済みにも無い。どちらも到達点を
  // 確かめられないので止める。モック側の`submit`は呼ばれれば失敗する。
  const stopped = {
    96523: {
      item: reportCompleteItem("96523"),
      differences: ["open_reports_unreadable"],
    },
    96524: {
      item: reportCompleteItem("96524"),
      differences: ["report_missing:connector-report-96524"],
    },
  };
  // 96522=他の管理者が先に削除していた、96527=承認済み通報がすでに閉じられていた。
  // どちらも承認済み操作の到達点に達しているので、送らずに確定する。
  // 96530=対応不要として確定した後に対象が戻った。確定済みの結果は開き直さない。
  const settled = {
    96522: deleteItem("96522"),
    96527: reportCompleteItem("96527"),
    96530: deleteItem("96530"),
  };
  // 96525=通報完了で別の新規通報が増えただけ、96526=削除で通報表を読めないだけ。
  // どちらも承認済み操作に必要な条件は満たしているので止めない。
  const proceeding = {
    96525: reportCompleteItem("96525"),
    96526: deleteItem("96526"),
    // 96531=通報表を読み切れていない完了。読めなかった通報も同じ完了で閉じる。
    96531: reportCompleteItem("96531"),
  };
  // 96532=送信しても効果が出なかった完了。承認済み操作の送信先だった通報が未処理のまま
  // 見えても、同じ承認では送り直さない。
  const unresent = { 96532: reportCompleteItem("96532") };
  // 96533=追加の完了を送ったが効果を確認できない。閉じた件数へ数えず残件として返す。
  const unconfirmedFollowUp = { 96533: reportCompleteItem("96533") };
  const rendered = await client.callTool({
    name: "render_moderation_review",
    arguments: {
      targetContextId,
      batchTitle: "実行直前照合の範囲",
      items: [
        ...Object.values(stopped).map((entry) => entry.item),
        ...Object.values(settled),
        ...Object.values(proceeding),
        ...Object.values(unresent),
        ...Object.values(unconfirmedFollowUp),
        deleteAndCompleteItem("96528"),
        deleteAndCompleteItem("96529"),
      ],
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
      decisions: snapshot.structuredContent.items.map((item) => ({
        itemId: item.id,
        choice: "approve",
        resolvedPlanToken: item.recommendedResolvedPlanToken,
      })),
    },
  });
  assert.equal(submitted.isError, undefined, JSON.stringify(submitted));

  const execute = (itemId, operationIndex = 0) =>
    client.callTool({
      name: "execute_zawazawa_moderation_operation",
      arguments: { targetContextId, batchId: identity.batchId, itemId, operationIndex },
    });

  // 同じ完全案の後続操作を先に呼んでも、外部送信前に停止し記録も残さない。
  const reversed = await execute("96528", 1);
  assert.equal(reversed.isError, true, JSON.stringify(reversed));
  assert.equal(reversed.structuredContent.errorCode, "operation_order_blocked");
  assert.equal(reversed.structuredContent.dispatched, false);
  assert.equal(reversed.structuredContent.browserFallbackAllowed, false);
  const journalAfterReversed = await client.callTool({
    name: "get_moderation_execution_journal",
    arguments: { batchId: identity.batchId },
  });
  assert.equal(
    journalAfterReversed.structuredContent.operations.some(
      (operation) => operation.itemId === "96528",
    ),
    false,
  );

  for (const [itemId, expected] of Object.entries(stopped)) {
    const result = await execute(itemId);
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.errorCode, "precheck_mismatch");
    assert.deepEqual(result.structuredContent.differences, expected.differences);
    assert.equal(result.structuredContent.dispatched, false);
    assert.equal(result.structuredContent.browserFallbackAllowed, false);
  }

  for (const itemId of Object.keys(settled)) {
    const result = await execute(itemId);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.status, "no_action_needed");
    assert.equal(result.structuredContent.dispatched, false);
    // 送らずに確定した操作は終端である。管理画面を読み直さず同じ結果を返し、同じ
    // 承認では送信を開き直せない。
    const again = await execute(itemId);
    assert.equal(again.isError, undefined, JSON.stringify(again));
    assert.equal(again.structuredContent.status, "no_action_needed");
    assert.equal(again.structuredContent.dispatched, false);
  }

  const proceeded = {};
  for (const itemId of Object.keys(proceeding)) {
    const result = await execute(itemId);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.status, "confirmed");
    proceeded[itemId] = result;
  }
  // 承認後に増えた通報も、同じ完了で一緒に閉じる。返すのは件数だけで、理由本文は出さない。
  assert.equal(proceeded["96525"].structuredContent.addedClosedReportCount, 1);
  assert.equal(proceeded["96526"].structuredContent.addedClosedReportCount, undefined);
  // 通報表を読み切れていない完了は、承認済み通報を閉じた後に見えた通報も同じ本文で
  // 閉じ、残件を持ち越さない。
  assert.equal(proceeded["96531"].structuredContent.addedClosedReportCount, 1);
  assert.equal(proceeded["96531"].structuredContent.remainingOpenReportCount, undefined);
  // 効果が出ていないという観測は、送信境界へ入った操作を送り直す根拠にしない。追加の
  // 完了を送るのは、承認済み操作が送信先に含めていなかった通報がある場合だけである。
  const unconfirmed = await execute("96532");
  assert.equal(unconfirmed.isError, undefined, JSON.stringify(unconfirmed));
  assert.equal(unconfirmed.structuredContent.status, "unknown");
  assert.equal(unconfirmed.structuredContent.dispatched, true);
  assert.equal(unconfirmed.structuredContent.addedClosedReportCount, undefined);
  // 二度目の送信が届いていれば残件が増える。1件のままなら送り直していない。
  assert.equal(unconfirmed.structuredContent.remainingOpenReportCount, 1);

  // 追加で送った完了の効果を確認できない場合は、閉じた件数として数えない。未確認を
  // 成功へ寄せず、残件として次回の調査へ回す。
  const unconfirmedExtra = await execute("96533");
  assert.equal(unconfirmedExtra.isError, undefined, JSON.stringify(unconfirmedExtra));
  assert.equal(unconfirmedExtra.structuredContent.status, "confirmed");
  assert.equal(unconfirmedExtra.structuredContent.addedClosedReportCount, undefined);
  assert.equal(unconfirmedExtra.structuredContent.remainingOpenReportCount, 1);

  // 送信境界へ入った操作は、同じ承認では開き直せない。
  const withAddedReport = await execute("96525");
  assert.equal(withAddedReport.structuredContent.errorCode, "already_dispatched");

  // 対象が先に削除済みだった単位。削除は対応不要になり、完了は承認時に確定した
  // 代替本文で送る。モックは想定と違う本文の送信を失敗にする。
  const skippedDelete = await execute("96528", 0);
  assert.equal(skippedDelete.structuredContent.status, "no_action_needed");
  const completed = await execute("96528", 1);
  assert.equal(completed.isError, undefined, JSON.stringify(completed));
  assert.equal(completed.structuredContent.status, "confirmed");
  assert.equal(completed.structuredContent.messageVariant, "already_deleted");

  // 承認済みの削除で削除済みになった単位。代替本文へ切り替えず、承認済みの通常本文を
  // 送る。切り替えるとこちらの対応を「対応前に削除されていた」と通報者へ伝えてしまう。
  const ownDelete = await execute("96529", 0);
  assert.equal(ownDelete.isError, undefined, JSON.stringify(ownDelete));
  assert.equal(ownDelete.structuredContent.status, "confirmed");
  const ownComplete = await execute("96529", 1);
  assert.equal(ownComplete.isError, undefined, JSON.stringify(ownComplete));
  assert.equal(ownComplete.structuredContent.status, "confirmed");
  assert.equal(ownComplete.structuredContent.messageVariant, undefined);

  // 送信していない単位はジャーナルへ残らない。送信した単位と、送らずに確定した
  // 単位だけが記録される。
  const journal = await client.callTool({
    name: "get_moderation_execution_journal",
    arguments: { batchId: identity.batchId },
  });
  assert.deepEqual(
    journal.structuredContent.operations.map((operation) => [
      operation.itemId,
      operation.status,
    ]),
    [
      ["96522", "no_action_needed"],
      ["96525", "confirmed"],
      ["96526", "confirmed"],
      ["96527", "no_action_needed"],
      ["96528", "no_action_needed"],
      ["96528", "confirmed"],
      ["96529", "confirmed"],
      ["96529", "confirmed"],
      ["96530", "no_action_needed"],
      ["96531", "confirmed"],
      ["96532", "unknown"],
      ["96533", "confirmed"],
    ],
  );
});
