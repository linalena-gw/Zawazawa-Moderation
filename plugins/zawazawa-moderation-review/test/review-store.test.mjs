import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { normalizeReviewInput } from "../server/review-input.mjs";
import { createReviewStore, ReviewStoreIntegrityError } from "../server/review-store.mjs";
import {
  approvedRecommendation,
  previewedAlternative,
  review,
  storeDirectory,
} from "../test-support/review-fixtures.mjs";

test("自由文だけの代替案から実行許可を作らない", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const batch = store.create(normalizeReviewInput(review(1)));
  assert.throws(
    () =>
      store.submit({
        batchId: batch.batchId,
        snapshotToken: batch.snapshotToken,
        decisions: [
          { itemId: "96000", choice: "alternative", alternative: "通報だけ完了する" },
        ],
      }),
    /自由文だけ/u,
  );
});

test("送信はスナップショットに固定され再送できない", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const batch = store.create(normalizeReviewInput(review(2)));
  const approval = approvedRecommendation(store, batch);
  assert.throws(
    () =>
      store.submit({
        batchId: batch.batchId,
        snapshotToken: "0".repeat(64),
        decisions: [approval],
      }),
    /スナップショット/u,
  );
  const submitted = store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [approval],
  });
  assert.equal(submitted.submission.approvedCount, 1);
  assert.equal(submitted.submission.executableAuthorizedCount, 1);
  const execution = store.get(batch.batchId, { scope: "execution" });
  assert.deepEqual(execution.submission.executableAuthorizedItemIds, ["96000"]);
  assert.equal(execution.submission.authorizedPlans[0].resolvedPlan.targets[0].currentState, "公開中");
  assert.throws(
    () =>
      store.submit({
        batchId: batch.batchId,
        snapshotToken: batch.snapshotToken,
        decisions: [{ itemId: "96001", choice: "hold" }],
      }),
    /送信済み/u,
  );
});

test("推奨案は表示済み完全案の一致トークンだけで承認する", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const input = review(1);
  input.items[0].reports = [
    { reportId: "report-delete", targetCommentNumber: "96000", reason: "理由" },
  ];
  input.items[0].recommendation.operations = [
    {
      operationId: "delete",
      operationType: "comment_delete",
      targetCommentNumbers: ["96000"],
      messageIds: [],
    },
  ];
  const batch = store.create(normalizeReviewInput(input));
  const snapshot = store.snapshot({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
  });
  const displayed = snapshot.items[0];
  assert.equal(displayed.recommendedResolvedPlan.operations[0].operationTypeLabel, "コメント削除");
  assert.deepEqual(displayed.recommendedResolvedPlan.executionSteps, [
    {
      operationIndex: 0,
      planOperationId: "delete",
      operationType: "comment_delete",
      targetCommentNumber: "96000",
      reportIds: ["report-delete"],
      messages: [],
    },
  ]);
  assert.match(displayed.recommendedResolvedPlanToken, /^[0-9a-f]{64}$/u);

  assert.throws(
    () => store.submit({
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      decisions: [{ itemId: "96000", choice: "approve" }],
    }),
    /推奨完全案トークン/u,
  );
  assert.throws(
    () => store.submit({
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      decisions: [{
        itemId: "96000",
        choice: "approve",
        resolvedPlanToken: "f".repeat(64),
      }],
    }),
    /表示後に変わりました/u,
  );

  store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [{
      itemId: "96000",
      choice: "approve",
      resolvedPlanToken: displayed.recommendedResolvedPlanToken,
    }],
  });
  const authorized = store.get(batch.batchId, { scope: "execution" })
    .submission.authorizedPlans[0];
  assert.deepEqual(authorized.resolvedPlan, displayed.recommendedResolvedPlan);
  assert.equal(authorized.resolvedPlanToken, displayed.recommendedResolvedPlanToken);
});

test("依存グループの一部承認を実行候補から外す", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const input = review(2);
  input.items[0].dependencyGroup = "tree-1";
  input.items[1].dependencyGroup = "tree-1";
  const batch = store.create(normalizeReviewInput(input));
  const approval = approvedRecommendation(store, batch);
  const submitted = store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [
      approval,
      { itemId: "96001", choice: "hold" },
    ],
  });
  assert.equal(submitted.submission.blockedDependencyGroupCount, 1);
  const execution = store.get(batch.batchId, { scope: "execution" });
  assert.equal(execution.submission.blockedDependencyGroups.length, 1);
  assert.deepEqual(execution.submission.executableAuthorizedItemIds, []);
});

test("プレビュー済みの構造化代替案を完全案への実行許可として扱う", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const batch = store.create(normalizeReviewInput(review(1)));
  const decision = previewedAlternative(store, batch);
  const submitted = store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [decision],
  });
  assert.equal(submitted.submission.alternativeCount, 1);
  const execution = store.get(batch.batchId, { scope: "execution" });
  assert.deepEqual(execution.submission.executableAuthorizedItemIds, ["96000"]);
  assert.deepEqual(
    execution.submission.authorizedPlans[0].resolvedPlan.operations.map(
      (operation) => operation.operationId,
    ),
    ["operation-2"],
  );
});

test("summaryは本文を返さずexecutionだけが承認済み完全案を返す", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const batch = store.create(normalizeReviewInput(review(1)));
  assert.equal(batch.items, undefined);
  assert.doesNotMatch(JSON.stringify(batch), /対象コメント本文|確認した過去投稿本文|理由記載なし/u);
  store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [approvedRecommendation(store, batch)],
  });
  const summary = store.get(batch.batchId, { scope: "summary" });
  const execution = store.get(batch.batchId, { scope: "execution" });
  assert.equal(summary.submission.executableAuthorizedCount, 1);
  assert.equal(summary.submission.authorizedPlans, undefined);
  assert.equal(execution.submission.authorizedPlans.length, 1);
  assert.deepEqual(execution.submission.authorizedPlans[0].resolvedPlan.reportIds, []);
  // 人間の承認はその出所として記録に残り、自律承認と取り違えられない。
  assert.equal(summary.submission.authorizedBy, "administrator");
  assert.equal(execution.submission.authorizedBy, "administrator");
  assert.throws(
    () => store.get(batch.batchId, { scope: "full" }),
    /summary、execution、decision_diff、report/u,
  );
});

test("判断差分は全判断を分類し変更単位だけの基準レビュー入力を返す", () => {
  const directory = storeDirectory();
  const store = createReviewStore({ directory });
  const input = review(4);
  const textItem = input.items[3];
  textItem.reports = [];
  textItem.recommendation.operations = [
    {
      operationId: "notice",
      operationType: "public_notice",
      targetCommentNumbers: [textItem.id],
      messageIds: ["notice-message"],
    },
  ];
  textItem.recommendation.messages = [
    { messageId: "notice-message", label: "公開案内", text: "初期本文" },
  ];
  const batch = store.create(normalizeReviewInput(input), { groupKey: "g" });
  assert.throws(
    () => store.get(batch.batchId, { scope: "decision_diff" }),
    /未送信/u,
  );

  const textPreview = store.preview({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    itemId: textItem.id,
    changes: {
      selectedTargetCommentNumbers: [textItem.id],
      selectedOperationIds: ["notice"],
      messageChanges: [
        {
          messageId: "notice-message",
          action: "replace",
          replacement: { label: "公開案内", text: "最終本文" },
        },
      ],
    },
    supplementalReason: "表現を明確にするため",
  });
  const noAction = previewedAlternative(store, batch, "96002");
  store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [
      approvedRecommendation(store, batch, "96000"),
      { itemId: "96001", choice: "hold" },
      noAction,
      {
        itemId: textItem.id,
        choice: "alternative",
        changes: textPreview.changes,
        supplementalReason: textPreview.supplementalReason,
        resolvedPlanToken: textPreview.resolvedPlanToken,
      },
    ],
  });

  const restarted = createReviewStore({ directory });
  const manifest = restarted.get(batch.batchId, { scope: "decision_diff" });
  assert.deepEqual(manifest.changedItemIds, ["96001", "96002", "96003"]);
  assert.deepEqual(
    manifest.units.map(({ itemId, decisionType, differsFromRecommendation, changedFields }) => ({
      itemId,
      decisionType,
      differsFromRecommendation,
      changedFields,
    })),
    [
      {
        itemId: "96000",
        decisionType: "recommended_approved",
        differsFromRecommendation: false,
        changedFields: [],
      },
      {
        itemId: "96001",
        decisionType: "held",
        differsFromRecommendation: true,
        changedFields: ["decision"],
      },
      {
        itemId: "96002",
        decisionType: "alternative_no_external_action",
        differsFromRecommendation: true,
        changedFields: ["operations"],
      },
      {
        itemId: "96003",
        decisionType: "alternative",
        differsFromRecommendation: true,
        changedFields: ["messages"],
      },
    ],
  );

  const detail = restarted.get(batch.batchId, {
    scope: "decision_diff",
    itemId: "96003",
  });
  assert.deepEqual(detail.unit.recommendation.basis, ["運用基準の該当項目"]);
  assert.equal(detail.unit.recommendation.resolvedPlan.messages[0].text, "初期本文");
  assert.equal(detail.unit.finalDecision.resolvedPlan.messages[0].text, "最終本文");
  assert.equal(detail.unit.finalDecision.supplementalReason, "表現を明確にするため");
  assert.equal(detail.unit.context.comments[0].body, "対象コメント本文");
  assert.doesNotMatch(JSON.stringify(detail), /resolvedPlanToken|snapshotToken/u);
  assert.throws(
    () => restarted.get(batch.batchId, { scope: "decision_diff", itemId: "96000" }),
    /初期推奨案と同じ/u,
  );
});

test("依存グループ内の推奨案承認と代替案承認をともに実行候補にする", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const input = review(2);
  input.items[0].dependencyGroup = "tree-1";
  input.items[1].dependencyGroup = "tree-1";
  const batch = store.create(normalizeReviewInput(input));
  const alternative = previewedAlternative(store, batch, "96001");
  const submitted = store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [
      approvedRecommendation(store, batch),
      alternative,
    ],
  });
  assert.equal(submitted.submission.blockedDependencyGroupCount, 0);
  assert.deepEqual(store.get(batch.batchId, { scope: "execution" }).submission.executableAuthorizedItemIds, [
    "96000",
    "96001",
  ]);
});

test("別プロセスのストアから同じbatchIdの承認を読み戻せる", () => {
  const directory = storeDirectory();
  const reviewer = createReviewStore({ directory });
  const batch = reviewer.create(normalizeReviewInput(review(1)));
  reviewer.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [approvedRecommendation(reviewer, batch)],
  });

  const executor = createReviewStore({ directory });
  const loaded = executor.get(batch.batchId, { scope: "execution" });
  assert.equal(loaded.expired, false);
  assert.deepEqual(loaded.submission.executableAuthorizedItemIds, ["96000"]);
});

test("承認記録へ書き足した導出値は実行許可を作らない", () => {
  const directory = storeDirectory();
  const store = createReviewStore({ directory });
  const input = review(2);
  input.items[0].dependencyGroup = "tree-1";
  input.items[1].dependencyGroup = "tree-1";
  const batch = store.create(normalizeReviewInput(input));
  store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [
      approvedRecommendation(store, batch),
      { itemId: "96001", choice: "hold" },
    ],
  });

  const path = join(directory, `${batch.batchId}.submission.json`);
  const stored = JSON.parse(readFileSync(path, "utf8"));
  // 保存するのは判断という事実だけ。導出値は保存されない。
  assert.equal(stored.executableAuthorizedItemIds, undefined);
  assert.equal(stored.blockedDependencyGroups, undefined);
  // 依存グループで止めた単位を、判断を変えずに実行候補へ戻そうとする書き足し。
  writeFileSync(
    path,
    JSON.stringify({
      ...stored,
      blockedDependencyGroups: [],
      executableAuthorizedItemIds: ["96000"],
      executableApprovedItemIds: ["96000"],
    }),
  );

  const executor = createReviewStore({ directory });
  const loaded = executor.get(batch.batchId, { scope: "execution" });
  // 実行許可は毎回判断から導く。保存ファイルの側の値は採用しない。
  assert.deepEqual(loaded.submission.executableAuthorizedItemIds, []);
  assert.equal(loaded.submission.blockedDependencyGroups.length, 1);
});

test("保存済み完全案の改ざんを、判断を変えなくても破損として止める", () => {
  const directory = storeDirectory();
  const store = createReviewStore({ directory });
  const batch = store.create(normalizeReviewInput(review(1)));
  store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [approvedRecommendation(store, batch)],
  });

  const path = join(directory, `${batch.batchId}.submission.json`);
  const stored = JSON.parse(readFileSync(path, "utf8"));
  // 判断も導出値も変えず、送信する対象だけを差し替える改ざん。
  const [decision] = stored.decisions;
  decision.resolvedPlan.targets[0].commentNumber = "99999";
  writeFileSync(path, JSON.stringify(stored));

  const executor = createReviewStore({ directory });
  assert.throws(
    () => executor.get(batch.batchId, { scope: "execution" }),
    ReviewStoreIntegrityError,
  );
  assert.throws(
    () => executor.get(batch.batchId, { scope: "summary" }),
    /完全案が承認時の内容と一致しません/u,
  );
});

test("導出値を保存していない承認記録も判断内容から実行許可を再計算する", () => {
  const directory = storeDirectory();
  const store = createReviewStore({ directory });
  const batch = store.create(normalizeReviewInput(review(1)));
  store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [approvedRecommendation(store, batch)],
  });

  const path = join(directory, `${batch.batchId}.submission.json`);
  const { decisions, submissionId, batchId, snapshotToken, submittedAt, expiresAt } =
    JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(
    path,
    JSON.stringify({ submissionId, batchId, snapshotToken, submittedAt, expiresAt, decisions }),
  );

  const loaded = createReviewStore({ directory }).get(batch.batchId, {
    scope: "execution",
  });
  assert.deepEqual(loaded.submission.executableAuthorizedItemIds, ["96000"]);
  assert.deepEqual(loaded.submission.blockedDependencyGroups, []);
});

test("別ストアからの二重送信を拒否する", () => {
  const directory = storeDirectory();
  const first = createReviewStore({ directory });
  const batch = first.create(normalizeReviewInput(review(1)));
  first.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [approvedRecommendation(first, batch)],
  });

  const second = createReviewStore({ directory });
  assert.throws(
    () =>
      second.submit({
        batchId: batch.batchId,
        snapshotToken: batch.snapshotToken,
        decisions: [{ itemId: "96000", choice: "hold" }],
      }),
    /送信済み/u,
  );
});

test("期限切れの承認を実行候補から外す", () => {
  const directory = storeDirectory();
  let clock = Date.parse("2026-08-16T12:00:00.000Z");
  const store = createReviewStore({
    directory,
    ttlMs: 60_000,
    now: () => clock,
  });
  const batch = store.create(normalizeReviewInput(review(1)));
  const submitted = store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [approvedRecommendation(store, batch)],
  });
  assert.equal(submitted.submission.executableAuthorizedCount, 1);
  assert.equal(submitted.expiresAt, "2026-08-16T12:01:00.000Z");

  clock += 60_000;
  const expired = store.get(batch.batchId, { scope: "execution" });
  assert.equal(expired.expired, true);
  // 何を承認したかの記録は残し、実行できる集合だけを空にする。
  assert.equal(expired.submission.authorizedPlans.length, 1);
  assert.deepEqual(expired.submission.executableAuthorizedItemIds, []);
});

test("期限切れの一覧への送信を拒否する", () => {
  const directory = storeDirectory();
  let clock = Date.parse("2026-08-16T12:00:00.000Z");
  const store = createReviewStore({
    directory,
    ttlMs: 60_000,
    now: () => clock,
  });
  const batch = store.create(normalizeReviewInput(review(1)));
  const approval = approvedRecommendation(store, batch);
  clock += 60_000;
  assert.throws(
    () =>
      store.submit({
        batchId: batch.batchId,
        snapshotToken: batch.snapshotToken,
        decisions: [approval],
      }),
    /有効期限/u,
  );
});

test("batchIdに使えない値でファイルを探しに行かない", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  assert.throws(() => store.get("../../etc/passwd"), /見つかりません/u);
});

test("期限内の承認は件数上限で消さない", () => {
  const directory = storeDirectory();
  const store = createReviewStore({ directory });
  const approved = store.create(normalizeReviewInput(review(1)));
  store.submit({
    batchId: approved.batchId,
    snapshotToken: approved.snapshotToken,
    decisions: [approvedRecommendation(store, approved)],
  });

  const later = [];
  for (let index = 0; index < 25; index += 1) {
    later.push(store.create(normalizeReviewInput(review(1))));
  }

  const loaded = store.get(approved.batchId, { scope: "execution" });
  assert.equal(loaded.expired, false);
  assert.deepEqual(loaded.submission.executableAuthorizedItemIds, ["96000"]);
  // 未送信の古い一覧は従来どおり件数上限で消える。
  assert.throws(() => store.get(later[0].batchId), /見つかりません/u);
});

test("承認したストアと期限設定が違っても記録した期限に従う", () => {
  const directory = storeDirectory();
  let clock = Date.parse("2026-08-16T12:00:00.000Z");
  const reviewer = createReviewStore({ directory, ttlMs: 60_000, now: () => clock });
  const batch = reviewer.create(normalizeReviewInput(review(1)));
  reviewer.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [approvedRecommendation(reviewer, batch)],
  });

  clock += 60_000;
  const executor = createReviewStore({
    directory,
    ttlMs: 24 * 60 * 60 * 1000,
    now: () => clock,
  });
  const loaded = executor.get(batch.batchId, { scope: "execution" });
  assert.equal(loaded.expiresAt, "2026-08-16T12:01:00.000Z");
  assert.equal(loaded.expired, true);
  assert.deepEqual(loaded.submission.executableAuthorizedItemIds, []);
});

test("expiresAtの欠落または破損はcreatedAtが有効でも期限切れに倒す", () => {
  for (const expiresAt of [undefined, "壊れた期限"]) {
    const directory = storeDirectory();
    const store = createReviewStore({ directory });
    const batch = store.create(normalizeReviewInput(review(1)));
    store.submit({
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      decisions: [approvedRecommendation(store, batch)],
    });

    // 承認済み一覧の期限の正本は承認記録へ焼き込んだ`expiresAt`である。
    const path = join(directory, `${batch.batchId}.submission.json`);
    const broken = JSON.parse(readFileSync(path, "utf8"));
    assert.match(broken.submittedAt, /^\d{4}-/u);
    if (expiresAt === undefined) delete broken.expiresAt;
    else broken.expiresAt = expiresAt;
    writeFileSync(path, JSON.stringify(broken));

    const loaded = store.get(batch.batchId, { scope: "execution" });
    assert.equal(loaded.expired, true);
    assert.equal(loaded.expiresAt, null);
    assert.deepEqual(loaded.submission.executableAuthorizedItemIds, []);
  }
});

test("日時を読み取れない記録は期限切れとして扱う", () => {
  const directory = storeDirectory();
  const store = createReviewStore({ directory });
  const batch = store.create(normalizeReviewInput(review(1)));
  store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [approvedRecommendation(store, batch)],
  });

  const reviewPath = join(directory, `${batch.batchId}.review.json`);
  const brokenReview = JSON.parse(readFileSync(reviewPath, "utf8"));
  brokenReview.createdAt = "壊れた日時";
  delete brokenReview.expiresAt;
  writeFileSync(reviewPath, JSON.stringify(brokenReview));
  const path = join(directory, `${batch.batchId}.submission.json`);
  const broken = JSON.parse(readFileSync(path, "utf8"));
  delete broken.expiresAt;
  writeFileSync(path, JSON.stringify(broken));

  const loaded = store.get(batch.batchId, { scope: "execution" });
  assert.equal(loaded.expired, true);
  assert.equal(loaded.expiresAt, null);
  assert.deepEqual(loaded.submission.executableAuthorizedItemIds, []);
  // 日時を読み取れない記録は掃除の対象にもなるため、取得後は消えていてよい。
  // どちらの経路でも送信は通さない。
  assert.throws(
    () =>
      store.submit({
        batchId: batch.batchId,
        snapshotToken: batch.snapshotToken,
        decisions: [{ itemId: "96000", choice: "approve" }],
      }),
    /有効期限|見つかりません/u,
  );
});

test("壊れた記録があっても新しい一覧を作れる", () => {
  const directory = storeDirectory();
  const store = createReviewStore({ directory });
  const batch = store.create(normalizeReviewInput(review(1)));
  writeFileSync(join(directory, `${batch.batchId}.review.json`), "{壊れた");

  assert.doesNotThrow(() => store.create(normalizeReviewInput(review(1))));
  assert.throws(() => store.get(batch.batchId), /壊れています|見つかりません/u);
});

test("取得のたびに古い記録を掃除する", () => {
  const directory = storeDirectory();
  let clock = Date.parse("2026-08-16T12:00:00.000Z");
  const store = createReviewStore({ directory, ttlMs: 60_000, now: () => clock });
  const stale = store.create(normalizeReviewInput(review(1)));
  const kept = store.create(normalizeReviewInput(review(1)));

  // 新しい一覧を作らなくても、取得だけで期限の倍を過ぎた本文が残らない。
  clock += 200_000;
  assert.equal(store.get(kept.batchId).expired, true);
  assert.throws(() => store.get(stale.batchId), /見つかりません/u);
  assert.deepEqual(
    readdirSync(directory).filter((name) => name.endsWith(".json")),
    [],
  );
});

test("書き込み途中で落ちた一時ファイルだけを片づける", () => {
  const directory = storeDirectory();
  let clock = Date.parse("2026-08-16T12:00:00.000Z");
  const store = createReviewStore({ directory, ttlMs: 60_000, now: () => clock });
  const batch = store.create(normalizeReviewInput(review(1)));

  const abandoned = join(directory, "11111111-1111-4111-8111-111111111111.tmp");
  writeFileSync(abandoned, "{途中まで");
  utimesSync(abandoned, new Date(clock), new Date(clock));
  const inFlight = join(directory, "22222222-2222-4222-8222-222222222222.tmp");

  clock += 60_000;
  writeFileSync(inFlight, "{書き込み中");
  utimesSync(inFlight, new Date(clock), new Date(clock));
  store.get(batch.batchId);

  assert.equal(existsSync(abandoned), false);
  assert.equal(existsSync(inFlight), true);
});

test("保存先を作れない場合はパスを添えて失敗する", () => {
  const directory = storeDirectory();
  const blocker = join(directory, "blocker");
  writeFileSync(blocker, "");
  assert.throws(
    () => createReviewStore({ directory: join(blocker, "reviews") }),
    (error) =>
      /承認の保存先を作成できません/u.test(error.message) &&
      error.message.includes(blocker),
  );
});

test("自律処理の判断は推奨案そのものだけを承認し、出所を記録へ残す", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const batch = store.create(normalizeReviewInput(review(2)));
  const submitted = store.submitAutonomous({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [
      { itemId: "96000", choice: "approve" },
      { itemId: "96001", choice: "hold" },
    ],
    authorizedBy: "autonomous",
  });
  assert.equal(submitted.submission.authorizedBy, "autonomous");
  assert.equal(submitted.submission.executableAuthorizedCount, 1);

  // 承認した完全案は、一覧作成時に確定した推奨案と同じものになる。
  const execution = store.get(batch.batchId, { scope: "execution" });
  const snapshotPlan = store
    .get(batch.batchId, { scope: "report" })
    .units.find((unit) => unit.item.id === "96000").plan;
  assert.deepEqual(
    execution.submission.authorizedPlans[0].resolvedPlan,
    snapshotPlan,
  );
  assert.equal(execution.submission.authorizedBy, "autonomous");
});

test("自律処理の判断は全処理単位を要求し、代替案も自由文も受け取らない", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const batch = store.create(normalizeReviewInput(review(2)));
  const submitAutonomous = (decisions) =>
    store.submitAutonomous({
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      decisions,
      authorizedBy: "autonomous",
    });

  assert.throws(() => submitAutonomous([{ itemId: "96000", choice: "approve" }]), /全処理単位/u);
  assert.throws(
    () =>
      submitAutonomous([
        { itemId: "96000", choice: "alternative" },
        { itemId: "96001", choice: "hold" },
      ]),
    /承認か保留/u,
  );
  assert.throws(
    () =>
      submitAutonomous([
        { itemId: "96000", choice: "approve", supplementalReason: "自由文" },
        { itemId: "96001", choice: "hold" },
      ]),
    /推奨案の承認か保留以外/u,
  );
  // 実行許可を作れる出所は運用モードだけで、呼び出し側が名乗る値では作れない。
  for (const authorizedBy of ["administrator", "auto-review"]) {
    assert.throws(
      () =>
        store.submitAutonomous({
          batchId: batch.batchId,
          snapshotToken: batch.snapshotToken,
          decisions: [
            { itemId: "96000", choice: "approve" },
            { itemId: "96001", choice: "hold" },
          ],
          authorizedBy,
        }),
      /運用モードではありません/u,
    );
  }
});

test("旧auto-reviewの保存済み承認は人間の承認へ読み替えない", () => {
  const directory = storeDirectory();
  const store = createReviewStore({ directory });
  const batch = store.create(normalizeReviewInput(review(1)));
  store.submitAutonomous({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [{ itemId: "96000", choice: "approve" }],
    authorizedBy: "autonomous",
  });
  const submissionPath = join(directory, `${batch.batchId}.submission.json`);
  const submission = JSON.parse(readFileSync(submissionPath, "utf8"));
  writeFileSync(
    submissionPath,
    JSON.stringify({ ...submission, authorizedBy: "auto-review" }),
  );

  const execution = store.get(batch.batchId, { scope: "execution" });
  assert.equal(execution.submission.authorizedBy, "auto-review");
});

test("report範囲は送信済み判断だけを返し、実行許可を作る値を返さない", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const batch = store.create(normalizeReviewInput(review(1)));

  // 未送信の一覧は結果報告へ混ぜず、推奨案のプレビュー経路にしない。
  const before = store.get(batch.batchId, { scope: "report" });
  assert.equal(before.submitted, false);
  assert.equal(before.authorizedBy, null);
  assert.deepEqual(before.units, []);
  assert.doesNotMatch(JSON.stringify(before), /resolvedPlanToken/u);

  store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [approvedRecommendation(store, batch)],
  });
  const after = store.get(batch.batchId, { scope: "report" });
  assert.equal(after.submitted, true);
  assert.equal(after.authorizedBy, "administrator");
  assert.equal(after.units[0].choice, "approve");
  // 期限に依存する実行可否は、後から開く報告では意味が変わるので返さない。
  assert.equal(after.units[0].executable, undefined);
  assert.doesNotMatch(JSON.stringify(after), /resolvedPlanToken/u);
});

test("保存済み一覧は作成時の対象グループを持ち、読めない実行許可の出所を通さない", () => {
  const directory = storeDirectory();
  const store = createReviewStore({ directory });
  const batch = store.create(normalizeReviewInput(review(1)), { groupKey: "genshinwiki" });
  assert.equal(store.groupKeyOf(batch.batchId), "genshinwiki");

  store.submit({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [approvedRecommendation(store, batch)],
  });
  const submissionPath = join(directory, `${batch.batchId}.submission.json`);
  const submission = JSON.parse(readFileSync(submissionPath, "utf8"));
  writeFileSync(
    submissionPath,
    JSON.stringify({ ...submission, authorizedBy: "trusted" }),
  );
  // 読めない出所を人間の承認へ寄せると、自律承認をrestrictedで実行できてしまう。
  assert.throws(
    () => store.get(batch.batchId, { scope: "execution" }),
    ReviewStoreIntegrityError,
  );
});
