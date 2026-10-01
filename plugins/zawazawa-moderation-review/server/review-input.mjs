/**
 * レビュー入力の正規化。
 *
 * モデルが書いた一覧入力を、表示と承認に使う保存済みスナップショットへ正規化する。
 * 自由文の表示禁止情報を落とし、操作候補と本文の対応を一意にし、一覧を作る時点で
 * 推奨案が完全案へ解決できることまで確かめる。保存と完全案の解決規則は持たない。
 */
import { createHash } from "node:crypto";
import { EXECUTION_ITEM_ID_PATTERN } from "./execution-journal.mjs";
import {
  assertNoSensitiveData,
  cleanCommentNumber,
  cleanReportId,
  cleanText,
  cleanTextArray,
  ReviewInputError,
} from "./input-text.mjs";
import {
  FALLBACK_MESSAGE_OPERATION_TYPES,
  MESSAGE_ALLOWED_OPERATION_TYPES,
  MESSAGE_REQUIRED_OPERATION_TYPES,
  recommendedResolvedPlan,
  REPORT_OPERATION_TYPES,
  RESOLVED_PLAN_OPERATION_LABELS,
  RESOLVED_PLAN_OPERATION_TYPE_SET,
  SINGLE_ANCHOR_OPERATION_TYPES,
} from "./resolved-plan.mjs";

// 一覧の各列が常に提示する措置。モデルの提案は既定値を決めるだけで、選択肢そのものは
// 処理単位のスナップショットから決まる。提案されなかった措置を選べないと、
// 管理者の判断を一覧で表せず、会話で別に承認を取ることになる。
const COLUMN_MEASURE_TYPES = Object.freeze([
  "comment_delete",
  "report_complete",
  "report_ignore",
  "author_auto_ignore",
  "source_block",
]);
const COLUMN_MEASURE_TYPE_SET = new Set(COLUMN_MEASURE_TYPES);

function normalizeOperations(
  recommendation,
  itemId,
  targetCommentNumbers,
  allowedMessageIds,
  reportedCommentNumbers = [],
  fallbackMessageIds = new Set(),
) {
  const seen = new Set();
  // 一つの本文を複数の操作候補が束縛すると、どの操作の送信文なのかが一意に
  // 決まらない。選択されない候補が本文を横取りし、代替案から黙って落ちる。
  const boundMessageIds = new Set();
  const allowedTargetCommentNumbers = new Set(targetCommentNumbers);
  const operationCandidates = [];
  const operationIds = [];

  function addCandidate(rawOperation, index, selectedByDefault) {
    if (!rawOperation || typeof rawOperation !== "object" || Array.isArray(rawOperation)) {
      throw new ReviewInputError(`投稿 ${itemId} の操作候補は種別と対象を持つ構造化データで指定してください。`);
    }
    const operationId = cleanText(
      rawOperation.operationId || rawOperation.id || `operation-${index + 1}`,
    );
    if (!operationId) {
      throw new ReviewInputError(`投稿 ${itemId} の操作候補に識別子がありません。`);
    }
    if (seen.has(operationId)) {
      throw new ReviewInputError(`投稿 ${itemId} の操作ID ${operationId} が重複しています。`);
    }
    const operationType = rawOperation.operationType || "no_external_action";
    if (!RESOLVED_PLAN_OPERATION_TYPE_SET.has(operationType)) {
      throw new ReviewInputError(`投稿 ${itemId} の操作候補に未対応の操作種別があります。`);
    }
    let operationTargetCommentNumbers;
    if (rawOperation.targetCommentNumbers !== undefined) {
      if (
        !Array.isArray(rawOperation.targetCommentNumbers) ||
        rawOperation.targetCommentNumbers.length === 0
      ) {
        throw new ReviewInputError(
          `投稿 ${itemId} の操作 ${operationId} に対象コメント番号を1件以上指定してください。`,
        );
      }
      operationTargetCommentNumbers = rawOperation.targetCommentNumbers.map((value) =>
        cleanCommentNumber(
          value,
          `投稿 ${itemId} の操作 ${operationId} の対象コメント番号`,
        ),
      );
    } else if (operationType === "no_external_action") {
      // 実行しない宣言だけは対象の明示を省ける。外部操作の対象は補わない。
      operationTargetCommentNumbers = [...targetCommentNumbers];
    } else {
      throw new ReviewInputError(
        `投稿 ${itemId} の外部操作 ${operationId} に対象コメント番号がありません。`,
      );
    }
    if (new Set(operationTargetCommentNumbers).size !== operationTargetCommentNumbers.length) {
      throw new ReviewInputError(
        `投稿 ${itemId} の操作 ${operationId} の対象コメント番号が重複しています。`,
      );
    }
    for (const targetCommentNumber of operationTargetCommentNumbers) {
      if (!allowedTargetCommentNumbers.has(targetCommentNumber)) {
        throw new ReviewInputError(
          `投稿 ${itemId} の操作 ${operationId} の対象 ${targetCommentNumber} は処理単位にありません。`,
        );
      }
    }
    if (
      SINGLE_ANCHOR_OPERATION_TYPES.has(operationType) &&
      operationTargetCommentNumbers.length !== 1
    ) {
      throw new ReviewInputError(
        `投稿 ${itemId} の処理単位全体の操作 ${operationId} は明示anchor対象を1件だけ指定してください。`,
      );
    }
    let messageIds;
    {
      if (!Array.isArray(rawOperation.messageIds) || rawOperation.messageIds.length > 1) {
        throw new ReviewInputError(
          `投稿 ${itemId} の操作 ${operationId} のメッセージIDは0件または1件で指定してください。`,
        );
      }
      messageIds = rawOperation.messageIds.map((messageId) => {
        if (typeof messageId !== "string") {
          throw new ReviewInputError(
            `投稿 ${itemId} の操作 ${operationId} のメッセージIDは文字列で指定してください。`,
          );
        }
        return cleanText(messageId);
      });
      if (messageIds.some((messageId) => !messageId)) {
        throw new ReviewInputError(
          `投稿 ${itemId} の操作 ${operationId} のメッセージIDが空です。`,
        );
      }
      if (new Set(messageIds).size !== messageIds.length) {
        throw new ReviewInputError(
          `投稿 ${itemId} の操作 ${operationId} のメッセージIDが重複しています。`,
        );
      }
      for (const messageId of messageIds) {
        if (!allowedMessageIds.has(messageId)) {
          throw new ReviewInputError(
            `投稿 ${itemId} の操作 ${operationId} が表示されていないメッセージを参照しています。`,
          );
        }
        if (boundMessageIds.has(messageId)) {
          throw new ReviewInputError(
            `投稿 ${itemId} のメッセージ ${messageId} を複数の操作候補が束縛しています。原子操作ごとに一意な本文を指定してください。`,
          );
        }
        // 送る場面の無い代替本文は、送るつもりで書いたのに送られない本文になる。
        if (
          fallbackMessageIds.has(messageId) &&
          !FALLBACK_MESSAGE_OPERATION_TYPES.has(operationType)
        ) {
          throw new ReviewInputError(
            `投稿 ${itemId} の操作 ${operationId} の種別では、削除済みだった場合の本文を送れません。`,
          );
        }
      }
    }
    if (
      MESSAGE_REQUIRED_OPERATION_TYPES.has(operationType) &&
      messageIds.length !== 1
    ) {
      throw new ReviewInputError(
        `投稿 ${itemId} の操作 ${operationId} は送信するメッセージを1件指定してください。`,
      );
    }
    if (
      !MESSAGE_ALLOWED_OPERATION_TYPES.has(operationType) &&
      messageIds.length !== 0
    ) {
      throw new ReviewInputError(
        `投稿 ${itemId} の操作 ${operationId} の種別ではメッセージを送信できません。`,
      );
    }
    seen.add(operationId);
    for (const messageId of messageIds) {
      boundMessageIds.add(messageId);
    }
    const candidate = {
      operationId,
      operationType,
      operationTypeLabel: RESOLVED_PLAN_OPERATION_LABELS[operationType],
      targetCommentNumbers: operationTargetCommentNumbers,
      messageIds,
      // 追加候補は明示的に通常影響とされたものだけを許す。指定漏れを
      // 「低影響」と推測すると、代替案から新しい高影響措置を作れてしまう。
      // 列として常に提示する措置だけは、提案の有無で選べる・選べないが変わらない。
      highImpact: COLUMN_MEASURE_TYPE_SET.has(operationType)
        ? false
        : selectedByDefault
          ? rawOperation.highImpact === true
          : rawOperation.highImpact !== false,
      selectedByDefault,
    };
    operationCandidates.push(candidate);
    if (selectedByDefault) {
      operationIds.push(operationId);
    }
  }

  (recommendation.operations || []).forEach((operation, index) => {
    addCandidate(operation, index, true);
  });
  (recommendation.operationCandidates || []).forEach((operation, index) => {
    addCandidate(operation, (recommendation.operations || []).length + index, false);
  });

  // 提案に無い列の措置を補う。各列が常に同じ選択肢を出せるようにするためで、
  // 補った候補は既定では選ばれない。実行順は提案済みの操作より後になる。
  const declaredTypes = new Set(operationCandidates.map((candidate) => candidate.operationType));
  const anchorCommentNumber = reportedCommentNumbers[0] || targetCommentNumbers[0];
  for (const operationType of COLUMN_MEASURE_TYPES) {
    if (declaredTypes.has(operationType)) continue;
    const scope = REPORT_OPERATION_TYPES.has(operationType)
      ? reportedCommentNumbers
      : SINGLE_ANCHOR_OPERATION_TYPES.has(operationType)
        ? [anchorCommentNumber]
        : targetCommentNumbers;
    if (!scope.length || !scope[0]) continue;
    let operationId = `unit-${operationType.replace(/_/gu, "-")}`;
    while (seen.has(operationId)) operationId = `${operationId}-x`;
    addCandidate(
      { operationId, operationType, targetCommentNumbers: [...scope], messageIds: [], highImpact: false },
      operationCandidates.length,
      false,
    );
  }
  // どの列も中立にした選択を「実行しない」として送れるようにする。
  if (!declaredTypes.has("no_external_action")) {
    let operationId = "unit-no-external-action";
    while (seen.has(operationId)) operationId = `${operationId}-x`;
    addCandidate(
      {
        operationId,
        operationType: "no_external_action",
        targetCommentNumbers: [...targetCommentNumbers],
        messageIds: [],
        highImpact: false,
      },
      operationCandidates.length,
      false,
    );
  }

  // 束縛先のない本文は、送るつもりで書いたのに送られない本文である。追加候補への
  // 束縛は認めるが、どの候補からも参照されない本文は一覧を作らずに止める。
  for (const messageId of allowedMessageIds) {
    if (!boundMessageIds.has(messageId)) {
      throw new ReviewInputError(
        `投稿 ${itemId} のメッセージ ${messageId} はどの操作候補からも参照されていません。送信する操作へ束縛するか、メッセージから外してください。`,
      );
    }
  }

  return { operationIds, operationCandidates };
}

function normalizeMessages(messages, itemId) {
  const seen = new Set();
  return (messages || []).map((message, index) => {
    const messageId = cleanText(message.messageId || `message-${index + 1}`);
    if (seen.has(messageId)) {
      throw new ReviewInputError(`投稿 ${itemId} のメッセージID ${messageId} が重複しています。`);
    }
    seen.add(messageId);
    return {
      messageId,
      label: cleanText(message.label),
      text: cleanText(message.text),
      // 対象が先に削除済みだった場合に代わりに送る本文。任意なので、指定が無い一覧では
      // 項目自体を持たせない。
      ...(message.alreadyDeletedText === undefined
        ? {}
        : { alreadyDeletedText: cleanText(message.alreadyDeletedText) }),
    };
  });
}

export function normalizeReviewInput(input) {
  const seen = new Set();
  const items = input.items.map((item) => {
    // モデルが書いた自由文だけを検査する。参照から解決した本文、通報理由、現在状態、
    // サーバーが組み立てた表題は判断材料そのものなので、値が禁止情報に見えても
    // 一覧を落とさない。
    assertNoSensitiveData(
      {
        basis: item.basis,
        messages: item.recommendation?.messages,
      },
      `投稿 ${item.id} の記述`,
    );
    const id = cleanText(item.id);
    if (!EXECUTION_ITEM_ID_PATTERN.test(id)) {
      throw new ReviewInputError(
        "処理単位IDは英数字、ハイフン、アンダースコアだけで1〜256文字にしてください。",
      );
    }
    if (seen.has(id)) {
      throw new ReviewInputError(`投稿ID ${id} が重複しています。`);
    }
    seen.add(id);

    const reports = (item.reports || []).map((report, reportIndex) => ({
      reportId: report.reportId
        ? cleanReportId(report.reportId, `投稿 ${id} の通報${reportIndex + 1}の通報ID`)
        : undefined,
      targetCommentNumber: report.targetCommentNumber
        ? cleanCommentNumber(
            report.targetCommentNumber,
            `投稿 ${id} の通報${reportIndex + 1}の対象コメント番号`,
          )
        : undefined,
      reason: cleanText(report.reason || ""),
      createdAt: report.createdAt ? cleanText(report.createdAt) : undefined,
      repeatAfterResponse: report.repeatAfterResponse === true,
    }));
    if (
      item.reportCount !== undefined &&
      (!Number.isSafeInteger(item.reportCount) || item.reportCount !== reports.length)
    ) {
      throw new ReviewInputError(
        `投稿 ${id} の通報件数と通報行が一致しません。管理画面を確認して一覧を作り直してください。`,
      );
    }
    // 読めた通報行がその単位の全部かどうか。管理画面の通報表が1ページに収まらない場合、
    // 参照解決はここを立てて読めた件数を全部として扱わせない。
    const reportsTruncated = item.reportsTruncated === true;
    // 総件数は打ち切られた単位でだけ持つ。読み切れた単位の総件数は通報行の数そのもので、
    // 打ち切られていても管理画面の件数表示を読めなければ分からない。
    if (
      item.reportTotalCount !== undefined &&
      (!Number.isSafeInteger(item.reportTotalCount) ||
        !reportsTruncated ||
        item.reportTotalCount <= reports.length)
    ) {
      throw new ReviewInputError(
        `投稿 ${id} の通報の総件数が通報行と一致しません。管理画面を確認して一覧を作り直してください。`,
      );
    }

    const targetNumbers = new Set();
    const targets = item.recommendation.targets.map((target) => {
      const commentNumber = cleanCommentNumber(
        target.commentNumber,
        `投稿 ${id} の対象候補コメント番号`,
      );
      if (targetNumbers.has(commentNumber)) {
        throw new ReviewInputError(`投稿 ${id} の対象候補 ${commentNumber} が重複しています。`);
      }
      targetNumbers.add(commentNumber);
      return {
        commentNumber,
        currentState: cleanText(target.currentState),
        url: target.url || undefined,
      };
    });
    const messages = normalizeMessages(item.recommendation.messages, id);
    // 通報の対象コメント。対象候補が一つだけの単位では、対象番号の無い通報も
    // その対象の通報として扱う。解決規則は完全案の作成と同じにする。
    const onlyTargetNumber = targets.length === 1 ? targets[0].commentNumber : null;
    const reportedCommentNumbers = targets
      .map((target) => target.commentNumber)
      .filter((commentNumber) =>
        reports.some((report) => (report.targetCommentNumber || onlyTargetNumber) === commentNumber),
      );
    const operationPlan = normalizeOperations(
      item.recommendation,
      id,
      targets.map((target) => target.commentNumber),
      new Set(messages.map((message) => message.messageId)),
      reportedCommentNumbers,
      new Set(
        messages
          .filter((message) => message.alreadyDeletedText !== undefined)
          .map((message) => message.messageId),
      ),
    );

    const normalizedItem = {
      id,
      // 表題は参照解決がトピック名と処置対象から組み立てる。モデルは書かない。
      title: cleanText(item.title || `投稿 ${id}`),
      reportCount: reports.length,
      reportsTruncated,
      ...(item.reportTotalCount === undefined
        ? {}
        : { reportTotalCount: item.reportTotalCount }),
      reports,
      // トピック番号と名前は参照解決が埋める行の出所。番号だけの行が並ぶと、別の
      // 掲示板から拾った文脈が自トピックの投稿と見分けられない。
      comments: (item.comments || []).map((comment) => ({
        commentNumber: cleanText(comment.commentNumber),
        topicNumber: comment.topicNumber ? cleanText(comment.topicNumber) : undefined,
        topicName: comment.topicName ? cleanText(comment.topicName) : undefined,
        body: cleanText(comment.body),
        displayName: comment.displayName ? cleanText(comment.displayName) : undefined,
        createdAt: comment.createdAt ? cleanText(comment.createdAt) : undefined,
        currentState: comment.currentState ? cleanText(comment.currentState) : undefined,
        parentCommentNumber: comment.parentCommentNumber
          ? cleanText(comment.parentCommentNumber)
          : undefined,
        url: comment.url || undefined,
      })),
      history: (item.history || []).map((comment) => ({
        commentNumber: cleanText(comment.commentNumber),
        topicNumber: comment.topicNumber ? cleanText(comment.topicNumber) : undefined,
        topicName: comment.topicName ? cleanText(comment.topicName) : undefined,
        body: cleanText(comment.body),
        displayName: comment.displayName ? cleanText(comment.displayName) : undefined,
        createdAt: comment.createdAt ? cleanText(comment.createdAt) : undefined,
        currentState: comment.currentState ? cleanText(comment.currentState) : undefined,
        url: comment.url || undefined,
      })),
      publicUrl: item.publicUrl || undefined,
      adminUrl: item.adminUrl || undefined,
      basis: cleanTextArray(item.basis),
      recommendation: {
        targets,
        operationIds: operationPlan.operationIds,
        operationCandidates: operationPlan.operationCandidates,
        messages,
      },
      dependencyGroup: item.dependencyGroup
        ? cleanText(item.dependencyGroup)
        : undefined,
    };
    // 推奨案も一覧作成時点で完全案へ解決できなければ表示しない。これにより
    // 通報ID欠落などを、管理者が承認した後まで持ち越さない。
    recommendedResolvedPlan(normalizedItem);
    return normalizedItem;
  });

  return {
    batchTitle: cleanText(input.batchTitle),
    items,
  };
}

export function createSnapshotToken(review) {
  return createHash("sha256").update(JSON.stringify(review)).digest("hex");
}
