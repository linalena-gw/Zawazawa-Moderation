import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReviewInput } from "../server/review-input.mjs";
import { createReviewStore } from "../server/review-store.mjs";
import {
  alternativeChanges,
  approvedRecommendation,
  review,
  storeDirectory,
} from "../test-support/review-fixtures.mjs";

test("外部操作は既知通報行の安定IDと一意な対象対応を必須にする", () => {
  const externalInput = () => {
    const input = review(1);
    input.items[0].recommendation.operations = [
      {
        operationId: "delete",
        operationType: "comment_delete",
        targetCommentNumbers: ["96000"],
        messageIds: [],
      },
    ];
    return input;
  };

  const missingId = externalInput();
  missingId.items[0].reports = [
    { reportId: "report-a", targetCommentNumber: "96000", reason: "理由A" },
    { targetCommentNumber: "96000", reason: "理由B" },
  ];
  assert.throws(() => normalizeReviewInput(missingId), /安定した通報IDがない/u);

  const ambiguousTarget = externalInput();
  ambiguousTarget.items[0].recommendation.targets.push({
    commentNumber: "96010",
    currentState: "公開中",
  });
  ambiguousTarget.items[0].reports = [{ reportId: "report-a", reason: "理由A" }];
  assert.throws(() => normalizeReviewInput(ambiguousTarget), /一意に対応付け/u);

  const bound = externalInput();
  bound.items[0].reports = [
    { reportId: "report-a", targetCommentNumber: "96000", reason: "理由A" },
  ];
  assert.doesNotThrow(() => normalizeReviewInput(bound));
});

test("通報操作は対象ごとに空でない通報ID集合を必須にする", () => {
  const input = review(1);
  input.items[0].reports = [];
  input.items[0].recommendation.operations = [
    {
      operationId: "complete",
      operationType: "report_complete",
      targetCommentNumbers: ["96000"],
      messageIds: [],
    },
  ];
  assert.throws(() => normalizeReviewInput(input), /未処理通報がありません/u);
});

test("追加候補へ束縛した本文は推奨案から外し、その候補を選んだときだけ送る", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const input = review(1);
  input.items[0].reports = [
    { reportId: "report-a", targetCommentNumber: "96000", reason: "理由" },
  ];
  input.items[0].recommendation.messages = [
    { messageId: "notice", label: "公開案内", text: "この投稿を削除しました。" },
  ];
  input.items[0].recommendation.operations = [
    {
      operationId: "delete",
      operationType: "comment_delete",
      targetCommentNumbers: ["96000"],
      messageIds: [],
    },
  ];
  // 推奨はしないが管理者がその場で選べる候補として、本文つきの公開案内を添える。
  input.items[0].recommendation.operationCandidates = [
    {
      operationId: "notice",
      operationType: "public_notice",
      targetCommentNumbers: ["96000"],
      messageIds: ["notice"],
      highImpact: false,
    },
  ];
  const batch = store.create(normalizeReviewInput(input));
  const displayed = store.snapshot({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
  }).items[0];

  // 推奨案は候補も本文も含まない。選ばない本文を送る約束として見せない。
  assert.deepEqual(
    displayed.recommendedResolvedPlan.operations.map((operation) => operation.operationId),
    ["delete"],
  );
  assert.deepEqual(displayed.recommendedResolvedPlan.messages, []);
  // 候補と本文は一覧のスナップショットには残り、代替案の編集で選べる。
  const candidateIds = displayed.recommendation.operationCandidates.map(
    (candidate) => candidate.operationId,
  );
  assert.deepEqual(candidateIds.slice(0, 2), ["delete", "notice"]);
  // 提案に無い列の措置はサーバーが補うが、既定では選ばれない。
  assert.deepEqual(
    displayed.recommendation.operationCandidates
      .filter((candidate) => candidate.selectedByDefault)
      .map((candidate) => candidate.operationId),
    ["delete"],
  );
  assert.deepEqual(
    displayed.recommendation.messages.map((message) => message.messageId),
    ["notice"],
  );

  // 候補を選んだ代替案でだけ本文が完全案へ入る。
  const preview = store.preview({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    itemId: "96000",
    changes: alternativeChanges({ selectedOperationIds: ["delete", "notice"] }),
  });
  assert.deepEqual(
    preview.resolvedPlan.operations.map((operation) => operation.operationId),
    ["delete", "notice"],
  );
  assert.deepEqual(
    preview.resolvedPlan.messages.map((message) => message.text),
    ["この投稿を削除しました。"],
  );

  // 候補を選ばないまま代替案を出すと推奨案と同じ実行内容になる。UIはこのとき
  // 候補の本文をomitとして送るため、変更なしとして止まる。
  assert.throws(
    () =>
      store.preview({
        batchId: batch.batchId,
        snapshotToken: batch.snapshotToken,
        itemId: "96000",
        changes: alternativeChanges({
          selectedOperationIds: ["delete"],
          messageChanges: [{ messageId: "notice", action: "omit" }],
        }),
      }),
    /推奨案のまま実行する場合は推奨案を承認/u,
  );
});

test("代替案プレビューは編集不可の状態と通報IDを保存済みスナップショットから解決する", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const input = review(1);
  input.items[0].reports = [
    { reportId: "report-1", targetCommentNumber: "96000", reason: "理由" },
    { reportId: "report-2", targetCommentNumber: "96010", reason: "別の理由" },
  ];
  input.items[0].recommendation.targets.push({
    commentNumber: "96010",
    currentState: "非表示",
  });
  input.items[0].recommendation.operations = [
    {
      operationId: "delete",
      operationType: "comment_delete",
      targetCommentNumbers: ["96000", "96010"],
      messageIds: [],
    },
    {
      operationId: "complete",
      operationType: "report_complete",
      targetCommentNumbers: ["96000", "96010"],
      messageIds: ["report-message"],
    },
  ];
  input.items[0].recommendation.operationCandidates = [
    {
      operationId: "keep",
      operationType: "no_external_action",
      targetCommentNumbers: ["96000", "96010"],
      messageIds: [],
      highImpact: false,
    },
    {
      operationId: "block",
      operationType: "author_auto_ignore",
      targetCommentNumbers: ["96000"],
      messageIds: [],
      highImpact: true,
    },
  ];
  input.items[0].recommendation.messages = [
    { messageId: "report-message", label: "通報者への案内", text: "削除しました。" },
  ];
  const batch = store.create(normalizeReviewInput(input));
  const changes = {
    selectedTargetCommentNumbers: ["96010"],
    selectedOperationIds: ["keep", "complete"],
    messageChanges: [
      {
        messageId: "report-message",
        action: "replace",
        replacement: { label: "通報者への案内", text: "確認のうえ維持しました。" },
      },
    ],
  };
  const preview = store.preview({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    itemId: "96000",
    changes,
    supplementalReason: "文脈を踏まえた裁量",
  });

  assert.equal(store.get(batch.batchId).submission, null);
  assert.deepEqual(preview.resolvedPlan.targets, [
    { commentNumber: "96010", currentState: "非表示" },
  ]);
  assert.equal(preview.resolvedPlan.reportCount, 1);
  assert.deepEqual(preview.resolvedPlan.reportIds, ["report-2"]);
  assert.equal(preview.resolvedPlan.snapshotReportCount, 2);
  assert.deepEqual(preview.resolvedPlan.snapshotReportIds, ["report-1", "report-2"]);
  assert.deepEqual(preview.resolvedPlan.reportBindings, [
    { reportId: "report-2", targetCommentNumber: "96010" },
  ]);
  assert.deepEqual(
    preview.resolvedPlan.operations.map((operation) => ({
      operationId: operation.operationId,
      targetCommentNumbers: operation.targetCommentNumbers,
    })),
    // 実行順は候補の宣言順で決まる。選択の入力順（keep→complete）には従わない。
    [
      { operationId: "complete", targetCommentNumbers: ["96010"] },
      { operationId: "keep", targetCommentNumbers: ["96010"] },
    ],
  );
  assert.equal(preview.resolvedPlan.messages[0].text, "確認のうえ維持しました。");
  assert.deepEqual(preview.resolvedPlan.executionSteps, [
    {
      operationIndex: 0,
      planOperationId: "complete",
      operationType: "report_complete",
      targetCommentNumber: "96010",
      reportIds: ["report-2"],
      messages: [
        {
          messageId: "report-message",
          label: "通報者への案内",
          text: "確認のうえ維持しました。",
        },
      ],
    },
  ]);

  store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [
      {
        itemId: "96000",
        choice: "alternative",
        changes,
        supplementalReason: "文脈を踏まえた裁量",
        resolvedPlanToken: preview.resolvedPlanToken,
      },
    ],
  });
  const execution = store.get(batch.batchId, { scope: "execution" });
  assert.deepEqual(execution.submission.authorizedPlans[0].resolvedPlan, preview.resolvedPlan);
  assert.equal(
    execution.submission.authorizedPlans[0].resolvedPlanToken,
    preview.resolvedPlanToken,
  );
});

test("型付き操作を宣言済み対象だけへ順序付き原子操作として解決する", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const input = review(1);
  input.items[0].reports = [
    { reportId: "report-a", targetCommentNumber: "96000", reason: "理由A" },
    { reportId: "report-b", targetCommentNumber: "96010", reason: "理由B" },
  ];
  input.items[0].recommendation.targets.push({
    commentNumber: "96010",
    currentState: "公開中",
  });
  input.items[0].recommendation.operations = [
    {
      operationId: "delete-second",
      operationType: "comment_delete",
      targetCommentNumbers: ["96010"],
      messageIds: [],
    },
    {
      operationId: "complete-reports",
      operationType: "report_complete",
      targetCommentNumbers: ["96010", "96000"],
      messageIds: [],
    },
    {
      operationId: "auto-ignore-author",
      operationType: "author_auto_ignore",
      // 投稿者単位の操作も、重複実行を防ぐため一対象をanchorにする。
      targetCommentNumbers: ["96000"],
      messageIds: [],
    },
    {
      operationId: "publish-notice",
      operationType: "public_notice",
      targetCommentNumbers: ["96010"],
      messageIds: ["public-message"],
    },
    {
      operationId: "keep-note",
      operationType: "no_external_action",
      targetCommentNumbers: ["96000", "96010"],
      messageIds: [],
    },
  ];
  input.items[0].recommendation.messages = [
    { messageId: "public-message", label: "公開案内", text: "対応を実施しました。" },
  ];
  const batch = store.create(normalizeReviewInput(input));
  const approval = approvedRecommendation(store, batch);

  assert.throws(
    () =>
      store.preview({
        batchId: batch.batchId,
        snapshotToken: batch.snapshotToken,
        itemId: "96000",
        changes: {
          selectedTargetCommentNumbers: ["96010"],
          selectedOperationIds: ["auto-ignore-author"],
          messageChanges: [],
        },
      }),
    /選択済み対象がありません/u,
  );

  store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [approval],
  });
  const plan = store.get(batch.batchId, { scope: "execution" })
    .submission.authorizedPlans[0].resolvedPlan;
  assert.deepEqual(plan.executionSteps, [
    {
      operationIndex: 0,
      planOperationId: "delete-second",
      operationType: "comment_delete",
      targetCommentNumber: "96010",
      reportIds: ["report-b"],
      messages: [],
    },
    {
      operationIndex: 1,
      planOperationId: "complete-reports",
      operationType: "report_complete",
      targetCommentNumber: "96010",
      reportIds: ["report-b"],
      messages: [],
    },
    {
      operationIndex: 2,
      planOperationId: "complete-reports",
      operationType: "report_complete",
      targetCommentNumber: "96000",
      reportIds: ["report-a"],
      messages: [],
    },
    {
      operationIndex: 3,
      planOperationId: "auto-ignore-author",
      operationType: "author_auto_ignore",
      targetCommentNumber: "96000",
      reportIds: ["report-a", "report-b"],
      messages: [],
    },
    {
      operationIndex: 4,
      planOperationId: "publish-notice",
      operationType: "public_notice",
      targetCommentNumber: "96010",
      reportIds: ["report-a", "report-b"],
      messages: [
        { messageId: "public-message", label: "公開案内", text: "対応を実施しました。" },
      ],
    },
  ]);
  assert.equal(
    plan.executionSteps.some((step) => step.planOperationId === "keep-note"),
    false,
  );
});

test("古い解決済み案トークンと表示外・別単位・新規高影響の変更を拒否する", () => {
  const makeStore = () => {
    const store = createReviewStore({ directory: storeDirectory() });
    const input = review(2);
    input.items[0].recommendation.operations = [
      { operationId: "delete", messageIds: [] },
      { operationId: "complete", messageIds: [] },
    ];
    input.items[0].recommendation.operationCandidates = [
      { operationId: "keep", messageIds: [], highImpact: false },
      { operationId: "block", messageIds: [], highImpact: true },
    ];
    input.items[1].recommendation.operations = [
      { operationId: "other-unit", messageIds: [] },
    ];
    const batch = store.create(normalizeReviewInput(input));
    return { store, batch };
  };

  {
    const { store, batch } = makeStore();
    const original = {
      selectedTargetCommentNumbers: ["96000"],
      selectedOperationIds: ["complete"],
      messageChanges: [],
    };
    const preview = store.preview({
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      itemId: "96000",
      changes: original,
    });
    assert.throws(
      () =>
        store.submit({
          batchId: batch.batchId,
          snapshotToken: batch.snapshotToken,
          decisions: [
            {
              itemId: "96000",
              choice: "alternative",
              changes: { ...original, selectedOperationIds: ["keep", "complete"] },
              resolvedPlanToken: preview.resolvedPlanToken,
            },
          ],
        }),
      /プレビュー後に変わりました/u,
    );
  }
  for (const [changes, pattern] of [
    [
      {
        selectedTargetCommentNumbers: ["99999"],
        selectedOperationIds: ["complete"],
        messageChanges: [],
      },
      /表示されていません/u,
    ],
    [
      {
        selectedTargetCommentNumbers: ["96000"],
        selectedOperationIds: ["other-unit"],
        messageChanges: [],
      },
      /別単位への波及/u,
    ],
    [
      {
        selectedTargetCommentNumbers: ["96000"],
        selectedOperationIds: ["block", "complete"],
        messageChanges: [],
      },
      /新しい高影響措置/u,
    ],
  ]) {
    const { store, batch } = makeStore();
    assert.throws(
      () =>
        store.preview({
          batchId: batch.batchId,
          snapshotToken: batch.snapshotToken,
          itemId: "96000",
          changes,
        }),
      pattern,
    );
  }
});

test("メッセージの扱いは操作の選択と本文の編集から決まる", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const input = review(1);
  input.items[0].reports = [
    { reportId: "report-a", targetCommentNumber: "96000", reason: "理由A" },
    { reportId: "report-b", targetCommentNumber: "96000", reason: "理由B" },
  ];
  input.items[0].recommendation.messages = [
    { messageId: "report-message", label: "通報者への案内", text: "削除しました。" },
  ];
  input.items[0].recommendation.operations = [
    {
      operationId: "operation-1",
      operationType: "no_external_action",
      targetCommentNumbers: ["96000"],
      messageIds: [],
    },
    {
      operationId: "operation-2",
      operationType: "report_complete",
      targetCommentNumbers: ["96000"],
      messageIds: ["report-message"],
    },
  ];
  const batch = store.create(normalizeReviewInput(input));

  // 扱いを明示しなくても、選択した操作へ束縛された本文はそのまま維持する。
  const kept = store.preview({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    itemId: "96000",
    changes: alternativeChanges(),
  });
  assert.deepEqual(
    kept.resolvedPlan.messages.map((message) => message.text),
    ["削除しました。"],
  );
  assert.deepEqual(kept.changes.messageChanges, [
    { messageId: "report-message", action: "keep" },
  ]);

  // 送信しないを選んだ本文だけが落ちる。
  const omitted = store.preview({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    itemId: "96000",
    changes: alternativeChanges({
      messageChanges: [{ messageId: "report-message", action: "omit" }],
    }),
  });
  assert.deepEqual(omitted.resolvedPlan.messages, []);

  // 束縛先の操作を外したまま本文を残すと、孤立した本文として止まる。
  assert.throws(
    () =>
      store.preview({
        batchId: batch.batchId,
        snapshotToken: batch.snapshotToken,
        itemId: "96000",
        changes: alternativeChanges({ selectedOperationIds: ["operation-1"] }),
      }),
    /選択した操作に結び付いていません/u,
  );
});

// 通報対象を保持したまま返信だけ削除する場合、単一の対象選択では「削除対象から外す」と
// 「通報を閉じる対象から外す」を区別できない。操作別の絞り込みだけがこれを表せる。
function narrowingReview() {
  const input = review(1);
  const target = input.items[0];
  target.reports = [{ reportId: "report-a", targetCommentNumber: "96000", reason: "理由" }];
  target.comments.push({
    commentNumber: "96100",
    body: "返信コメント本文",
    currentState: "公開中",
    parentCommentNumber: "96000",
  });
  target.recommendation.targets = [
    { commentNumber: "96000", currentState: "公開中" },
    { commentNumber: "96100", currentState: "公開中" },
  ];
  target.recommendation.messages = [
    { messageId: "reply", label: "通報者への案内", text: "対処しました。" },
  ];
  target.recommendation.operations = [
    {
      operationId: "delete",
      operationType: "comment_delete",
      targetCommentNumbers: ["96000", "96100"],
      messageIds: [],
    },
    {
      operationId: "complete",
      operationType: "report_complete",
      targetCommentNumbers: ["96000"],
      messageIds: ["reply"],
    },
  ];
  return input;
}

function narrowingChanges(overrides = {}) {
  return {
    selectedTargetCommentNumbers: ["96000", "96100"],
    selectedOperationIds: ["delete", "complete"],
    messageChanges: [],
    ...overrides,
  };
}

test("操作別の対象絞り込みは、通報を閉じる対象を残したまま削除対象だけを狭める", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const batch = store.create(normalizeReviewInput(narrowingReview()));
  const preview = store.preview({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    itemId: "96000",
    changes: narrowingChanges({
      operationTargets: [{ operationId: "delete", targetCommentNumbers: ["96100"] }],
    }),
  });
  const operations = preview.resolvedPlan.operations;
  assert.deepEqual(
    operations.map((operation) => [operation.operationId, operation.targetCommentNumbers]),
    [
      ["delete", ["96100"]],
      ["complete", ["96000"]],
    ],
  );
  // 原子操作も狭めた対象だけへ展開し、通報は元の対象で閉じる。
  assert.deepEqual(
    preview.resolvedPlan.executionSteps.map((step) => [
      step.planOperationId,
      step.targetCommentNumber,
    ]),
    [
      ["delete", "96100"],
      ["complete", "96000"],
    ],
  );
});

test("対象の絞り込みだけでも代替案として成立する", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const batch = store.create(normalizeReviewInput(narrowingReview()));
  assert.doesNotThrow(() =>
    store.preview({
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      itemId: "96000",
      changes: narrowingChanges({
        operationTargets: [{ operationId: "delete", targetCommentNumbers: ["96000"] }],
      }),
    }),
  );
  // 宣言対象と同じ絞り込みは変更ではないため、推奨案の承認へ戻す。
  assert.throws(
    () =>
      store.preview({
        batchId: batch.batchId,
        snapshotToken: batch.snapshotToken,
        itemId: "96000",
        changes: narrowingChanges({
          operationTargets: [
            { operationId: "delete", targetCommentNumbers: ["96000", "96100"] },
            { operationId: "complete", targetCommentNumbers: ["96000"] },
          ],
        }),
      }),
    /推奨案のまま実行する場合は推奨案を承認してください/u,
  );
});

test("操作別の対象絞り込みは選択済み対象と選択済み操作の外へ広げられない", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const batch = store.create(normalizeReviewInput(narrowingReview()));
  const previewWith = (changes) =>
    store.preview({
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      itemId: "96000",
      changes,
    });

  assert.throws(
    () =>
      previewWith(
        narrowingChanges({
          selectedTargetCommentNumbers: ["96000"],
          operationTargets: [{ operationId: "delete", targetCommentNumbers: ["96100"] }],
        }),
      ),
    /選択済み対象にありません/u,
  );
  assert.throws(
    () =>
      previewWith(
        narrowingChanges({
          selectedOperationIds: ["complete"],
          operationTargets: [{ operationId: "delete", targetCommentNumbers: ["96100"] }],
        }),
      ),
    /は選択されていません/u,
  );
  assert.throws(
    () =>
      previewWith(
        narrowingChanges({
          operationTargets: [
            { operationId: "delete", targetCommentNumbers: ["96100"] },
            { operationId: "delete", targetCommentNumbers: ["96000"] },
          ],
        }),
      ),
    /対象指定が重複しています/u,
  );
  assert.throws(
    () =>
      previewWith(
        narrowingChanges({
          operationTargets: [{ operationId: "complete", targetCommentNumbers: ["96100"] }],
        }),
      ),
    /選択済み対象がありません/u,
  );
});

test("処置対象に選べるのは現在状態と公開URLを解決できたコメントだけとする", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const input = narrowingReview();
  const target = input.items[0];
  // 公開ページにも管理画面にも状態欄が無かった文脈コメント。処置対象候補ではない。
  target.comments.push({
    commentNumber: "96200",
    body: "状態を確認できなかった前後文脈",
    url: "https://z.wikiwiki.jp/g/topic/500/96200",
  });
  // 状態は読めたがURLを解決できなかった文脈コメント。
  target.comments.push({
    commentNumber: "96300",
    body: "管理画面を特定できない前後文脈",
    currentState: "公開中",
  });
  // 両方そろった文脈コメントは、提案に無くても処置対象に選べる。
  target.comments.push({
    commentNumber: "96400",
    body: "状態もURLも解決できた前後文脈",
    currentState: "公開中",
    url: "https://z.wikiwiki.jp/g/topic/500/96400",
  });
  const batch = store.create(normalizeReviewInput(input));
  const previewWith = (changes) =>
    store.preview({
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      itemId: "96000",
      changes,
    });

  for (const commentNumber of ["96200", "96300"]) {
    assert.throws(
      () =>
        previewWith(
          narrowingChanges({
            selectedTargetCommentNumbers: ["96000", "96100", commentNumber],
            operationTargets: [
              { operationId: "delete", targetCommentNumbers: ["96000", "96100", commentNumber] },
            ],
          }),
        ),
      /表示されていません/u,
      `${commentNumber}を処置対象に通してはならない`,
    );
  }

  const preview = previewWith(
    narrowingChanges({
      selectedTargetCommentNumbers: ["96000", "96100", "96400"],
      operationTargets: [
        { operationId: "delete", targetCommentNumbers: ["96000", "96100", "96400"] },
      ],
    }),
  );
  // 承認時状態と管理画面の解決元は、選んだ行のぶんもサーバーの解決値だけで埋める。
  assert.deepEqual(
    preview.resolvedPlan.targets.map((entry) => [entry.commentNumber, entry.currentState]),
    [
      ["96000", "公開中"],
      ["96100", "公開中"],
      ["96400", "公開中"],
    ],
  );
  assert.deepEqual(
    preview.resolvedPlan.executionSteps
      .filter((step) => step.operationType === "comment_delete")
      .map((step) => step.targetCommentNumber),
    ["96000", "96100", "96400"],
  );
});

test("削除済みだった場合の代替本文は、送る場面のある操作へ束縛したときだけ受け取る", () => {
  const withFallback = (operationType) => {
    const input = review(1);
    input.items[0].reports = [
      { reportId: "report-1", targetCommentNumber: "96000", reason: "理由" },
    ];
    input.items[0].recommendation.operations = [
      {
        operationId: "reply-operation",
        operationType,
        targetCommentNumbers: ["96000"],
        messageIds: ["reply"],
      },
    ];
    input.items[0].recommendation.messages = [
      {
        messageId: "reply",
        label: "通報者への回答",
        text: "削除しました。",
        alreadyDeletedText: "対応前に削除されていることを確認しました。",
      },
    ];
    return input;
  };

  // 公開案内には「対象が先に削除済みだった場合」に送る場面が無い。
  assert.throws(
    () => normalizeReviewInput(withFallback("public_notice")),
    /削除済みだった場合の本文を送れません/u,
  );

  const store = createReviewStore({ directory: storeDirectory() });
  const batch = store.create(normalizeReviewInput(withFallback("report_complete")));
  const snapshot = store.snapshot({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
  });
  const [step] = snapshot.items[0].recommendedResolvedPlan.executionSteps;
  assert.equal(step.operationType, "report_complete");
  assert.deepEqual(step.messages, [
    {
      messageId: "reply",
      label: "通報者への回答",
      text: "削除しました。",
      alreadyDeletedText: "対応前に削除されていることを確認しました。",
    },
  ]);

  // 通常の本文だけを書き換える代替案は、承認済みの代替本文を落とさない。
  const preview = store.preview({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    itemId: "96000",
    changes: {
      selectedTargetCommentNumbers: ["96000"],
      selectedOperationIds: ["reply-operation"],
      messageChanges: [
        {
          messageId: "reply",
          action: "replace",
          replacement: { label: "通報者への回答", text: "関連投稿とあわせて削除しました。" },
        },
      ],
    },
  });
  assert.deepEqual(preview.resolvedPlan.executionSteps[0].messages, [
    {
      messageId: "reply",
      label: "通報者への回答",
      text: "関連投稿とあわせて削除しました。",
      alreadyDeletedText: "対応前に削除されていることを確認しました。",
    },
  ]);

  // 代替本文だけの書き換えも、実行内容の変更として代替案になる。
  const fallbackOnly = store.preview({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    itemId: "96000",
    changes: {
      selectedTargetCommentNumbers: ["96000"],
      selectedOperationIds: ["reply-operation"],
      messageChanges: [
        {
          messageId: "reply",
          action: "replace",
          replacement: {
            label: "通報者への回答",
            text: "削除しました。",
            alreadyDeletedText: "対応前に削除されていました。",
          },
        },
      ],
    },
  });
  assert.equal(
    fallbackOnly.resolvedPlan.executionSteps[0].messages[0].alreadyDeletedText,
    "対応前に削除されていました。",
  );
});

test("無視だけを安定した通報ID順に原子化し、一括完了の単位は維持する", () => {
  for (const operationType of ["report_ignore", "report_complete"]) {
    const input = review(1);
    input.items[0].reports = ["report-b", "report-a"].map((reportId) => ({ reportId, reason: "テスト理由", targetCommentNumber: "96000" }));
    input.items[0].recommendation.operations = [{ operationId: "close", operationType,
      targetCommentNumbers: ["96000"], messageIds: [] }];
    const store = createReviewStore({ directory: storeDirectory() });
    const batch = store.create(normalizeReviewInput(input));
    const plan = store.snapshot(batch).items[0].recommendedResolvedPlan;
    assert.deepEqual(plan.executionSteps.map((step) => step.reportIds),
      operationType === "report_ignore" ? [["report-a"], ["report-b"]] : [["report-a", "report-b"]]);
    assert.deepEqual(plan.executionSteps.map((step) => step.operationIndex),
      operationType === "report_ignore" ? [0, 1] : [0]);
  }
});
