/**
 * 実行の語彙。
 *
 * 承認済み原子操作の種別と、外部送信境界に対する論理状態の名前だけを持つ。
 * 状態遷移の一般化された検証、試行世代、成功判定種別はここには無い。外部送信を
 * 二度開始しないという判定は、`execution-journal.mjs`が保存済みレコードに対して行う。
 */

export const EXECUTION_OPERATION_TYPES = Object.freeze([
  "comment_delete",
  "comment_restore",
  "author_auto_ignore",
  "author_auto_ignore_remove",
  // ブロック元の値自体は保存せず、外部操作の種別だけを残す。
  "source_block",
  "source_unblock",
  "report_complete",
  "report_ignore",
  "public_notice",
]);

/**
 * 一つの承認済み原子操作がとりうる状態。
 *
 * - `ready`       承認とライブ前提を確認済み。まだ外部送信境界へ入っていない。
 * - `no_action_needed` 実行直前照合で、送信しなくても承認済みの到達点に達していることを
 *                 確認済み。外部送信境界へ入らないまま確定した終端である。
 * - `dispatching` 外部送信を開始してよい状態を永続化済み。以降は自動再送しない。
 * - `confirmed`   ライブ読み戻しで効果を確認済み。
 * - `unknown`     外部送信を開始したが、結果を確定できない。
 */
export const EXECUTION_STATUSES = Object.freeze([
  "ready",
  "no_action_needed",
  "dispatching",
  "confirmed",
  "unknown",
]);

const OPERATION_TYPE_SET = new Set(EXECUTION_OPERATION_TYPES);
const STATUS_SET = new Set(EXECUTION_STATUSES);

export function isOperationType(value) {
  return OPERATION_TYPE_SET.has(value);
}

export function isExecutionStatus(value) {
  return STATUS_SET.has(value);
}

/** 外部送信を開始した、または開始した可能性がある状態か。自動再送を禁じる境界。 */
export function hasEnteredDispatch(status) {
  return status === "dispatching" || status === "confirmed" || status === "unknown";
}

/**
 * 外部送信を開始しないまま結果が確定した状態か。送っていないので再送の禁止には当たらないが、
 * 一つの承認済み操作の結果は一度だけ確定するので、ここから送信を開き直さない。
 */
export function isSettledWithoutDispatch(status) {
  return status === "no_action_needed";
}

/** 後続の承認済み原子操作へ進める、確定済みの成功状態か。 */
export function permitsFollowingOperation(status) {
  return status === "confirmed" || status === "no_action_needed";
}
