import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTION_PRECONDITIONS_SCHEMA,
  ExecutionPreconditionError,
  OPEN_REPORTS_UNREADABLE,
  classifyExecutionPreconditions,
  deriveApprovalExecutionPreconditions,
  deriveLiveExecutionPreconditions,
} from "../server/execution-preconditions.mjs";

const GROUP_KEY = "g";
const TOPIC_NUMBER = "413";

function publicUrl(commentNumber) {
  return `https://z.wikiwiki.jp/${GROUP_KEY}/topic/${TOPIC_NUMBER}/${commentNumber}`;
}

function resolvedPlan(overrides = {}) {
  return {
    itemId: "96517",
    targets: [
      { commentNumber: "96517", currentState: "公開中", url: publicUrl("96517") },
    ],
    reportBindings: [{ reportId: "r-1", targetCommentNumber: "96517" }],
    ...overrides,
  };
}

function executionStep(overrides = {}) {
  return {
    operationIndex: 0,
    operationType: "comment_delete",
    targetCommentNumber: "96517",
    reportIds: ["r-1"],
    messages: [],
    ...overrides,
  };
}

function liveFacts(overrides = {}) {
  return {
    currentState: "公開中",
    openReportIds: ["r-1"],
    closedReportIds: [],
    reportsUnavailable: false,
    ...overrides,
  };
}

function derivePair({ plan = resolvedPlan(), step = executionStep(), facts = liveFacts() } = {}) {
  const approval = deriveApprovalExecutionPreconditions({
    resolvedPlan: plan,
    executionStep: step,
  });
  const live = deriveLiveExecutionPreconditions({
    targetReference: approval.target,
    liveFacts: facts,
    executionStep: step,
  });
  return { approval, live };
}

function classify(args) {
  const { approval, live } = derivePair(args);
  return classifyExecutionPreconditions(approval, live);
}

test("承認済み事実とライブ事実が一致すれば、止めも飛ばしもしない", () => {
  const { approval, live } = derivePair();
  assert.equal(approval.schema, EXECUTION_PRECONDITIONS_SCHEMA);
  assert.equal(live.schema, EXECUTION_PRECONDITIONS_SCHEMA);
  const outcome = classifyExecutionPreconditions(approval, live);
  assert.deepEqual(outcome.blocking, []);
  assert.equal(outcome.alreadySatisfied, false);
  assert.equal(outcome.targetDeletedBeforeExecution, false);
});

test("承認済み前提は対象と、その操作が必要とする条件だけを持つ", () => {
  const approval = deriveApprovalExecutionPreconditions({
    resolvedPlan: resolvedPlan(),
    executionStep: executionStep(),
  });
  assert.deepEqual(approval.target, {
    groupKey: GROUP_KEY,
    topicNumber: TOPIC_NUMBER,
    commentNumber: "96517",
  });
  // コメント削除は管理状態を前提にする。通報の未処理は前提にしない。
  assert.equal(approval.expectedState, "公開中");
  assert.equal(approval.requiredOpenReportIds, undefined);
});

test("expectedStateは承認時に観測した状態で、実装側の既定値を補わない", () => {
  const approval = deriveApprovalExecutionPreconditions({
    resolvedPlan: resolvedPlan({
      targets: [
        { commentNumber: "96517", currentState: "削除済み", url: publicUrl("96517") },
      ],
    }),
    executionStep: executionStep({ operationType: "comment_restore" }),
  });
  assert.equal(approval.expectedState, "削除済み");
});

test("通報操作はその原子操作が対象とする通報だけを要求する", () => {
  const approval = deriveApprovalExecutionPreconditions({
    resolvedPlan: resolvedPlan({
      reportBindings: [
        { reportId: "r-1", targetCommentNumber: "96517" },
        { reportId: "r-2", targetCommentNumber: "96517" },
      ],
    }),
    executionStep: executionStep({
      operationType: "report_complete",
      reportIds: ["r-2"],
    }),
  });
  // reportBindingsの全集合ではなく、承認済み原子操作のreportIdsだけを前提にする。
  assert.deepEqual(approval.requiredOpenReportIds, ["r-2"]);
  assert.equal(approval.expectedState, undefined);
});

test("承認後に別の新規通報が増えただけでは停止しない", () => {
  const outcome = classify({
    step: executionStep({ operationType: "report_complete", reportIds: ["r-1"] }),
    facts: liveFacts({ openReportIds: ["r-1", "r-9"] }),
  });
  assert.deepEqual(outcome.blocking, []);
  assert.equal(outcome.alreadySatisfied, false);
  assert.deepEqual(outcome.pendingReportIds, ["r-1"]);
  assert.deepEqual(outcome.addedOpenReportIds, ["r-9"]);
});

test("承認済み通報がすでに閉じられていれば、送らずに済んだ操作にする", () => {
  const outcome = classify({
    step: executionStep({ operationType: "report_ignore", reportIds: ["r-1"] }),
    facts: liveFacts({ openReportIds: [], closedReportIds: ["r-1"] }),
  });
  assert.deepEqual(outcome.blocking, []);
  assert.equal(outcome.alreadySatisfied, true);
  assert.deepEqual(outcome.settledReportIds, ["r-1"]);
});

test("承認済み通報の一部だけが閉じられていれば、残りを対象に送信する", () => {
  const outcome = classify({
    step: executionStep({ operationType: "report_complete", reportIds: ["r-1", "r-2"] }),
    plan: resolvedPlan({
      reportBindings: [
        { reportId: "r-1", targetCommentNumber: "96517" },
        { reportId: "r-2", targetCommentNumber: "96517" },
      ],
    }),
    facts: liveFacts({ openReportIds: ["r-2"], closedReportIds: ["r-1"] }),
  });
  assert.deepEqual(outcome.blocking, []);
  assert.equal(outcome.alreadySatisfied, false);
  assert.deepEqual(outcome.pendingReportIds, ["r-2"]);
  assert.deepEqual(outcome.settledReportIds, ["r-1"]);
});

test("読み切れていない通報表では、行を追えない承認済み通報でも完了を止めない", () => {
  const outcome = classify({
    step: executionStep({ operationType: "report_complete", reportIds: ["r-1"] }),
    facts: liveFacts({ openReportIds: ["r-9"], openReportsTruncated: true }),
  });
  assert.deepEqual(outcome.blocking, []);
  assert.equal(outcome.alreadySatisfied, false);
  assert.equal(outcome.openReportsTruncated, true);
  assert.deepEqual(outcome.unlistedReportIds, ["r-1"]);
  assert.deepEqual(outcome.addedOpenReportIds, ["r-9"]);
});

test("読み切れていない通報表でも、通報ごとに閉じる無視は止める", () => {
  const outcome = classify({
    step: executionStep({ operationType: "report_ignore", reportIds: ["r-1"] }),
    facts: liveFacts({ openReportIds: ["r-9"], openReportsTruncated: true }),
  });
  assert.deepEqual(outcome.blocking, ["report_missing:r-1"]);
});

test("承認済み通報が未処理にも処理済みにも無ければ止める", () => {
  const outcome = classify({
    step: executionStep({ operationType: "report_ignore", reportIds: ["r-1"] }),
    facts: liveFacts({ openReportIds: ["r-9"] }),
  });
  assert.deepEqual(outcome.blocking, ["report_missing:r-1"]);
  assert.equal(outcome.alreadySatisfied, false);
});

test("対象がすでに削除済みなら、削除は送らずに済んだ操作にする", () => {
  const outcome = classify({ facts: liveFacts({ currentState: "削除済み" }) });
  assert.deepEqual(outcome.blocking, []);
  assert.equal(outcome.alreadySatisfied, true);
  assert.equal(outcome.targetDeletedBeforeExecution, true);
});

test("対象がすでに削除済みでなければ、復元は送らずに済んだ操作にする", () => {
  const outcome = classify({
    plan: resolvedPlan({
      targets: [
        { commentNumber: "96517", currentState: "削除済み", url: publicUrl("96517") },
      ],
    }),
    step: executionStep({ operationType: "comment_restore" }),
    facts: liveFacts({ currentState: "公開中" }),
  });
  assert.deepEqual(outcome.blocking, []);
  assert.equal(outcome.alreadySatisfied, true);
  // 承認時から削除済みだった対象は、いま削除済みでも「先に削除された」に当たらない。
  assert.equal(outcome.targetDeletedBeforeExecution, false);
});

test("到達点でもない状態の変化は差分として止める", () => {
  const outcome = classify({ facts: liveFacts({ currentState: "投稿時に自動無視" }) });
  assert.deepEqual(outcome.blocking, ["current_state"]);
  assert.equal(outcome.alreadySatisfied, false);
});

test("コメント状態を読めないライブ事実は、状態を前提にする操作の差分になる", () => {
  const outcome = classify({ facts: liveFacts({ currentState: undefined }) });
  assert.deepEqual(outcome.blocking, ["current_state"]);
  assert.equal(outcome.alreadySatisfied, false);
});

test("通報を必要としない操作では通報表を読めないこと自体を停止理由にしない", () => {
  const outcome = classify({ facts: { currentState: "公開中", reportsUnavailable: true } });
  assert.deepEqual(outcome.blocking, []);
});

test("通報を必要とする操作では通報表を読めないことを0件へ変換しない", () => {
  const outcome = classify({
    step: executionStep({ operationType: "report_complete", reportIds: ["r-1"] }),
    facts: { currentState: "公開中", reportsUnavailable: true },
  });
  assert.deepEqual(outcome.blocking, [OPEN_REPORTS_UNREADABLE]);
  assert.equal(outcome.alreadySatisfied, false);
});

test("コメント状態を前提にしない操作では状態を読めなくても止めない", () => {
  const step = executionStep({ operationType: "author_auto_ignore" });
  const { approval, live } = derivePair({
    step,
    facts: { reportsUnavailable: true },
  });
  assert.equal(approval.expectedState, undefined);
  assert.deepEqual(classifyExecutionPreconditions(approval, live).blocking, []);
});

test("到達点に達していても、確かめられない条件が残れば止める", () => {
  const step = executionStep();
  const expected = {
    schema: EXECUTION_PRECONDITIONS_SCHEMA,
    target: { groupKey: GROUP_KEY, topicNumber: TOPIC_NUMBER, commentNumber: "96517" },
    operationType: "comment_delete",
    approvedState: "公開中",
    expectedState: "公開中",
    requiredOpenReportIds: ["r-1", "r-2"],
  };
  const live = deriveLiveExecutionPreconditions({
    targetReference: expected.target,
    liveFacts: liveFacts({ currentState: "削除済み", openReportIds: ["r-2"] }),
    executionStep: step,
  });
  const outcome = classifyExecutionPreconditions(expected, live);
  assert.deepEqual(outcome.blocking, ["report_missing:r-1"]);
  // 削除の到達点には達しているが、停止理由がある単位を送らずに確定させない。
  assert.equal(outcome.alreadySatisfied, true);
});

test("呼び出し側が渡した現在状態と通報IDは承認済み前提を差し替えない", () => {
  const approval = deriveApprovalExecutionPreconditions({
    resolvedPlan: resolvedPlan(),
    executionStep: executionStep({ currentState: "削除済み", openReportIds: ["r-9"] }),
  });
  assert.equal(approval.expectedState, "公開中");
});

test("承認済み保存データの不正は差分ではなく完全案の不正にする", () => {
  assert.throws(
    () =>
      deriveApprovalExecutionPreconditions({
        resolvedPlan: resolvedPlan({ targets: [{ commentNumber: "96517", url: "" }] }),
        executionStep: executionStep(),
      }),
    (error) =>
      error instanceof ExecutionPreconditionError && error.kind === "approved_plan_invalid",
  );
  assert.throws(
    () =>
      deriveApprovalExecutionPreconditions({
        resolvedPlan: resolvedPlan(),
        executionStep: executionStep({
          operationType: "report_complete",
          reportIds: ["r-1", "r-1"],
        }),
      }),
    (error) =>
      error instanceof ExecutionPreconditionError && error.kind === "approved_plan_invalid",
  );
});

test("別targetの比較は差分ではなく整合性の失敗として止まる", () => {
  const { approval } = derivePair();
  const other = deriveApprovalExecutionPreconditions({
    resolvedPlan: resolvedPlan({
      targets: [
        { commentNumber: "96518", currentState: "公開中", url: publicUrl("96518") },
      ],
    }),
    executionStep: executionStep({ targetCommentNumber: "96518" }),
  });
  assert.throws(
    () => classifyExecutionPreconditions(approval, other),
    (error) =>
      error instanceof ExecutionPreconditionError && error.kind === "approval_integrity",
  );
});

test("ライブ事実の生成失敗は、対象の食い違いと承認側の不正を分ける", () => {
  assert.throws(
    () =>
      deriveLiveExecutionPreconditions({
        targetReference: {
          groupKey: GROUP_KEY,
          topicNumber: TOPIC_NUMBER,
          commentNumber: "96518",
        },
        liveFacts: liveFacts(),
        executionStep: executionStep(),
      }),
    (error) =>
      error instanceof ExecutionPreconditionError && error.kind === "approval_integrity",
  );
  // 承認側を読み取れないことは、照合相手との食い違いではない。区分を取り違えると、
  // 実行経路がこの停止を対象の食い違いとして報告してしまう。
  assert.throws(
    () =>
      deriveLiveExecutionPreconditions({
        targetReference: {
          groupKey: GROUP_KEY,
          topicNumber: TOPIC_NUMBER,
          commentNumber: "96517",
        },
        liveFacts: liveFacts(),
        executionStep: executionStep({ targetCommentNumber: "" }),
      }),
    (error) =>
      error instanceof ExecutionPreconditionError && error.kind === "approved_plan_invalid",
  );
});
