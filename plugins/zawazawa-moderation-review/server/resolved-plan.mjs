/**
 * 完全案の解決。
 *
 * 保存済みスナップショットと管理者の構造化変更から、実行する対象・操作・本文を
 * 一意に決めた完全案と、その原子操作への展開を作る。現在状態と通報IDはクライアント
 * 入力から受け取らず、常にスナップショットの値へ戻す。保存も入力の正規化もしない。
 *
 * 完全案は、選択対象だけへ正規化した承認時状態、安定した`reportId`集合、全操作と順序、
 * 操作別メッセージ全文、原子化した`executionSteps`を持つ。推奨案へ入れる本文は推奨する操作へ
 * 束縛されたものだけとし、追加候補にだけ束縛された本文は送らない本文として落とす。実行順は
 * 管理者の入力ではなくスナップショットの操作候補の宣言順とし、選択集合をこの宣言順へ正規化
 * するため、選択の入力順で承認内容は変わらない。`executionSteps`は原子操作ごとに宣言対象、
 * 対象`reportId`集合、束縛したメッセージ全文を載せ、`no_external_action`は外部操作として
 * 展開しない。
 *
 * メッセージは、対象が先に削除済みだった場合に代わりに送る本文（`alreadyDeletedText`）を任意で
 * 持てる。この本文を送る場面があるのは通報完了だけで、他の操作へ束縛した本文が持つと一覧を
 * 作らずに止める。どちらを送るかの実行時の判定は`admin-writer.mjs`が持つ。
 *
 * 代替案は独立した判断ではなく、行の選択が推奨案と違うことから決まる。UIが渡す構造化変更を
 * 編集不可なスナップショットへ適用し、同じ形の案とトークンを返す。プレビューは承認も外部操作も
 * 記録しない。構造化変更は、対象選択、実行する操作の選択、操作ごとの対象、各メッセージの
 * `維持`・`置換`・`送信しない`とする。`置換`は通常の本文と削除済みだった場合の本文を同じ扱いで
 * 受け取り、指定の無い側はスナップショットの本文を残す。片方だけを書き換えても、もう片方が
 * 黙って落ちないようにするためである。
 *
 * 対象に選べるのは、提案された処置対象候補と、その処理単位で表示したコメントツリーのうち現在
 * 状態と公開URLを解決できたコメントとする。ツリーに出ているコメントはどれも対処の検討対象で
 * あり、提案に無いという理由だけで選べないと一覧が管理者の判断を表せない。ただし状態か解決元を
 * 欠くコメントは選べない対象として外す。承認時状態を欠いたまま完全案へ入れると、実行直前照合が
 * 期待状態を持てず、管理者が承認した後になって破損として止まるためである。承認時状態はどちらも
 * サーバーが解決した値をそのまま戻し、クライアント入力から受け取らない。
 *
 * 操作ごとの対象は選択済み対象の部分集合に限る。コメント単位の操作（`comment_delete`、
 * `comment_restore`）だけは行の選択そのものを対象とし、宣言対象は既定値として扱う。それ以外の
 * 操作は宣言対象の狭めだけを受け付け、宣言していない対象へ広げられない。削除する対象と通報を
 * 閉じる対象が分かれる場合、対象選択だけでは両方を同時に表せないためである。メッセージの扱いは
 * 操作の選択と本文の編集からそのまま導く。書き換えていない本文は`維持`、`送信しない`を選んだ
 * 本文と、選択されなかった操作へ束縛された本文は`omit`とする。送信必須の操作について
 * `送信しない`は選べず、結果として送信操作に束縛されないメッセージが残る場合は案を作らずに止める。
 *
 * 対象候補、承認時状態、`reportId`集合はスナップショットの編集不可な事実である。最終送信時は
 * 推奨案も代替案もサーバーが同じスナップショットから案を再計算し、UIが表示した対応トークンと
 * 一致する場合だけ一回だけ承認記録へ保存する。クライアントが組み立てた完全案、自由文だけの変更、
 * トークンのない案は実行許可にしない。表示後にスナップショットまたは構造化変更が変わった場合、
 * 古いトークンでは承認できない。
 *
 * 次の値は承認境界としてここが保持し、実行直前照合にだけ使う。一覧UIは選択の内部キーとして持つ
 * ことはあっても、管理者への表示へは出さない。画面が出す範囲そのものは`ui/review.html`の
 * スクリプト直前のコメントが持つ。
 * ・安定した`reportId`と通報件数の内訳
 * ・`executionSteps`への原子分解と、操作の実行順の番号
 * ・`operationType`の内部コード、`operationId`、`messageId`
 * ・`snapshotReportCount`と`snapshotReportIds`（実行対象外を含む一覧全体の通報）
 */
import { createHash } from "node:crypto";
import { EXECUTION_OPERATION_TYPES } from "./execution-lifecycle.mjs";
import {
  assertNoSensitiveData,
  cleanCommentNumber,
  inputArray,
  inputText,
  REPORT_ID_PATTERN,
  ReviewInputError,
} from "./input-text.mjs";

export const RESOLVED_PLAN_OPERATION_TYPES = Object.freeze([
  ...EXECUTION_OPERATION_TYPES,
  "no_external_action",
]);
export const RESOLVED_PLAN_OPERATION_LABELS = Object.freeze({
  comment_delete: "コメント削除",
  comment_restore: "コメント復元",
  author_auto_ignore: "投稿者の自動無視",
  author_auto_ignore_remove: "投稿者の自動無視解除",
  source_block: "接続元ブロック",
  source_unblock: "接続元ブロック解除",
  report_complete: "通報完了",
  report_ignore: "通報無視",
  public_notice: "公開案内の投稿",
  no_external_action: "外部操作なし",
});
export const RESOLVED_PLAN_OPERATION_TYPE_SET = new Set(RESOLVED_PLAN_OPERATION_TYPES);
export const REPORT_OPERATION_TYPES = new Set([
  "report_complete",
  "report_ignore",
]);
export const MESSAGE_REQUIRED_OPERATION_TYPES = new Set(["public_notice"]);
export const MESSAGE_ALLOWED_OPERATION_TYPES = new Set([
  "report_complete",
  ...MESSAGE_REQUIRED_OPERATION_TYPES,
]);
// 対象が先に削除済みだったときに代わりに送る本文を持てる操作。承認時に一緒に確定させ、
// 実行直前照合の結果でサーバーが選ぶ。実行時に新しい文面を作らないための口である。
export const FALLBACK_MESSAGE_OPERATION_TYPES = new Set(["report_complete"]);
export const SINGLE_ANCHOR_OPERATION_TYPES = new Set([
  "author_auto_ignore",
  "author_auto_ignore_remove",
  "source_block",
  "source_unblock",
  "public_notice",
]);
// コメント行で選ぶ操作。対象は宣言ではなく行の選択そのものとする。
const COMMENT_SCOPED_OPERATION_TYPES = new Set(["comment_delete", "comment_restore"]);

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function reportIdsFor(item) {
  const seen = new Set();
  const reportIds = [];
  for (const report of item.reports || []) {
    if (!report.reportId) continue;
    if (!REPORT_ID_PATTERN.test(report.reportId)) {
      throw new ReviewInputError(`投稿 ${item.id} の通報ID ${report.reportId} の形式が正しくありません。`);
    }
    if (seen.has(report.reportId)) {
      throw new ReviewInputError(`投稿 ${item.id} の通報ID ${report.reportId} が重複しています。`);
    }
    seen.add(report.reportId);
    reportIds.push(report.reportId);
  }
  return reportIds;
}

function reportFactsFor(item, targets) {
  const selectedTargetNumbers = new Set(targets.map((target) => target.commentNumber));
  const allTargetNumbers = new Set(
    item.recommendation.targets.map((target) => target.commentNumber),
  );
  const rowsByTarget = new Map(
    targets.map((target) => [target.commentNumber, []]),
  );
  const unmappedReports = [];
  const outsideTargetReports = [];
  const selectedReports = [];
  const onlyTargetNumber = item.recommendation.targets.length === 1
    ? item.recommendation.targets[0].commentNumber
    : null;

  for (const report of item.reports || []) {
    let targetCommentNumber = report.targetCommentNumber;
    if (!targetCommentNumber) {
      if (!onlyTargetNumber) {
        unmappedReports.push(report);
        continue;
      }
      targetCommentNumber = onlyTargetNumber;
    }
    if (!allTargetNumbers.has(targetCommentNumber)) {
      outsideTargetReports.push(report);
      continue;
    }
    if (!selectedTargetNumbers.has(targetCommentNumber)) continue;
    const resolvedReport = { ...report, targetCommentNumber };
    selectedReports.push(resolvedReport);
    rowsByTarget.get(targetCommentNumber).push(resolvedReport);
  }

  const reportIds = selectedReports
    .map((report) => report.reportId)
    .filter(Boolean);
  return {
    reportCount: selectedReports.length,
    reportIds,
    reportBindings: selectedReports
      .filter((report) => report.reportId)
      .map((report) => ({
        reportId: report.reportId,
        targetCommentNumber: report.targetCommentNumber,
      })),
    rowsByTarget,
    unmappedReports,
    outsideTargetReports,
  };
}

function executionStepsFor(item, targets, operations, reportFacts, messageById) {
  const externalOperations = operations.filter(
    (operation) => operation.operationType !== "no_external_action",
  );
  if (externalOperations.length === 0) return [];

  const selectedTargetByNumber = new Map(
    targets.map((target) => [target.commentNumber, target]),
  );
  if (externalOperations.length > 0) {
    if (item.reportCount !== (item.reports || []).length) {
      throw new ReviewInputError(
        `投稿 ${item.id} の通報件数と保存済み通報行が一致しません。管理画面を確認して一覧を作り直してください。`,
      );
    }
    if (reportFacts.unmappedReports.length > 0) {
      throw new ReviewInputError(
        `投稿 ${item.id} の通報を対象コメントへ一意に対応付けられません。対象コメント番号付きで一覧を作り直してください。`,
      );
    }
    if (reportFacts.outsideTargetReports.length > 0) {
      throw new ReviewInputError(
        `投稿 ${item.id} の通報対象に処置対象候補へ含まれないコメントがあります。管理画面を確認して一覧を作り直してください。`,
      );
    }
  }

  const executionSteps = [];
  for (const operation of externalOperations) {
    // 操作側で宣言した順序を保ち、管理者が選択した対象との共通部分だけを
    // 原子操作へ展開する。投稿者・接続元単位の操作も、宣言した一対象を
    // anchorとして一度だけ記録する。
    const operationTargets = operation.targetCommentNumbers
      .filter((commentNumber) => selectedTargetByNumber.has(commentNumber))
      .map((commentNumber) => selectedTargetByNumber.get(commentNumber));
    if (operationTargets.length === 0) {
      throw new ReviewInputError(
        `投稿 ${item.id} の外部操作 ${operation.operationId} には選択済み対象がありません。対象と操作を選び直してください。`,
      );
    }
    if (
      SINGLE_ANCHOR_OPERATION_TYPES.has(operation.operationType) &&
      reportFacts.reportIds.length !== reportFacts.reportCount
    ) {
      throw new ReviewInputError(
        `投稿 ${item.id} の処理単位全体の操作 ${operation.operationId} に、安定した通報IDがない通報があります。管理画面を確認して一覧を作り直してください。`,
      );
    }
    for (const target of operationTargets) {
      const reportRows = reportFacts.rowsByTarget.get(target.commentNumber) || [];
      if (reportRows.some((report) => !report.reportId)) {
        throw new ReviewInputError(
          `投稿 ${item.id} の外部操作 ${operation.operationId} の対象 ${target.commentNumber} に安定した通報IDがない通報があります。管理画面を確認して一覧を作り直してください。`,
        );
      }
      if (REPORT_OPERATION_TYPES.has(operation.operationType)) {
        if (reportRows.length === 0) {
          throw new ReviewInputError(
            `投稿 ${item.id} の通報操作 ${operation.operationId} の対象 ${target.commentNumber} に未処理通報がありません。管理画面を確認して一覧を作り直してください。`,
          );
        }
      }
      const reportIds = SINGLE_ANCHOR_OPERATION_TYPES.has(operation.operationType)
        ? [...reportFacts.reportIds].sort()
        : reportRows.map((report) => report.reportId).filter(Boolean).sort();
      // 無視だけは通報IDごとに原子化する。一括完了の意味は変えない。
      const reportGroups = operation.operationType === "report_ignore"
        ? reportIds.map((reportId) => [reportId]) : [reportIds];
      for (const stepReportIds of reportGroups) {
        if (executionSteps.length >= 10000) {
          throw new ReviewInputError("原子操作数の上限を超えています。一覧を分割してください。");
        }
        executionSteps.push({
          operationIndex: executionSteps.length,
          planOperationId: operation.operationId,
          operationType: operation.operationType,
          targetCommentNumber: target.commentNumber,
          reportIds: [...stepReportIds],
          messages: operation.messageIds.map((messageId) => ({ ...messageById.get(messageId) })),
        });
      }
    }
  }
  return executionSteps;
}

function bindResolvedMessages(item, operations, messages) {
  const messageById = new Map(messages.map((message) => [message.messageId, message]));
  const referenceCounts = new Map(messages.map((message) => [message.messageId, 0]));
  const resolvedOperations = operations.map((operation) => {
    // omitされた本文は操作からも落とす。送信必須の操作はこの後の件数検証で
    // 閉鎖側に止まり、別操作へ暗黙に付け替えない。
    const messageIds = operation.messageIds.filter((messageId) =>
      messageById.has(messageId),
    );
    if (
      MESSAGE_REQUIRED_OPERATION_TYPES.has(operation.operationType) &&
      messageIds.length !== 1
    ) {
      throw new ReviewInputError(
        `投稿 ${item.id} の操作 ${operation.operationId} は送信するメッセージを1件残してください。`,
      );
    }
    if (messageIds.length > 1) {
      throw new ReviewInputError(
        `投稿 ${item.id} の操作 ${operation.operationId} は一つの原子操作へ複数のメッセージを束縛できません。`,
      );
    }
    if (!MESSAGE_ALLOWED_OPERATION_TYPES.has(operation.operationType) && messageIds.length > 0) {
      throw new ReviewInputError(
        `投稿 ${item.id} の操作 ${operation.operationId} の種別ではメッセージを送信できません。`,
      );
    }
    for (const messageId of messageIds) {
      // 送る場面の無い代替本文は、送るつもりで書いたのに送られない本文になる。
      if (
        messageById.get(messageId)?.alreadyDeletedText !== undefined &&
        !FALLBACK_MESSAGE_OPERATION_TYPES.has(operation.operationType)
      ) {
        throw new ReviewInputError(
          `投稿 ${item.id} の操作 ${operation.operationId} の種別では、削除済みだった場合の本文を送れません。`,
        );
      }
      referenceCounts.set(messageId, (referenceCounts.get(messageId) || 0) + 1);
    }
    return { ...operation, messageIds };
  });

  for (const message of messages) {
    const count = referenceCounts.get(message.messageId) || 0;
    if (count === 0) {
      throw new ReviewInputError(
        `投稿 ${item.id} のメッセージ ${message.messageId} は選択した操作に結び付いていません。操作ごとの対応を選び直してください。`,
      );
    }
    if (count > 1) {
      throw new ReviewInputError(
        `投稿 ${item.id} のメッセージ ${message.messageId} が複数の操作に結び付いています。原子操作ごとに一意な本文を指定してください。`,
      );
    }
  }
  return { operations: resolvedOperations, messageById };
}

function resolvedPlanFor(item, targets, operations, messages) {
  const snapshotReportIds = reportIdsFor(item);
  const reportFacts = reportFactsFor(item, targets);
  const resolvedMessages = bindResolvedMessages(item, operations, messages);
  const plan = {
    itemId: item.id,
    targets,
    reportCount: reportFacts.reportCount,
    reportIds: reportFacts.reportIds,
    reportBindings: reportFacts.reportBindings,
    snapshotReportCount: item.reportCount,
    snapshotReportIds,
    operations: resolvedMessages.operations,
    messages,
  };
  plan.executionSteps = executionStepsFor(
    item,
    plan.targets,
    plan.operations,
    reportFacts,
    resolvedMessages.messageById,
  );
  return plan;
}

function resolvedOperationForCandidate(item, candidate, operationId) {
  if (!candidate) {
    throw new ReviewInputError(`投稿 ${item.id} の操作 ${operationId} の定義がありません。`);
  }
  const operationType = candidate.operationType || "no_external_action";
  let targetCommentNumbers;
  if (Array.isArray(candidate.targetCommentNumbers)) {
    targetCommentNumbers = candidate.targetCommentNumbers.map((value) =>
      cleanCommentNumber(value, `投稿 ${item.id} の操作 ${operationId} の対象コメント番号`),
    );
  } else if (operationType === "no_external_action") {
    // createReviewStoreへ正規化済みデータを直接渡していた旧呼び出しは、
    // no-opに限り全表示対象として読み続ける。外部操作の対象は補わない。
    targetCommentNumbers = item.recommendation.targets.map(
      (target) => target.commentNumber,
    );
  } else {
    throw new ReviewInputError(
      `投稿 ${item.id} の外部操作 ${operationId} に対象コメント番号がありません。`,
    );
  }
  if (new Set(targetCommentNumbers).size !== targetCommentNumbers.length) {
    throw new ReviewInputError(
      `投稿 ${item.id} の操作 ${operationId} の対象コメント番号が重複しています。`,
    );
  }
  const allowedTargets = new Set(
    item.recommendation.targets.map((target) => target.commentNumber),
  );
  for (const commentNumber of targetCommentNumbers) {
    if (!allowedTargets.has(commentNumber)) {
      throw new ReviewInputError(
        `投稿 ${item.id} の操作 ${operationId} の対象 ${commentNumber} は処理単位にありません。`,
      );
    }
  }
  if (
    SINGLE_ANCHOR_OPERATION_TYPES.has(operationType) &&
    targetCommentNumbers.length !== 1
  ) {
    throw new ReviewInputError(
      `投稿 ${item.id} の処理単位全体の操作 ${operationId} は明示anchor対象を1件だけ指定してください。`,
    );
  }
  let messageIds;
  if (Array.isArray(candidate.messageIds)) {
    messageIds = candidate.messageIds.map((messageId) =>
      inputText(messageId, `投稿 ${item.id} の操作 ${operationId} のメッセージID`, {
        max: 300,
      }),
    );
  } else if (operationType === "no_external_action") {
    // 旧保存データのno-opだけは本文送信なしとして読める。
    messageIds = [];
  } else {
    throw new ReviewInputError(
      `投稿 ${item.id} の外部操作 ${operationId} にメッセージ対応がありません。新しい一覧で確認してください。`,
    );
  }
  if (messageIds.length > 1 || new Set(messageIds).size !== messageIds.length) {
    throw new ReviewInputError(
      `投稿 ${item.id} の操作 ${operationId} のメッセージIDは重複なく0件または1件で指定してください。`,
    );
  }
  const allowedMessageIds = new Set(
    item.recommendation.messages.map((message) => message.messageId),
  );
  for (const messageId of messageIds) {
    if (!allowedMessageIds.has(messageId)) {
      throw new ReviewInputError(
        `投稿 ${item.id} の操作 ${operationId} が表示されていないメッセージを参照しています。`,
      );
    }
  }
  if (MESSAGE_REQUIRED_OPERATION_TYPES.has(operationType) && messageIds.length !== 1) {
    throw new ReviewInputError(
      `投稿 ${item.id} の操作 ${operationId} は送信するメッセージを1件指定してください。`,
    );
  }
  if (!MESSAGE_ALLOWED_OPERATION_TYPES.has(operationType) && messageIds.length > 0) {
    throw new ReviewInputError(
      `投稿 ${item.id} の操作 ${operationId} の種別ではメッセージを送信できません。`,
    );
  }
  return {
    operationId,
    operationType,
    operationTypeLabel: RESOLVED_PLAN_OPERATION_LABELS[operationType],
    targetCommentNumbers,
    messageIds,
  };
}

export function recommendedResolvedPlan(item) {
  const candidateById = new Map(
    item.recommendation.operationCandidates.map((candidate) => [candidate.operationId, candidate]),
  );
  const operations = item.recommendation.operationIds.map((operationId) => {
    const candidate = candidateById.get(operationId);
    return resolvedOperationForCandidate(item, candidate, operationId);
  });
  // 追加候補にだけ束縛した本文は、推奨案では送らない。本文の束縛先は一意で、
  // 束縛先のない本文はこの時点で存在しないため、落としても別操作が横取りせず、
  // 送るつもりの本文が黙って消えることもない。
  const selectedMessageIds = new Set(
    operations.flatMap((operation) => operation.messageIds),
  );
  return resolvedPlanFor(
    item,
    item.recommendation.targets.map((target) => ({ ...target })),
    operations,
    item.recommendation.messages
      .filter((message) => selectedMessageIds.has(message.messageId))
      .map((message) => ({ ...message })),
  );
}

function normalizeMessageChanges(item, rawChanges) {
  const changes = inputArray(rawChanges, `投稿 ${item.id} のメッセージ変更`, {
    max: item.recommendation.messages.length,
  });
  const allowed = new Map(
    item.recommendation.messages.map((message) => [message.messageId, message]),
  );
  const seen = new Set();
  return changes.map((rawChange) => {
    if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) {
      throw new ReviewInputError(`投稿 ${item.id} のメッセージ変更が正しくありません。`);
    }
    const messageId = inputText(rawChange.messageId, `投稿 ${item.id} のメッセージID`, {
      max: 300,
    });
    if (!allowed.has(messageId)) {
      throw new ReviewInputError(
        `投稿 ${item.id} のメッセージ ${messageId} はこの処理単位に表示されていません。`,
      );
    }
    if (seen.has(messageId)) {
      throw new ReviewInputError(`投稿 ${item.id} のメッセージ ${messageId} の扱いが重複しています。`);
    }
    seen.add(messageId);
    if (!new Set(["keep", "replace", "omit"]).has(rawChange.action)) {
      throw new ReviewInputError(
        `投稿 ${item.id} のメッセージ ${messageId} は維持・置換・送信しないのいずれかを選んでください。`,
      );
    }
    if (rawChange.action !== "replace" && rawChange.replacement !== undefined) {
      throw new ReviewInputError(
        `投稿 ${item.id} のメッセージ ${messageId} の置換文は「置換」の場合だけ指定できます。`,
      );
    }
    let replacement;
    if (rawChange.action === "replace") {
      if (!rawChange.replacement || typeof rawChange.replacement !== "object") {
        throw new ReviewInputError(`投稿 ${item.id} のメッセージ ${messageId} の置換文を指定してください。`);
      }
      replacement = {
        label: inputText(
          rawChange.replacement.label,
          `投稿 ${item.id} のメッセージ ${messageId} のラベル`,
          { max: 300 },
        ),
        text: inputText(
          rawChange.replacement.text,
          `投稿 ${item.id} のメッセージ ${messageId} の全文`,
        ),
        // 代替本文は任意である。書き換えの有無にかかわらず、指定が無ければ持たない。
        ...(rawChange.replacement.alreadyDeletedText === undefined
          ? {}
          : {
              alreadyDeletedText: inputText(
                rawChange.replacement.alreadyDeletedText,
                `投稿 ${item.id} のメッセージ ${messageId} の削除済み時の全文`,
              ),
            }),
      };
    }
    return { messageId, action: rawChange.action, replacement };
  });
}

/**
 * この処理単位で処置対象に選べるコメント。提案された処置対象候補を先に置き、
 * 続けてコメントツリーの表示順で残りを並べる。順序は完全案とトークンの一部なので、
 * 選択の入力順では変わらないようにここで固定する。
 */
function selectableTargetsFor(item) {
  const targets = item.recommendation.targets.map((target) => ({ ...target }));
  const seen = new Set(targets.map((target) => target.commentNumber));
  for (const comment of item.comments || []) {
    if (seen.has(comment.commentNumber)) continue;
    // 状態欄を読めなかった文脈コメントは処置対象に選べない。承認時状態が空のまま
    // 完全案へ入ると、実行直前照合が期待状態を持てず、管理者が承認した後になって
    // 承認の破損として止まる。選べないことを承認前に示すほうが安全側になる。
    if (!comment.currentState || !comment.url) continue;
    seen.add(comment.commentNumber);
    targets.push({
      commentNumber: comment.commentNumber,
      currentState: comment.currentState,
      url: comment.url,
    });
  }
  return targets;
}

/**
 * 操作ごとの対象絞り込みを読む。同じコメントを削除する操作と通報を閉じる操作で
 * 対象が分かれる場合、単一の対象選択では「削除はしないが通報は閉じる」を表せない。
 * 絞り込みは選択済み対象の部分集合に限るため、操作の追加も対象の追加も起こらない。
 */
function normalizeOperationTargets(item, rawOperationTargets, selectedOperationIdSet, selectedTargetNumberSet, maxTargets) {
  const narrowedByOperationId = new Map();
  if (rawOperationTargets === undefined || rawOperationTargets === null) return narrowedByOperationId;
  const entries = inputArray(rawOperationTargets, `投稿 ${item.id} の操作別対象`, {
    max: item.recommendation.operationCandidates.length,
  });
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ReviewInputError(`投稿 ${item.id} の操作別対象が正しくありません。`);
    }
    const operationId = inputText(entry.operationId, `投稿 ${item.id} の操作ID`, { max: 300 });
    if (!selectedOperationIdSet.has(operationId)) {
      throw new ReviewInputError(
        `投稿 ${item.id} の操作 ${operationId} は選択されていません。実行する操作を選び直してください。`,
      );
    }
    if (narrowedByOperationId.has(operationId)) {
      throw new ReviewInputError(`投稿 ${item.id} の操作 ${operationId} の対象指定が重複しています。`);
    }
    const commentNumbers = inputArray(
      entry.targetCommentNumbers,
      `投稿 ${item.id} の操作 ${operationId} の対象`,
      { min: 1, max: maxTargets },
    ).map((value) => cleanCommentNumber(value, `投稿 ${item.id} の操作 ${operationId} の対象番号`));
    if (new Set(commentNumbers).size !== commentNumbers.length) {
      throw new ReviewInputError(`投稿 ${item.id} の操作 ${operationId} の対象が重複しています。`);
    }
    for (const commentNumber of commentNumbers) {
      if (!selectedTargetNumberSet.has(commentNumber)) {
        throw new ReviewInputError(
          `投稿 ${item.id} の操作 ${operationId} の対象 ${commentNumber} は選択済み対象にありません。対象と操作を選び直してください。`,
        );
      }
    }
    narrowedByOperationId.set(operationId, new Set(commentNumbers));
  }
  return narrowedByOperationId;
}

/**
 * 表示済みスナップショットへ構造化変更だけを適用する。現在状態と通報IDは
 * クライアント入力から受け取らず、保存済みの値を常に完全案へ戻す。
 */
export function resolveAlternativePlan(item, rawChanges) {
  if (!rawChanges || typeof rawChanges !== "object" || Array.isArray(rawChanges)) {
    throw new ReviewInputError(`投稿 ${item.id} の構造化変更を指定してください。`);
  }
  // 処置できる対象は、提案された処置対象候補と、同じ処理単位で表示したコメントツリー
  // 全体とする。ツリーに出ている以上どれも対処の検討対象であり、提案に無いという
  // 理由だけで選べないと、一覧が管理者の判断を表せない。現在状態はどちらも
  // サーバーが解決した値をそのまま完全案へ戻す。
  const selectableTargets = selectableTargetsFor(item);
  const targetNumbers = inputArray(
    rawChanges.selectedTargetCommentNumbers,
    `投稿 ${item.id} の対象選択`,
    { min: 1, max: selectableTargets.length },
  ).map((value) => cleanCommentNumber(value, `投稿 ${item.id} の対象番号`));
  if (new Set(targetNumbers).size !== targetNumbers.length) {
    throw new ReviewInputError(`投稿 ${item.id} の対象選択が重複しています。`);
  }
  const targetByNumber = new Map(
    selectableTargets.map((target) => [target.commentNumber, target]),
  );
  for (const commentNumber of targetNumbers) {
    if (!targetByNumber.has(commentNumber)) {
      throw new ReviewInputError(
        `投稿 ${item.id} の対象 ${commentNumber} はこの処理単位に表示されていません。新しい一覧で確認してください。`,
      );
    }
  }
  // 対象は入力順に意味を持たないため、表示順へ正規化してトークンを安定させる。
  const selectedTargets = selectableTargets.filter((target) =>
    targetNumbers.includes(target.commentNumber),
  );

  const requestedOperationIds = inputArray(
    rawChanges.selectedOperationIds,
    `投稿 ${item.id} の操作選択`,
    { min: 1, max: item.recommendation.operationCandidates.length },
  ).map((value) => inputText(value, `投稿 ${item.id} の操作ID`, { max: 300 }));
  if (new Set(requestedOperationIds).size !== requestedOperationIds.length) {
    throw new ReviewInputError(`投稿 ${item.id} の操作選択が重複しています。`);
  }
  const candidateById = new Map(
    item.recommendation.operationCandidates.map((candidate) => [candidate.operationId, candidate]),
  );
  for (const operationId of requestedOperationIds) {
    if (!candidateById.has(operationId)) {
      throw new ReviewInputError(
        `投稿 ${item.id} の操作 ${operationId} はこの処理単位に表示されていません。別単位への波及は新しい一覧で確認してください。`,
      );
    }
  }
  // 実行順は候補の宣言順とする。選択の入力順で完全案とトークンを変えない。
  const requestedOperationIdSet = new Set(requestedOperationIds);
  const operationIds = item.recommendation.operationCandidates
    .map((candidate) => candidate.operationId)
    .filter((operationId) => requestedOperationIdSet.has(operationId));
  const selectedTargetNumberSet = new Set(
    selectedTargets.map((target) => target.commentNumber),
  );
  const chosenTargetsByOperationId = normalizeOperationTargets(
    item,
    rawChanges.operationTargets,
    requestedOperationIdSet,
    selectedTargetNumberSet,
    selectableTargets.length,
  );
  let operationTargetsChanged = false;
  const selectedOperations = operationIds.map((operationId) => {
    const candidate = candidateById.get(operationId);
    if (candidate.highImpact && !candidate.selectedByDefault) {
      throw new ReviewInputError(
        `投稿 ${item.id} の操作 ${operationId} は新しい高影響措置です。新しい一覧で確認してください。`,
      );
    }
    const operation = resolvedOperationForCandidate(item, candidate, operationId);
    const declaredTargets = operation.targetCommentNumbers.filter((commentNumber) =>
      selectedTargetNumberSet.has(commentNumber),
    );
    // 操作ごとの対象は選択済み対象の部分集合に限る。コメント行で選ぶ操作だけは、
    // 行の選択そのものを対象とし、宣言対象は既定値として扱う。それ以外の操作は
    // 宣言対象の狭めだけを受け付け、宣言していない対象へ広げられない。
    const chosen = chosenTargetsByOperationId.get(operationId);
    let targetCommentNumbers = declaredTargets;
    if (chosen && COMMENT_SCOPED_OPERATION_TYPES.has(operation.operationType)) {
      targetCommentNumbers = selectedTargets
        .map((target) => target.commentNumber)
        .filter((commentNumber) => chosen.has(commentNumber));
    } else if (chosen) {
      targetCommentNumbers = declaredTargets.filter((commentNumber) => chosen.has(commentNumber));
    }
    if (targetCommentNumbers.length === 0) {
      throw new ReviewInputError(
        `投稿 ${item.id} の操作 ${operationId} には選択済み対象がありません。対象と操作を選び直してください。`,
      );
    }
    if (!sameArray(targetCommentNumbers, declaredTargets)) operationTargetsChanged = true;
    return { ...operation, targetCommentNumbers };
  });

  const messageChanges = normalizeMessageChanges(item, rawChanges.messageChanges || []);
  const targetChanged =
    selectedTargets.length !== item.recommendation.targets.length ||
    selectedTargets.some(
      (target, index) => target.commentNumber !== item.recommendation.targets[index].commentNumber,
    );
  const operationChanged = !sameArray(operationIds, item.recommendation.operationIds);

  const changeByMessageId = new Map(
    messageChanges.map((change) => [change.messageId, change]),
  );
  const resolvedMessages = [];
  for (const message of item.recommendation.messages) {
    const change = changeByMessageId.get(message.messageId);
    if (!change || change.action === "keep") {
      resolvedMessages.push({ ...message });
    } else if (change.action === "replace") {
      // 代替本文を持たない置換は、その本文を書き換えていないだけである。承認済みの
      // 代替本文を落とすと、対象が先に削除済みだった場合に通常の本文が送られる。
      resolvedMessages.push({
        messageId: message.messageId,
        ...(message.alreadyDeletedText === undefined
          ? {}
          : { alreadyDeletedText: message.alreadyDeletedText }),
        ...change.replacement,
      });
    }
  }

  // 推奨案との比較基準も、推奨する操作へ束縛された本文だけにそろえる。全本文と
  // 比べると、追加候補の本文を送らないだけで「変更あり」に見え、推奨案のままの
  // 代替案を止められなくなる。
  const recommendedMessageIds = new Set(
    item.recommendation.operationIds.flatMap(
      (operationId) => candidateById.get(operationId).messageIds,
    ),
  );
  const baselineMessages = item.recommendation.messages.filter((message) =>
    recommendedMessageIds.has(message.messageId),
  );
  const messageChanged =
    resolvedMessages.length !== baselineMessages.length ||
    resolvedMessages.some(
      (message, index) =>
        message.messageId !== baselineMessages[index]?.messageId ||
        message.label !== baselineMessages[index]?.label ||
        message.text !== baselineMessages[index]?.text ||
        message.alreadyDeletedText !== baselineMessages[index]?.alreadyDeletedText,
    );
  if (!targetChanged && !operationChanged && !operationTargetsChanged && !messageChanged) {
    throw new ReviewInputError(
      `投稿 ${item.id} の補足理由だけでは実行許可を作れません。推奨案のまま実行する場合は推奨案を承認してください。`,
    );
  }

  const resolvedPlan = resolvedPlanFor(
    item,
    selectedTargets.map((target) => ({ ...target })),
    selectedOperations,
    resolvedMessages,
  );
  assertNoSensitiveData(resolvedPlan, `投稿 ${item.id} の解決済み案`);
  return resolvedPlan;
}

export function createResolvedPlanToken({ batchId, snapshotToken, resolvedPlan }) {
  return createHash("sha256")
    .update(JSON.stringify({ batchId, snapshotToken, itemId: resolvedPlan.itemId, resolvedPlan }))
    .digest("hex");
}
