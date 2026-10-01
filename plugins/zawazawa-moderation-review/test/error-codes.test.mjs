import assert from "node:assert/strict";
import test from "node:test";
import {
  NEXT_ACTIONS,
  errorCodesForFamily,
  nextActionForErrorCode,
  nextActionForFailure,
} from "../server/error-codes.mjs";
import { ZawazawaConnectorError } from "../server/identifiers.mjs";
import {
  TargetConfigError,
  targetConfigErrorResult,
} from "../server/target-config.mjs";
import { connectorErrorResult } from "../server/references.mjs";
import {
  classifyExecutionPreconditionError,
  classifyReviewError,
  reviewErrorResult,
} from "../server/tool-errors.mjs";
import {
  EXECUTION_PRECONDITION_FAILURE_KINDS,
  ExecutionPreconditionError,
} from "../server/execution-preconditions.mjs";
import { ReviewInputError } from "../server/input-text.mjs";
import { ReviewStoreIntegrityError } from "../server/review-store.mjs";
import {
  ExecutionJournalConflictError,
  ExecutionJournalIntegrityError,
  ExecutionJournalInputError,
} from "../server/execution-journal.mjs";

test("読み取り経路の失敗だけが自動復旧経路を持つ", () => {
  const readerCodes = new Map(NEXT_ACTIONS.map((action) => [action, []]));
  for (const errorCode of errorCodesForFamily("connector")) {
    const action = nextActionForErrorCode(errorCode);
    // 分類外の行動は、この値で経路を決める側が扱えない。
    assert.ok(readerCodes.has(action), `${errorCode}: ${action}`);
    readerCodes.get(action).push(errorCode);
  }
  // 再認証と再試行はここにしかない。取得し直せば解ける失敗だけが対象になる。
  assert.deepEqual(readerCodes.get("reauth"), ["reauth_required"]);
  assert.deepEqual(readerCodes.get("retry"), [
    "profile_locked",
    "timed_out",
    "rate_limited",
  ]);
  // 人が見る経路なら読める失敗だけをブラウザへ移す。
  assert.deepEqual(readerCodes.get("browser"), [
    "blocked",
    "page_changed",
    "unknown",
  ]);
  // 対象不在と入力の誤りは、経路を変えても同じ結果になる。
  assert.deepEqual(readerCodes.get("stop"), ["not_found", "invalid_input"]);
});

test("承認経路の失敗はreview族の決まったコードへ落ちる", () => {
  // 族を検証範囲の正本にした以上、この経路の返り値が族の外へ出ると列挙が意味を失う。
  // 呼び出し側が行動を決める値はコードそのものなので、対応もここで固定する。
  const reviewCodes = errorCodesForFamily("review");
  for (const [error, expected] of [
    [new ReviewInputError("この一覧はありません。"), "review_input_invalid"],
    [new ReviewStoreIntegrityError("保存済み完全案が食い違います。"), "review_store_corrupt"],
    [
      new ExecutionJournalInputError("操作番号の形式が正しくありません。"),
      "journal_input_invalid",
    ],
    [new ExecutionJournalConflictError("すでに送信を開始しています。"), "journal_conflict"],
    [new ExecutionJournalIntegrityError("保存済み記録が破損しています。"), "journal_corrupt"],
    [new Error("diagnostic"), "review_store_unavailable"],
  ]) {
    const { errorCode } = classifyReviewError(error);
    assert.equal(errorCode, expected, error.name);
    assert.ok(reviewCodes.includes(errorCode), `${error.name}: ${errorCode}`);
  }
});

test("列挙を導く族名の取り違えを黙って空の範囲にしない", () => {
  // 空の列挙は型の付いたコードをすべて既定値へ倒すため、失敗として現れる必要がある。
  assert.throws(() => errorCodesForFamily("target-config"), /未知の失敗族/u);
});

test("対象設定と承認ストアの失敗は自動復旧経路を持たない", () => {
  for (const errorCode of [
    ...errorCodesForFamily("targetConfig"),
    ...errorCodesForFamily("review"),
  ]) {
    assert.equal(nextActionForErrorCode(errorCode), "stop", errorCode);
  }
});

test("実行経路はMCPが送信しない操作だけをブラウザへ移す", () => {
  // 差分、送信済み、前提の不成立は、経路を変えても押し直させない。
  assert.deepEqual(
    errorCodesForFamily("execution").map((errorCode) => [
      errorCode,
      nextActionForErrorCode(errorCode),
    ]),
    [
      ["browser_required", "browser"],
      ["precheck_mismatch", "stop"],
      ["operation_order_blocked", "stop"],
      ["already_dispatched", "stop"],
      ["approved_plan_invalid", "stop"],
      ["approval_integrity", "stop"],
      ["execution_precondition_invalid", "stop"],
    ],
  );
});

test("実行直前照合の失敗はexecution族の決まったコードへ落ちる", () => {
  // 族は分類器の値域である。この経路の停止理由を他の族のコードで返すと、実行経路の
  // 失敗が読み取りや入力の失敗と区別できなくなる。
  const executionCodes = errorCodesForFamily("execution");
  for (const [error, expected] of [
    [
      new ExecutionPreconditionError("approved_plan_invalid", "完全案を読み取れません。"),
      "approved_plan_invalid",
    ],
    [
      new ExecutionPreconditionError("approval_integrity", "対象が一致しません。"),
      "approval_integrity",
    ],
    [new Error("diagnostic"), "execution_precondition_invalid"],
  ]) {
    const { errorCode } = classifyExecutionPreconditionError(error);
    assert.equal(errorCode, expected, error.message);
    assert.ok(executionCodes.includes(errorCode), `${error.message}: ${errorCode}`);
  }
  // 型の付かない失敗の文言は外へ出さない。
  assert.equal(
    classifyExecutionPreconditionError(new Error("diagnostic")).message.includes(
      "diagnostic",
    ),
    false,
  );
  // 区分を足して写像を足し忘れると、その停止だけが受け皿のコードへ落ちて区別できなくなる。
  // 族の外や`undefined`を出さないことと合わせて、区分ごとの写像があることも固定する。
  for (const kind of EXECUTION_PRECONDITION_FAILURE_KINDS) {
    const { errorCode } = classifyExecutionPreconditionError(
      new ExecutionPreconditionError(kind, "固定文。"),
    );
    assert.ok(executionCodes.includes(errorCode), `${kind}: ${errorCode}`);
    assert.notEqual(errorCode, "execution_precondition_invalid", kind);
  }
});

test("未知のコードはfail closedで止める", () => {
  assert.equal(nextActionForErrorCode("something_new"), "stop");
  assert.equal(nextActionForErrorCode(undefined), "stop");
  // 継承したプロパティ名を分類済みのコードとして扱わない。
  assert.equal(nextActionForErrorCode("constructor"), "stop");
});

test("ブラウザ経路を禁じた失敗をbrowserへ誘導しない", () => {
  assert.equal(nextActionForFailure("page_changed"), "browser");
  assert.equal(
    nextActionForFailure("page_changed", { browserFallbackAllowed: true }),
    "browser",
  );
  assert.equal(
    nextActionForFailure("page_changed", { browserFallbackAllowed: false }),
    "stop",
  );
  // 禁止はブラウザ経路にだけ効く。再試行と再認証は同じ判断のまま残す。
  assert.equal(
    nextActionForFailure("timed_out", { browserFallbackAllowed: false }),
    "retry",
  );
  assert.equal(
    nextActionForFailure("reauth_required", { browserFallbackAllowed: false }),
    "reauth",
  );
});

test("型の付いた失敗コードを族の列挙で検証する", () => {
  assert.equal(
    new ZawazawaConnectorError("reauth_required", "再認証が必要です。").code,
    "reauth_required",
  );
  // 族の外のコードは、その族のfail closedな既定値へ落とす。
  assert.equal(
    new ZawazawaConnectorError("group_not_allowed", "対象外です。").code,
    "unknown",
  );
  assert.equal(
    new TargetConfigError("group_not_allowed", "対象外です。").code,
    "group_not_allowed",
  );
  assert.equal(
    new TargetConfigError("blocked", "拒否されました。").code,
    "target_config_invalid",
  );
});

test("各失敗結果がerrorCodeと同じ場所で次の行動を返す", () => {
  const connector = connectorErrorResult(
    new ZawazawaConnectorError("reauth_required", "再認証が必要です。"),
  );
  assert.equal(connector.structuredContent.nextAction, "reauth");

  const target = targetConfigErrorResult(
    new TargetConfigError("group_not_allowed", "対象外のグループです。"),
  );
  assert.equal(target.structuredContent.nextAction, "stop");

  const review = reviewErrorResult(
    new ReviewInputError("この一覧はありません。"),
  );
  assert.equal(review.structuredContent.errorCode, "review_input_invalid");
  assert.equal(review.structuredContent.nextAction, "stop");

  // 型の付かない失敗も、コードと同じく分類済みの行動を返す。
  const unexpected = reviewErrorResult(new Error("diagnostic"));
  assert.equal(unexpected.structuredContent.nextAction, "stop");
});

test("読み取り復旧の代替可否は説明文に依存しない", () => {
  for (const [code, action, allowed] of [
    ["reauth_required", "reauth", true],
    ["profile_locked", "retry", false],
    ["rate_limited", "retry", false],
    ["timed_out", "retry", true],
    ["blocked", "browser", true],
    ["page_changed", "browser", true],
    ["not_found", "stop", false],
    ["invalid_input", "stop", false],
  ]) {
    for (const message of ["固定の説明です。", "別の説明です。"] ) {
      const result = connectorErrorResult(new ZawazawaConnectorError(code, message));
      assert.deepEqual(result.structuredContent, {
        errorCode: code, nextAction: action, browserFallbackAllowed: allowed,
      });
    }
  }
  assert.equal(targetConfigErrorResult(new TargetConfigError("target_config_changed", "固定文。")).structuredContent.browserFallbackAllowed, false);
  assert.equal(reviewErrorResult(new Error("diagnostic")).structuredContent.browserFallbackAllowed, false);
});

test("実行経路の禁止と復旧分類を同時に守る", async () => {
  const { recoveryForFailure } = await import("../server/error-codes.mjs");
  for (const code of [...errorCodesForFamily("targetConfig"), ...errorCodesForFamily("review"), "operation_order_blocked", "profile_locked", "rate_limited", "not_found", "something_new", "constructor"]) {
    assert.equal(recoveryForFailure(code, { browserFallbackAllowed: true }).browserFallbackAllowed, false);
  }
  for (const code of ["reauth_required", "timed_out", "blocked", "browser_required"]) {
    const prohibited = recoveryForFailure(code, { browserFallbackAllowed: false });
    assert.equal(prohibited.browserFallbackAllowed, false);
    assert.notEqual(prohibited.nextAction, "browser");
    assert.equal(recoveryForFailure(code, { browserFallbackAllowed: true }).browserFallbackAllowed, true);
  }
});
