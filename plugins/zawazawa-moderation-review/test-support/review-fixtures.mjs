import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * レビュー一覧のテスト用入力と、ストア経由の判断を作る補助。
 *
 * 入力正規化、完全案の解決、承認記録のどのテストからも同じ一覧を組み立てられるよう、
 * 素材だけを持つ。個別の論点に固有の入力は、その論点のtest fileで組み立てる。
 */

export function storeDirectory() {
  return mkdtempSync(join(tmpdir(), "zawazawa-review-"));
}

function item(id, dependencyGroup) {
  return {
    id,
    // 参照解決がトピック名と処置対象から組み立てた表題。ここでは同じ形を直接置く。
    title: `雑談/オデット #${id}`,
    reports: [{ reason: "理由記載なし" }, { reason: "不適切な表現" }],
    comments: [
      {
        commentNumber: id,
        body: "対象コメント本文",
        currentState: "公開中",
      },
    ],
    history: [
      {
        commentNumber: String(Number(id) - 1),
        body: "確認した過去投稿本文",
        currentState: "公開中",
      },
    ],
    publicUrl: `https://example.com/topic/${id}`,
    adminUrl: `https://example.com/admin/${id}`,
    basis: ["運用基準の該当項目"],
    recommendation: {
      targets: [
        {
          commentNumber: id,
          currentState: "公開中",
        },
      ],
      operations: [
        { operationId: "operation-1", operationType: "no_external_action", messageIds: [] },
        { operationId: "operation-2", operationType: "no_external_action", messageIds: [] },
      ],
      messages: [],
    },
    dependencyGroup,
  };
}

export function review(count = 20) {
  return {
    batchTitle: "未処理通報レビュー",
    items: Array.from({ length: count }, (_, index) => item(String(96000 + index))),
  };
}

export function alternativeChanges(overrides = {}) {
  return {
    selectedTargetCommentNumbers: ["96000"],
    selectedOperationIds: ["operation-2"],
    messageChanges: [],
    ...overrides,
  };
}

export function previewedAlternative(store, batch, itemId = "96000", changes = null) {
  const resolvedChanges = changes || alternativeChanges({ selectedTargetCommentNumbers: [itemId] });
  const preview = store.preview({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    itemId,
    changes: resolvedChanges,
    supplementalReason: "管理者判断の補足",
  });
  return {
    itemId,
    choice: "alternative",
    changes: resolvedChanges,
    supplementalReason: "管理者判断の補足",
    resolvedPlanToken: preview.resolvedPlanToken,
  };
}

export function approvedRecommendation(store, batch, itemId = "96000") {
  const snapshot = store.snapshot({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
  });
  const itemSnapshot = snapshot.items.find((entry) => entry.id === itemId);
  assert.ok(itemSnapshot, `snapshotに投稿 ${itemId} がある`);
  return {
    itemId,
    choice: "approve",
    resolvedPlanToken: itemSnapshot.recommendedResolvedPlanToken,
  };
}
