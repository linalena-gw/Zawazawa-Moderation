import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReviewInput } from "../server/review-input.mjs";
import { createReviewStore } from "../server/review-store.mjs";
import {
  alternativeChanges,
  review,
  storeDirectory,
} from "../test-support/review-fixtures.mjs";

test("20件を一つのスナップショットに正規化する", () => {
  const normalized = normalizeReviewInput(review());
  assert.equal(normalized.items.length, 20);
  assert.equal(normalized.items[0].id, "96000");
  assert.equal(normalized.items[0].comments[0].body, "対象コメント本文");
  assert.equal(normalized.items[0].reports[1].reason, "不適切な表現");
  assert.equal(normalized.items[0].history[0].body, "確認した過去投稿本文");
});

test("行の出所として、コメントと投稿履歴のトピック番号と名前を残す", () => {
  // 一覧は同一ツリー・別ツリー・別トピックをこの二つから区分けする。落とすと、
  // 別の掲示板から拾った文脈が番号だけの行になって見分けられない。
  const input = review(1);
  Object.assign(input.items[0].comments[0], {
    topicNumber: "423",
    topicName: "雑談/掲示板6",
  });
  Object.assign(input.items[0].history[0], {
    topicNumber: "2",
    topicName: "管理連絡掲示板",
  });

  const normalized = normalizeReviewInput(input);

  assert.equal(normalized.items[0].comments[0].topicNumber, "423");
  assert.equal(normalized.items[0].comments[0].topicName, "雑談/掲示板6");
  assert.equal(normalized.items[0].history[0].topicNumber, "2");
  assert.equal(normalized.items[0].history[0].topicName, "管理連絡掲示板");
});

test("投稿IDの重複を拒否する", () => {
  const input = review(2);
  input.items[1].id = input.items[0].id;
  assert.throws(() => normalizeReviewInput(input), /重複/u);
});

test("処理単位IDを実行ジャーナルと共通の安全な形式に制限する", () => {
  for (const id of ["日本語ID", "unit id", "a".repeat(257)]) {
    const input = review(1);
    input.items[0].id = id;
    assert.throws(() => normalizeReviewInput(input), /処理単位IDは英数字/u);
  }
  const input = review(1);
  input.items[0].id = "review-unit_1";
  assert.equal(normalizeReviewInput(input).items[0].id, "review-unit_1");
});

test("処置対象番号を実行ジャーナルと共通の1〜20桁正整数に制限する", () => {
  for (const commentNumber of ["0", "01", "1".repeat(21), "12a"] ) {
    const input = review(1);
    input.items[0].recommendation.targets[0].commentNumber = commentNumber;
    assert.throws(() => normalizeReviewInput(input), /1〜20桁の数字/u);
  }
  const input = review(1);
  input.items[0].recommendation.targets[0].commentNumber = "9".repeat(20);
  assert.equal(
    normalizeReviewInput(input).items[0].recommendation.targets[0].commentNumber,
    "9".repeat(20),
  );
});

test("通報件数を通報理由の件数から算出する", () => {
  const input = review(1);
  input.items[0].reports.pop();
  const normalized = normalizeReviewInput(input);
  assert.equal(normalized.items[0].reportCount, 1);
  assert.equal(normalized.items[0].reports.length, 1);
});

test("明示された通報件数と保存する通報行の不一致を拒否する", () => {
  const input = review(1);
  input.items[0].reportCount = 99;
  assert.throws(() => normalizeReviewInput(input), /通報件数と通報行/u);
});

test("読み切れていない通報表の打ち切りと総件数を一覧へ残す", () => {
  const input = review(1);
  input.items[0].reportsTruncated = true;
  input.items[0].reportTotalCount = 25;

  const normalized = normalizeReviewInput(input);

  assert.equal(normalized.items[0].reportCount, 2);
  assert.equal(normalized.items[0].reportsTruncated, true);
  assert.equal(normalized.items[0].reportTotalCount, 25);
});

test("読み切れた一覧は打ち切りを立てず、総件数を別に持たない", () => {
  const normalized = normalizeReviewInput(review(1));
  assert.equal(normalized.items[0].reportsTruncated, false);
  assert.equal(normalized.items[0].reportTotalCount, undefined);
});

test("通報行と噛み合わない総件数を拒否する", () => {
  // 読み切れた単位の総件数、読めた行数以下の総件数、整数でない総件数は、
  // どれも管理画面の件数表示から導けない。
  for (const [reportsTruncated, reportTotalCount] of [
    [false, 25],
    [true, 2],
    [true, 1.5],
  ]) {
    const input = review(1);
    input.items[0].reportsTruncated = reportsTruncated;
    input.items[0].reportTotalCount = reportTotalCount;
    assert.throws(() => normalizeReviewInput(input), /通報の総件数が通報行と一致しません/u);
  }
});

test("通報行の識別子と対象を一覧へ残す", () => {
  const input = review(1);
  input.items[0].reports[0].reportId = "10001";
  input.items[0].reports[0].targetCommentNumber = "96441";

  const normalized = normalizeReviewInput(input);

  assert.equal(normalized.items[0].reports[0].reportId, "10001");
  assert.equal(normalized.items[0].reports[0].targetCommentNumber, "96441");
});

test("投稿本文や管理者の文にIPらしい文字列があっても一覧は落とさず書き換えない", () => {
  // 機密情報対策はreaderの出力境界の項目許可リストで行う。値ベースの再帰検査で
  // 判断材料の本文を書き換えたり、承認を拒否したりしない。
  const input = review(2);
  const body = `対処済みの案内 ${[192, 0, 2, 10].join(".")} について`;
  input.items[0].comments[0].body = body;
  input.items[1].basis = ["support: 通常の案内", "ghost: 通常の表現"];

  const normalized = normalizeReviewInput(input);

  assert.equal(normalized.items.length, 2);
  assert.equal(normalized.items[0].comments[0].body, body);
  assert.deepEqual(normalized.items[1].basis, input.items[1].basis);
  assert.equal(normalized.maskedPaths, undefined);
});

test("モデルと管理者が書いた自由文の表示禁止情報は保存前に拒否する", () => {
  const store = createReviewStore({ directory: storeDirectory() });
  const withBasis = review(1);
  withBasis.items[0].basis = [`接続元 ${[192, 0, 2, 10].join(".")} からの連投`];
  assert.throws(() => normalizeReviewInput(withBasis), /表示禁止情報/u);

  const batch = store.create(normalizeReviewInput(review(1)));
  assert.throws(
    () =>
      store.preview({
        batchId: batch.batchId,
        snapshotToken: batch.snapshotToken,
        itemId: "96000",
        changes: alternativeChanges(),
        supplementalReason: `案内文に ${[192, 0, 2, 10].join(".")} と書かれている点は保留`,
      }),
    /表示禁止情報/u,
  );
});

test("メッセージは選択した一つの送信操作へだけ束縛する", () => {
  const base = () => {
    const input = review(1);
    input.items[0].reports = [
      { reportId: "report-a", targetCommentNumber: "96000", reason: "理由" },
    ];
    input.items[0].recommendation.messages = [
      { messageId: "message-a", label: "案内", text: "対応しました。" },
    ];
    return input;
  };

  const missingDeclaration = base();
  missingDeclaration.items[0].recommendation.operations = [
    {
      operationId: "complete",
      operationType: "report_complete",
      targetCommentNumbers: ["96000"],
    },
  ];
  assert.throws(() => normalizeReviewInput(missingDeclaration), /メッセージIDは0件または1件/u);

  const unbound = base();
  unbound.items[0].recommendation.operations = [
    {
      operationId: "complete",
      operationType: "report_complete",
      targetCommentNumbers: ["96000"],
      messageIds: [],
    },
  ];
  assert.throws(
    () => normalizeReviewInput(unbound),
    /どの操作候補からも参照されていません/u,
  );

  const duplicateBinding = base();
  duplicateBinding.items[0].recommendation.operations = [
    {
      operationId: "complete-1",
      operationType: "report_complete",
      targetCommentNumbers: ["96000"],
      messageIds: ["message-a"],
    },
    {
      operationId: "complete-2",
      operationType: "report_complete",
      targetCommentNumbers: ["96000"],
      messageIds: ["message-a"],
    },
  ];
  assert.throws(() => normalizeReviewInput(duplicateBinding), /複数の操作候補が束縛/u);

  const forbiddenType = base();
  forbiddenType.items[0].recommendation.operations = [
    {
      operationId: "delete",
      operationType: "comment_delete",
      targetCommentNumbers: ["96000"],
      messageIds: ["message-a"],
    },
  ];
  assert.throws(() => normalizeReviewInput(forbiddenType), /種別ではメッセージを送信できません/u);
});

test("処理単位全体の操作は複数anchor対象を拒否する", () => {
  for (const operationType of [
    "author_auto_ignore",
    "author_auto_ignore_remove",
    "source_block",
    "source_unblock",
    "public_notice",
  ]) {
    const input = review(1);
    input.items[0].recommendation.targets.push({
      commentNumber: "96010",
      currentState: "公開中",
    });
    input.items[0].recommendation.operations = [
      {
        operationId: `unit-wide-${operationType}`,
        operationType,
        targetCommentNumbers: ["96000", "96010"],
        messageIds: operationType === "public_notice" ? ["notice"] : [],
      },
    ];
    input.items[0].recommendation.messages = operationType === "public_notice"
      ? [{ messageId: "notice", label: "公開案内", text: "対応しました。" }]
      : [];
    assert.throws(
      () => normalizeReviewInput(input),
      /明示anchor対象を1件だけ/u,
      operationType,
    );
  }
});

test("同じ本文を複数の操作候補が束縛する一覧は作らない", () => {
  const input = review(1);
  input.items[0].reports = [
    { reportId: "report-1", targetCommentNumber: "96000", reason: "荒らし投稿" },
  ];
  input.items[0].recommendation.messages = [
    { messageId: "report-message", label: "通報者への案内", text: "削除しました。" },
  ];
  input.items[0].recommendation.operations = [
    {
      operationId: "operation-1",
      operationType: "report_complete",
      targetCommentNumbers: ["96000"],
      messageIds: ["report-message"],
    },
  ];
  // 選択されない追加候補が同じ本文を横取りすると、代替案から本文が黙って落ちる。
  input.items[0].recommendation.operationCandidates = [
    {
      operationId: "operation-alt",
      operationType: "report_complete",
      targetCommentNumbers: ["96000"],
      messageIds: ["report-message"],
      highImpact: false,
    },
  ];

  assert.throws(() => normalizeReviewInput(input), /複数の操作候補が束縛/u);
});

test("表示しない入力はスナップショットへ取り込まない", () => {
  const normalized = normalizeReviewInput(review(1));
  const item = normalized.items[0];
  assert.equal(item.facts, undefined);
  assert.equal(item.recommendation.expectedEffect, undefined);
  assert.equal(item.recommendation.overreachRisk, undefined);
  assert.equal(item.recommendation.omittedHighImpactActions, undefined);
  // 人間向けの操作説明文は入力にも保存済みスナップショットにも残さない。
  assert.equal(item.recommendation.operations, undefined);
  assert.ok(item.recommendation.operationCandidates.every((candidate) => candidate.text === undefined));
  assert.ok(
    normalized.items[0].recommendation.operationCandidates.length > 0,
    "操作候補は残る",
  );
});

test("説明文だけの文字列操作は構造化データとして拒否する", () => {
  const input = review(1);
  input.items[0].recommendation.operations = ["コメントを削除"];
  assert.throws(() => normalizeReviewInput(input), /構造化データ/u);
});
