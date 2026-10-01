import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExecutionJournalConflictError,
  ExecutionJournalInputError,
  ExecutionJournalIntegrityError,
  createExecutionJournal,
  createOperationId,
  defaultExecutionJournalDirectory,
} from "../server/execution-journal.mjs";
import {
  EXECUTION_OPERATION_TYPES,
  hasEnteredDispatch,
  permitsFollowingOperation,
} from "../server/execution-lifecycle.mjs";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const SUBMISSION_ID = "22222222-2222-4222-8222-222222222222";
const PLAN_TOKEN = "a".repeat(64);

function journalDirectory() {
  return mkdtempSync(join(tmpdir(), "zawazawa-execution-journal-"));
}

function operation(overrides = {}) {
  return {
    batchId: BATCH_ID,
    submissionId: SUBMISSION_ID,
    itemId: "review-unit-1",
    resolvedPlanToken: PLAN_TOKEN,
    operationIndex: 0,
    operationType: "comment_delete",
    targetCommentNumber: "96000",
    status: "ready",
    ...overrides,
  };
}

function recordPath(directory, input = operation()) {
  return join(directory, input.batchId, `${createOperationId(input)}.json`);
}

test("同じ承認の同じ原子操作は常に同じoperationIdへ落ちる", () => {
  const key = {
    batchId: BATCH_ID,
    submissionId: SUBMISSION_ID,
    itemId: "review-unit-1",
    resolvedPlanToken: PLAN_TOKEN,
    operationIndex: 0,
  };
  const operationId = createOperationId(key);
  assert.match(operationId, /^op_[0-9a-f]{64}$/u);
  assert.equal(createOperationId({ ...key }), operationId);
  // 入力のどれが変わっても別の実行になる。
  for (const changed of [
    { operationIndex: 1 },
    { itemId: "review-unit-2" },
    { resolvedPlanToken: "b".repeat(64) },
    { submissionId: "33333333-3333-4333-8333-333333333333" },
    { batchId: "44444444-4444-4444-8444-444444444444" },
  ]) {
    assert.notEqual(createOperationId({ ...key, ...changed }), operationId);
  }
});

test("承認を取り直せば同じ完全案でも別の実行になる", () => {
  const key = {
    batchId: BATCH_ID,
    submissionId: SUBMISSION_ID,
    itemId: "review-unit-1",
    resolvedPlanToken: PLAN_TOKEN,
    operationIndex: 0,
  };
  assert.notEqual(
    createOperationId({ ...key, submissionId: "33333333-3333-4333-8333-333333333333" }),
    createOperationId(key),
  );
});

test("識別子の形式が不正な操作IDは作らない", () => {
  const key = {
    batchId: BATCH_ID,
    submissionId: SUBMISSION_ID,
    itemId: "review-unit-1",
    resolvedPlanToken: PLAN_TOKEN,
    operationIndex: 0,
  };
  assert.throws(() => createOperationId({ ...key, batchId: "not-a-uuid" }), /レビュー一覧/u);
  assert.throws(() => createOperationId({ ...key, submissionId: "x" }), /承認送信ID/u);
  assert.throws(() => createOperationId({ ...key, itemId: "記録できない ID" }), /処理単位ID/u);
  assert.throws(() => createOperationId({ ...key, operationIndex: -1 }), /操作番号/u);
  assert.throws(() => createOperationId({ ...key, resolvedPlanToken: "short" }), /完全案トークン/u);
});

test("承認ストア配下の独立したexecution-journalへ1操作1ファイルで保存する", () => {
  const reviewStoreDirectory = journalDirectory();
  const previous = process.env.ZAWAZAWA_REVIEW_STORE_DIR;
  process.env.ZAWAZAWA_REVIEW_STORE_DIR = reviewStoreDirectory;
  try {
    const expected = join(reviewStoreDirectory, "execution-journal");
    assert.equal(defaultExecutionJournalDirectory(), expected);
    const journal = createExecutionJournal();
    assert.equal(journal.directory, expected);
    journal.save(operation());
    journal.save(operation({ status: "dispatching" }));
    assert.deepEqual(readdirSync(join(expected, BATCH_ID)), [
      `${createOperationId(operation())}.json`,
    ]);
  } finally {
    if (previous === undefined) delete process.env.ZAWAZAWA_REVIEW_STORE_DIR;
    else process.env.ZAWAZAWA_REVIEW_STORE_DIR = previous;
  }
});

test("ready・dispatching・確定結果の順で1レコードを置き換える", () => {
  const directory = journalDirectory();
  const journal = createExecutionJournal({ directory });
  assert.equal(journal.getOperation(operation()), null);

  assert.equal(journal.save(operation()).status, "ready");
  assert.equal(journal.save(operation({ status: "dispatching" })).status, "dispatching");
  const confirmed = journal.save(operation({ status: "confirmed" }));
  assert.equal(confirmed.status, "confirmed");
  assert.equal(journal.getOperation(operation()).status, "confirmed");

  const stored = JSON.parse(readFileSync(recordPath(directory), "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), [
    "batchId",
    "history",
    "itemId",
    "operationId",
    "operationIndex",
    "operationType",
    "status",
    "submissionId",
    "targetCommentNumber",
    "updatedAt",
    "version",
  ]);
});

test("外部送信を開始する前に結果は記録できない", () => {
  const journal = createExecutionJournal({ directory: journalDirectory() });
  assert.throws(
    () => journal.save(operation({ status: "confirmed" })),
    ExecutionJournalInputError,
  );
  journal.save(operation());
  assert.throws(
    () => journal.save(operation({ status: "unknown" })),
    ExecutionJournalInputError,
  );
});

test("dispatching以降は同じ承認で開き直せない", () => {
  const journal = createExecutionJournal({ directory: journalDirectory() });
  journal.save(operation());
  journal.save(operation({ status: "dispatching" }));
  for (const status of ["ready", "dispatching"]) {
    assert.throws(
      () => journal.save(operation({ status })),
      ExecutionJournalConflictError,
    );
  }
});

test("確定した結果は上書きできない", () => {
  const journal = createExecutionJournal({ directory: journalDirectory() });
  journal.save(operation());
  journal.save(operation({ status: "dispatching" }));
  journal.save(operation({ status: "unknown" }));
  assert.throws(
    () => journal.save(operation({ status: "confirmed" })),
    ExecutionJournalConflictError,
  );
  assert.equal(hasEnteredDispatch(journal.getOperation(operation()).status), true);
});

test("同じ操作IDへ別の対象や操作は記録できない", () => {
  const journal = createExecutionJournal({ directory: journalDirectory() });
  journal.save(operation());
  assert.throws(
    () => journal.save(operation({ targetCommentNumber: "96001" })),
    ExecutionJournalConflictError,
  );
});

test("許可された操作種別と状態だけを受け取る", () => {
  const journal = createExecutionJournal({ directory: journalDirectory() });
  for (const operationType of EXECUTION_OPERATION_TYPES) {
    journal.save(operation({ operationType, operationIndex: 0, itemId: operationType }));
  }
  assert.throws(
    () => journal.save(operation({ operationType: "unlisted" })),
    ExecutionJournalInputError,
  );
  assert.throws(
    () => journal.save(operation({ status: "attempt_started" })),
    ExecutionJournalInputError,
  );
});

test("永続記録は本文・理由・人物・接続元を受け取らない", () => {
  const directory = journalDirectory();
  const journal = createExecutionJournal({ directory });
  journal.save({ ...operation(), body: "本文", reportIds: ["r1"] });
  const stored = JSON.parse(readFileSync(recordPath(directory), "utf8"));
  assert.equal(stored.body, undefined);
  assert.equal(stored.reportIds, undefined);
});

test("同一プロセス内では同じ操作を並行実行させない", async () => {
  const journal = createExecutionJournal({ directory: journalDirectory() });
  const operationId = createOperationId(operation());
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const first = journal.runExclusive(operationId, () => held);
  await assert.rejects(
    journal.runExclusive(operationId, async () => "second"),
    ExecutionJournalConflictError,
  );
  release("first");
  assert.equal(await first, "first");
  // 解放後は同じ操作IDでも実行できる。
  assert.equal(await journal.runExclusive(operationId, async () => "again"), "again");
});

test("別の操作IDは並行に実行できる", async () => {
  const journal = createExecutionJournal({ directory: journalDirectory() });
  const other = createOperationId(operation({ operationIndex: 1 }));
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const first = journal.runExclusive(createOperationId(operation()), () => held);
  const second = await journal.runExclusive(other, async () => "second");
  assert.equal(second, "second");
  release("first");
  await first;
});

test("後続操作は先行操作の成功確定後だけ許可する", () => {
  const directory = journalDirectory();
  const journal = createExecutionJournal({ directory });
  const second = operation({ operationIndex: 1, operationType: "report_complete" });

  assert.deepEqual(journal.operationOrder(second, [0, 1]), {
    allowed: false,
    operationIndex: 0,
    status: null,
  });
  for (const status of ["ready", "dispatching", "unknown"]) {
    const isolated = createExecutionJournal({ directory: journalDirectory() });
    if (status === "unknown") isolated.save(operation({ status: "dispatching" }));
    isolated.save(operation({ status }));
    assert.equal(isolated.operationOrder(second, [0, 1]).allowed, false, status);
  }

  journal.save(operation({ status: "dispatching" }));
  journal.save(operation({ status: "confirmed" }));
  assert.deepEqual(journal.operationOrder(second, [0, 1]), { allowed: true });

  const settledDirectory = journalDirectory();
  createExecutionJournal({ directory: settledDirectory }).save(
    operation({ status: "no_action_needed" }),
  );
  // 新しいインスタンスでも、保存済みジャーナルから同じ順序判定になる。
  assert.deepEqual(
    createExecutionJournal({ directory: settledDirectory }).operationOrder(second, [0, 1]),
    { allowed: true },
  );
});

test("成功確定状態だけが後続操作を許可する", () => {
  for (const status of ["ready", "dispatching", "unknown", undefined]) {
    assert.equal(permitsFollowingOperation(status), false, status);
  }
  for (const status of ["confirmed", "no_action_needed"]) {
    assert.equal(permitsFollowingOperation(status), true, status);
  }
});

test("同じ処理単位の操作列は直列化し、別の処理単位は止めない", async () => {
  const journal = createExecutionJournal({ directory: journalDirectory() });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const first = journal.runExclusiveSequence(operation(), () => held);
  await assert.rejects(
    journal.runExclusiveSequence(operation({ operationIndex: 1 }), async () => "second"),
    ExecutionJournalConflictError,
  );
  assert.equal(
    await journal.runExclusiveSequence(operation({ itemId: "review-unit-2" }), async () => "other"),
    "other",
  );
  release("first");
  assert.equal(await first, "first");
});

test("バッチ取得は処理単位と操作番号の順で全操作を返す", () => {
  const journal = createExecutionJournal({ directory: journalDirectory() });
  journal.save(operation({ itemId: "unit-b", operationIndex: 0 }));
  journal.save(operation({ itemId: "unit-a", operationIndex: 1 }));
  journal.save(operation({ itemId: "unit-a", operationIndex: 0 }));
  const batch = journal.getBatch(BATCH_ID);
  assert.deepEqual(
    batch.operations.map((entry) => [entry.itemId, entry.operationIndex]),
    [
      ["unit-a", 0],
      ["unit-a", 1],
      ["unit-b", 0],
    ],
  );
});

test("記録の無いバッチは空として返し、未試行を実行許可にしない", () => {
  const journal = createExecutionJournal({ directory: journalDirectory() });
  const batch = journal.getBatch("55555555-5555-4555-8555-555555555555");
  assert.deepEqual(batch.operations, []);
});

test("確定名の部分JSONや壊れた記録は未試行扱いにせず停止する", () => {
  const directory = journalDirectory();
  const journal = createExecutionJournal({ directory });
  journal.save(operation());
  writeFileSync(recordPath(directory), '{"version":2,"batchId"');
  assert.throws(() => journal.getOperation(operation()), ExecutionJournalIntegrityError);
});

test("記録値の改ざんは破損として停止する", () => {
  const directory = journalDirectory();
  const journal = createExecutionJournal({ directory });
  journal.save(operation());
  const stored = JSON.parse(readFileSync(recordPath(directory), "utf8"));
  writeFileSync(recordPath(directory), JSON.stringify({ ...stored, status: "終わった" }));
  assert.throws(() => journal.getOperation(operation()), ExecutionJournalIntegrityError);
});

test("未知の記録があるバッチは破損として停止する", () => {
  const directory = journalDirectory();
  const journal = createExecutionJournal({ directory });
  journal.save(operation());
  writeFileSync(join(directory, BATCH_ID, "unknown.json"), "{}");
  assert.throws(() => journal.getBatch(BATCH_ID), ExecutionJournalIntegrityError);
});

test("OSが作る付随ファイルではジャーナル全体を破損扱いにしない", () => {
  const directory = journalDirectory();
  const journal = createExecutionJournal({ directory });
  journal.save(operation());
  writeFileSync(join(directory, BATCH_ID, ".DS_Store"), "");
  assert.equal(journal.getBatch(BATCH_ID).operations.length, 1);
});

test("置換途中の一時ファイルは記録として読まない", () => {
  const directory = journalDirectory();
  const journal = createExecutionJournal({ directory });
  journal.save(operation());
  writeFileSync(join(directory, BATCH_ID, "partial.json.9999.tmp"), "{途中");
  assert.equal(journal.getBatch(BATCH_ID).operations.length, 1);
});

test("TTL後に古いバッチを掃除しても実行許可は返さない", () => {
  const directory = journalDirectory();
  let clock = Date.parse("2026-08-22T00:00:00.000Z");
  const journal = createExecutionJournal({ directory, now: () => clock, ttlMs: 60_000 });
  journal.save(operation());
  utimesSync(recordPath(directory), new Date(clock), new Date(clock));

  clock += 59_000;
  assert.equal(journal.prune().removedBatches, 0);
  clock += 2_000;
  assert.equal(journal.prune().removedBatches, 1);
  assert.equal(existsSync(join(directory, BATCH_ID)), false);
  assert.deepEqual(journal.getBatch(BATCH_ID).operations, []);
});

test("破損した記録を持つバッチは期限後も消さず停止できるよう残す", () => {
  const directory = journalDirectory();
  let clock = Date.parse("2026-08-22T00:00:00.000Z");
  const journal = createExecutionJournal({ directory, now: () => clock, ttlMs: 60_000 });
  mkdirSync(join(directory, BATCH_ID), { recursive: true });
  mkdirSync(join(directory, BATCH_ID, "unexpected-directory"), { recursive: true });
  clock += 120_000;
  assert.equal(journal.prune().removedBatches, 0);
  assert.throws(() => journal.getBatch(BATCH_ID), ExecutionJournalIntegrityError);
});

test("送信せずに確定した操作は、同じ承認で送信を開き直せない", () => {
  const journal = createExecutionJournal({ directory: journalDirectory() });
  // 外部送信を開始していなくても、到達済みの確認だけで結果を確定できる。
  assert.equal(journal.save(operation({ status: "no_action_needed" })).status, "no_action_needed");
  // 同じ確認の繰り返しは通す。実行直前照合は何度でも同じ結論になる。
  assert.equal(journal.save(operation({ status: "no_action_needed" })).status, "no_action_needed");
  for (const status of ["ready", "dispatching", "confirmed", "unknown"]) {
    assert.throws(
      () => journal.save(operation({ status })),
      ExecutionJournalConflictError,
      status,
    );
  }
});

test("送信を開始した操作を、送らずに済んだ操作へ言い換えられない", () => {
  const journal = createExecutionJournal({ directory: journalDirectory() });
  journal.save(operation({ status: "dispatching" }));
  assert.throws(
    () => journal.save(operation({ status: "no_action_needed" })),
    ExecutionJournalConflictError,
  );
  assert.equal(journal.save(operation({ status: "confirmed" })).status, "confirmed");
});

test("結果照合は中断とunknownを残して確定し、再送も再確定も許さない", () => {
  for (const status of ["dispatching", "unknown"]) {
    const directory = journalDirectory();
    let journal = createExecutionJournal({ directory });
    journal.save(operation({ status: "dispatching" }));
    if (status === "unknown") journal.save(operation({ status }));
    journal = createExecutionJournal({ directory });
    const result = journal.reconcile(operation());
    assert.deepEqual(result.history.map((entry) => entry.status), ["dispatching", "unknown", "confirmed"]);
    assert.equal(journal.getOperation(operation()).status, "confirmed");
    assert.throws(() => journal.save(operation({ status: "dispatching" })), ExecutionJournalConflictError);
    assert.throws(() => journal.reconcile(operation()), ExecutionJournalConflictError);
  }
});

test("照合は別対象・未送信・旧記録の識別子を読み替えない", () => {
  const directory = journalDirectory();
  const journal = createExecutionJournal({ directory });
  assert.throws(() => journal.reconcile(operation()), ExecutionJournalConflictError);
  journal.save(operation({ status: "dispatching" }));
  journal.save(operation({ status: "unknown" }));
  assert.throws(() => journal.reconcile(operation({ targetCommentNumber: "96001" })), ExecutionJournalConflictError);
  const old = JSON.parse(readFileSync(recordPath(directory), "utf8"));
  delete old.history;
  old.version = 2;
  writeFileSync(recordPath(directory), JSON.stringify(old));
  const result = journal.reconcile(operation());
  assert.equal(result.operationId, old.operationId);
  assert.deepEqual(result.history[0], { status: "unknown", updatedAt: old.updatedAt });
});
