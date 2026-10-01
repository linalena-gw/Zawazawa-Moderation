import { ReviewInputError } from "./input-text.mjs";
import { ReviewStoreIntegrityError } from "./review-store.mjs";
import {
  ExecutionJournalConflictError,
  ExecutionJournalIntegrityError,
  ExecutionJournalInputError,
} from "./execution-journal.mjs";
import { ExecutionPreconditionError } from "./execution-preconditions.mjs";
import { ModerationReportError } from "./moderation-report.mjs";
import { recoveryForErrorCode } from "./error-codes.mjs";

/**
 * 失敗を`errorCode`へ落とす分類器を置く。各分類器の値域はちょうど一つの失敗族であり、
 * 呼び出し側は返ったコードをそのまま外へ出す。経路の都合で族の外のコードを選ばない。
 *
 * 承認ストアと実行ジャーナル由来の失敗を、コネクタや対象設定と同じ形へ寄せる。
 * skillは文言ではなく`errorCode`と`nextAction`で行動を決めるため、承認の取得と
 * 記録の失敗だけ生の例外のままだと、どの失敗にどう対応するかを機械的に判別できない。
 */
export function reviewErrorResult(error) {
  const { errorCode, message } = classifyReviewError(error);
  return {
    isError: true,
    structuredContent: { errorCode, ...recoveryForErrorCode(errorCode) },
    content: [{ type: "text", text: `[${errorCode}] ${message}` }],
  };
}

/** 承認ストアと実行ジャーナル由来の失敗を`errorCode`へ落とす。 */
export function classifyReviewError(error) {
  // 型の付いた失敗の文言は固定文なのでそのまま返す。それ以外は保存先の診断や
  // 取得ライブラリ由来の値を含み得るため、固定文へ落として外へ出さない。
  if (error instanceof ReviewInputError) {
    return { errorCode: "review_input_invalid", message: error.message };
  }
  if (error instanceof ReviewStoreIntegrityError) {
    return { errorCode: "review_store_corrupt", message: error.message };
  }
  if (error instanceof ExecutionJournalInputError) {
    return { errorCode: "journal_input_invalid", message: error.message };
  }
  if (error instanceof ExecutionJournalConflictError) {
    return { errorCode: "journal_conflict", message: error.message };
  }
  if (error instanceof ExecutionJournalIntegrityError) {
    return { errorCode: "journal_corrupt", message: error.message };
  }
  if (error instanceof ModerationReportError) {
    return { errorCode: "report_write_failed", message: error.message };
  }
  return {
    errorCode: "review_store_unavailable",
    message:
      "承認ストアまたは実行ジャーナルを読み書きできませんでした。保存先を確認してください。実行許可としては扱わないでください。",
  };
}

/** 失敗を`reviewErrorResult`へ寄せてツール応答を返す。 */
export async function withReviewErrors(handler) {
  try {
    return await handler();
  } catch (error) {
    return reviewErrorResult(error);
  }
}

/**
 * 実行直前照合の前提を組み立てられなかった失敗を`execution`族の`errorCode`へ落とす。
 * 区分は`execution-preconditions.mjs`の語彙、コードは`error-codes.mjs`の語彙であり、
 * 対応をここだけで持つ。
 */
const EXECUTION_PRECONDITION_ERROR_CODES = Object.freeze({
  approved_plan_invalid: "approved_plan_invalid",
  approval_integrity: "approval_integrity",
});

export function classifyExecutionPreconditionError(error) {
  const errorCode =
    error instanceof ExecutionPreconditionError
      ? EXECUTION_PRECONDITION_ERROR_CODES[error.kind]
      : undefined;
  if (errorCode) return { errorCode, message: error.message };
  // 型の付かない失敗と、写像を足し忘れた区分は、前提を組み立てられなかったこと自体として
  // 止める。族の外の値や`undefined`を外へ出さない。文言は固定文へ落とし、内部の診断を
  // 外へ出さない。
  return {
    errorCode: "execution_precondition_invalid",
    message:
      "承認済み完全案から実行直前照合の前提を組み立てられません。この単位を実行せず、一覧を作り直してください。",
  };
}
