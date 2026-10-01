/**
 * ExecutionPreconditions。
 *
 * 承認済み原子操作を実行してよいかを、実行直前の事実だけで判定する純粋な部品である。
 * 承認時に確定した事実とライブ管理画面から読んだ事実を同じ構造へ正規化し、その差分だけを
 * 返す。永続化、時刻の取得、I/O、ZAWAZAWA画面の解析、MCPの入出力は扱わない。
 *
 * 保持する条件は、その原子操作を実行するために本当に必要なものだけにする。対象コメントの
 * 全体像や、そのコメントに付いた未処理通報の全集合は前提にしない。承認後に別の新規通報が
 * 増えただけでは止まらず、通報を必要としない操作は通報表を読めなくても止まらない。
 *
 * 通報表が1ページに収まらない画面では、読めた行がその対象の未処理通報の全部ではない。
 * 対象コメントの未処理通報をまとめて閉じる完了は、読めた行に無い承認済み通報も同じ送信で
 * 閉じるため、行が見えないことだけでは止めず、未読の通報として分ける。閉じる先を通報ごとに
 * 指す無視では、同じ状況をこれまでどおり停止として返す。
 *
 * 差分は一律の停止にしない。承認済み操作が達成しようとした状態へ、その送信なしに既に
 * 達している場合は、送らずに済んだ操作として分ける。他の管理者の対応と投稿者自身の削除が
 * ここへ入り、同じ処理単位の残りの操作は承認どおり続けられる。到達点も、その手前の事実も
 * 確かめられない場合だけを停止として返す。
 *
 * 操作対象と操作先の実在確認は`admin-writer.mjs`が管理画面から厳密に行う。ここが最小限で
 * 済むのはその前提の上である。本文、通報理由、投稿者、通報者、接続元はこの構造へ入らない。
 */

import { DELETED_COMMENT_STATE, GROUP_KEY, NUMBER } from "./identifiers.mjs";

export const EXECUTION_PRECONDITIONS_SCHEMA = "execution-preconditions/v2";

/** 差分ではなく取得失敗。通報を必要とする操作でだけ差分として現れる。 */
export const OPEN_REPORTS_UNREADABLE = "open_reports_unreadable";

/** 読めなかった未処理通報。0件とも既知の集合とも区別できる値として持つ。 */
const UNREADABLE_OPEN_REPORTS = Symbol("unreadable-open-reports");

/** コメントの管理状態が操作の意味に直接影響する操作。承認時の観測状態を前提にする。 */
const STATE_DEPENDENT_OPERATION_TYPES = new Set(["comment_delete", "comment_restore"]);

/** その原子操作が対象とする通報が未処理であることを前提にする操作。 */
const REPORT_DEPENDENT_OPERATION_TYPES = new Set(["report_complete", "report_ignore"]);

/**
 * その操作が達成しようとした状態へ、ライブ側が既に達しているか。読めなかった現在状態は
 * 達成の証拠にしない。
 */
function reachesApprovedOutcome(operationType, currentState) {
  if (typeof currentState !== "string" || currentState === "") return false;
  if (operationType === "comment_delete") return currentState === DELETED_COMMENT_STATE;
  if (operationType === "comment_restore") return currentState !== DELETED_COMMENT_STATE;
  return false;
}

/**
 * 生成失敗の区分。前提を組み立てられないことだけを表す。読めなかった現在状態と通報表は
 * 必要とする操作の比較でだけ差分になるため、この区分では扱わない。読み取れない承認済み
 * 完全案（`approved_plan_invalid`）と、承認済み対象と照合相手の対象が食い違う失敗
 * （`approval_integrity`）を分け、前者は一覧を作り直せば解け、後者は照合そのものが
 * 成立していない。
 */
export const EXECUTION_PRECONDITION_FAILURE_KINDS = Object.freeze([
  "approved_plan_invalid",
  "approval_integrity",
]);

export class ExecutionPreconditionError extends Error {
  constructor(kind, message) {
    super(message);
    // 区分の綴り違いは呼び出し側の停止先を静かに変える。生成時に閉じる。
    if (!EXECUTION_PRECONDITION_FAILURE_KINDS.includes(kind)) {
      throw new TypeError(`未定義の実行直前照合の失敗区分です: ${kind}`);
    }
    this.name = "ExecutionPreconditionError";
    this.kind = kind;
  }
}

/** 承認時に保存した完全案と原子操作から、この操作の前提を読み取れない。 */
function approvedPlanInvalidError(message) {
  return new ExecutionPreconditionError("approved_plan_invalid", message);
}

/** 承認済み対象と、照合しようとしている対象が一致しない。 */
function approvalIntegrityError(message) {
  return new ExecutionPreconditionError("approval_integrity", message);
}

// 承認済みtargetの管理画面参照は、承認時に確定した公開URLからだけ解決する。
// 番号やURLを組み立てない。
const PUBLIC_COMMENT_URL =
  /^https:\/\/z\.wikiwiki\.jp\/([^/]+)\/topic\/([1-9][0-9]*)\/([1-9][0-9]*)$/u;

function isIdentifier(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

/** 承認側とライブ側で同じ形の対象識別子だけを通す。 */
function buildTarget({ groupKey, topicNumber, commentNumber }) {
  if (
    !isIdentifier(groupKey, GROUP_KEY) ||
    !isIdentifier(topicNumber, NUMBER) ||
    !isIdentifier(commentNumber, NUMBER)
  ) {
    return null;
  }
  return Object.freeze({ groupKey, topicNumber, commentNumber });
}

/**
 * 承認済みtargetから管理画面参照を解決する。承認時に確定した公開URLだけを根拠にし、
 * 解決できない場合は`null`を返す。呼び出し側は対象を推測して補わない。
 */
export function approvedTargetReference(target) {
  const match = PUBLIC_COMMENT_URL.exec(target?.url || "");
  if (!match) return null;
  return buildTarget({
    groupKey: match[1],
    topicNumber: match[2],
    commentNumber: match[3],
  });
}

/**
 * 承認時に確定した事実だけから、この原子操作に必要な前提を導く。呼び出し側から現在状態や
 * 通報IDを受け取らないため、実行経路の申告で承認済みの事実を差し替えられない。
 *
 * `expectedState`はコメントの管理状態を前提にする操作にだけ入れ、実装側で`"通常"`などの
 * 既定値を補わない。`requiredOpenReportIds`はその原子操作が対象とする通報だけを持ち、
 * 対象コメント上の全通報を集めない。
 */
export function deriveApprovalExecutionPreconditions({ resolvedPlan, executionStep }) {
  const commentNumber = executionStep?.targetCommentNumber;
  if (!isIdentifier(commentNumber, NUMBER)) {
    throw approvedPlanInvalidError(
      "承認済み原子操作の対象コメント番号を読み取れません。一覧を作り直してください。",
    );
  }
  const approvedTarget = (resolvedPlan?.targets || []).find(
    (entry) => entry?.commentNumber === commentNumber,
  );
  const reference = approvedTargetReference(approvedTarget);
  const target = reference?.commentNumber === commentNumber ? reference : null;
  if (!target) {
    throw approvedPlanInvalidError(
      "承認済み完全案から対象コメントの管理画面を特定できません。一覧を作り直してください。",
    );
  }

  const preconditions = {
    schema: EXECUTION_PRECONDITIONS_SCHEMA,
    target,
    operationType: executionStep.operationType,
  };

  // 承認時の対象状態。照合の前提ではなく、実行直前に削除済みへ変わったかの判定にだけ使う。
  // 読み取れない場合は変化を判定しない。
  if (typeof approvedTarget.currentState === "string" && approvedTarget.currentState !== "") {
    preconditions.approvedState = approvedTarget.currentState;
  }

  if (STATE_DEPENDENT_OPERATION_TYPES.has(executionStep.operationType)) {
    const expectedState = approvedTarget.currentState;
    if (typeof expectedState !== "string" || expectedState === "") {
      throw approvedPlanInvalidError(
        "承認済み完全案に対象コメントの現在状態がありません。一覧を作り直してください。",
      );
    }
    preconditions.expectedState = expectedState;
  }

  if (REPORT_DEPENDENT_OPERATION_TYPES.has(executionStep.operationType)) {
    const reportIds = executionStep.reportIds;
    if (
      !Array.isArray(reportIds) ||
      reportIds.length === 0 ||
      reportIds.some((reportId) => typeof reportId !== "string" || reportId === "") ||
      new Set(reportIds).size !== reportIds.length
    ) {
      throw approvedPlanInvalidError(
        "承認済み通報操作の対象通報IDが一意ではありません。一覧を作り直してください。",
      );
    }
    preconditions.requiredOpenReportIds = Object.freeze([...reportIds].sort());
  }

  return Object.freeze(preconditions);
}

/**
 * 実行直前に読んだ許可リスト済みの事実から同じ構造を導く。`liveFacts`は本文、通報理由、
 * 投稿者、接続元を含まない。読めなかった現在状態と通報表は既定値へ変換せず未取得のまま
 * 持ち、必要とする操作の比較でだけ差分になる。
 */
export function deriveLiveExecutionPreconditions({
  targetReference,
  liveFacts,
  executionStep,
}) {
  const commentNumber = executionStep?.targetCommentNumber;
  // 承認側を読み取れないことは、照合相手との食い違いではない。承認側の生成と同じ区分で返す。
  if (!isIdentifier(commentNumber, NUMBER)) {
    throw approvedPlanInvalidError(
      "承認済み原子操作の対象コメント番号を読み取れません。一覧を作り直してください。",
    );
  }
  const target =
    targetReference?.commentNumber === commentNumber ? buildTarget(targetReference) : null;
  if (!target) {
    throw approvalIntegrityError(
      "実行直前に読んだ対象が承認済み原子操作の対象と一致しません。この単位を実行しないでください。",
    );
  }
  const currentState =
    typeof liveFacts?.currentState === "string" && liveFacts.currentState !== ""
      ? liveFacts.currentState
      : undefined;
  // 読めた未処理通報がその対象の全部かどうか。読めなかった画面では立てない。
  // 読めたと明示されていない通報表を、読めたものとして扱わない。0件へ変換しない。
  const readable =
    liveFacts?.reportsUnavailable === false && Array.isArray(liveFacts.openReportIds);
  const reportIds = (values) =>
    Object.freeze(
      (Array.isArray(values) ? values : []).filter(
        (reportId) => typeof reportId === "string" && reportId !== "",
      ),
    );
  return Object.freeze({
    schema: EXECUTION_PRECONDITIONS_SCHEMA,
    target,
    currentState,
    openReportIds: readable ? reportIds(liveFacts.openReportIds) : UNREADABLE_OPEN_REPORTS,
    // 処理済みの通報表。未処理から消えた通報が閉じられたのか、行ごと消えたのかを分ける。
    closedReportIds: readable ? reportIds(liveFacts.closedReportIds) : UNREADABLE_OPEN_REPORTS,
    openReportsTruncated: readable && liveFacts.openReportsTruncated === true,
  });
}

function isExecutionPreconditions(value) {
  return value?.schema === EXECUTION_PRECONDITIONS_SCHEMA && Boolean(value.target);
}

/**
 * 正常に構築された前提同士だけを比較し、この原子操作の行き先へ分ける。承認側が必要と
 * しない事実は、ライブ側で読めなくても停止にしない。別targetの比較は差分ではなく整合性の
 * 失敗として止める。
 *
 * - `blocking`が空でなければ止める。承認済みの到達点も、その手前の事実も確かめられない。
 * - `alreadySatisfied`は、送らなくても承認済みの到達点に達している状態である。
 * - どちらでもなければ送信する。送信する場合に実際に対象とする通報は
 *   `pendingReportIds`、承認後に増えた未処理通報は`addedOpenReportIds`、読み切れなかった
 *   通報表のせいで行を追えない承認済み通報は`unlistedReportIds`にある。
 */
export function classifyExecutionPreconditions(expected, live) {
  if (!isExecutionPreconditions(expected) || !isExecutionPreconditions(live)) {
    throw approvalIntegrityError(
      "実行直前照合の前提を構築できていません。この単位を実行しないでください。",
    );
  }
  if (
    expected.target.groupKey !== live.target.groupKey ||
    expected.target.topicNumber !== live.target.topicNumber ||
    expected.target.commentNumber !== live.target.commentNumber
  ) {
    throw approvalIntegrityError(
      "実行直前照合の対象が承認済み対象と異なります。この単位を実行しないでください。",
    );
  }

  const blocking = [];
  let alreadySatisfied = false;
  if (expected.expectedState !== undefined && expected.expectedState !== live.currentState) {
    // 承認時と状態が違っても、この操作の到達点そのものへ達しているなら送る先が無い。
    if (reachesApprovedOutcome(expected.operationType, live.currentState)) {
      alreadySatisfied = true;
    } else {
      blocking.push("current_state");
    }
  }

  const requiredOpenReportIds = expected.requiredOpenReportIds ?? [];
  const pendingReportIds = [];
  const settledReportIds = [];
  const addedOpenReportIds = [];
  const unlistedReportIds = [];
  if (requiredOpenReportIds.length > 0) {
    if (live.openReportIds === UNREADABLE_OPEN_REPORTS) {
      blocking.push(OPEN_REPORTS_UNREADABLE);
    } else {
      for (const reportId of requiredOpenReportIds) {
        if (live.openReportIds.includes(reportId)) {
          pendingReportIds.push(reportId);
        } else if (live.closedReportIds.includes(reportId)) {
          // 他の管理者がすでに閉じた通報。閉じ直す先が無いだけで、食い違いではない。
          settledReportIds.push(reportId);
        } else if (live.openReportsTruncated && expected.operationType === "report_complete") {
          // 通報表を読み切れていない画面では、行が見えないことは処理済みの証拠でも
          // 消失の証拠でもない。対象コメントの未処理通報をまとめて閉じる完了は、この
          // 通報も同じ送信で閉じるので止めない。
          unlistedReportIds.push(reportId);
        } else {
          // 未処理にも処理済みにも無い通報は、承認時の対象を追えていない。
          blocking.push(`report_missing:${reportId}`);
        }
      }
      for (const reportId of live.openReportIds) {
        if (!requiredOpenReportIds.includes(reportId)) addedOpenReportIds.push(reportId);
      }
      // 承認済み通報がすべて処理済みなら、この操作で閉じるものは残っていない。行を
      // 追えない通報が残る画面では、閉じる先が無いとは言えないので送信側へ回す。
      if (blocking.length === 0 && pendingReportIds.length === 0 && unlistedReportIds.length === 0) {
        alreadySatisfied = true;
      }
    }
  }

  return Object.freeze({
    blocking: Object.freeze(blocking),
    alreadySatisfied,
    pendingReportIds: Object.freeze(pendingReportIds),
    settledReportIds: Object.freeze(settledReportIds),
    addedOpenReportIds: Object.freeze(addedOpenReportIds),
    unlistedReportIds: Object.freeze(unlistedReportIds),
    // 読めた未処理通報がその対象の全部ではない。閉じる通報を通報ごとに指せない。
    openReportsTruncated: live.openReportsTruncated === true,
    // 承認時は削除されていなかった対象が、この操作の送信なしに削除済みになっている。
    // 誰が削除したかは管理画面から読めないため、他の管理者の対応と投稿者自身の削除を
    // ここでは分けない。
    targetDeletedBeforeExecution:
      expected.approvedState !== undefined &&
      expected.approvedState !== DELETED_COMMENT_STATE &&
      live.currentState === DELETED_COMMENT_STATE,
  });
}
