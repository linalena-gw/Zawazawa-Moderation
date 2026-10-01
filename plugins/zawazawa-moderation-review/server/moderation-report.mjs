/**
 * 自律処理の結果報告。
 *
 * 保存済みの自律処理一覧、判断、実行ジャーナルを一つの読み取り専用HTMLへまとめ、実行先
 * リポジトリへ書き出す。スケジュール実行ではサーバープロセスが終わるとループバックの
 * 一覧URLが開けなくなるため、報告は後から単体で開けるファイルにする。
 *
 * 表示するのは保存済みの事実だけで、実行許可を作る値は載せない。承認は
 * `review-store.mjs`、実行状態は`execution-journal.mjs`が正本であり、ここでは
 * 二つの保存済み記録を突き合わせて並べるだけである。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESOLVED_PLAN_OPERATION_LABELS } from "./resolved-plan.mjs";
import { embedJson, injectBootstrap } from "./html-embed.mjs";

/** 実行先リポジトリのルート直下に置く報告の保存先。 */
export const REPORT_DIRECTORY_NAME = "moderation-reports";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export class ModerationReportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ModerationReportError";
    this.code = "report_write_failed";
  }
}

/**
 * 承認済み原子操作へ実行状態を重ねる。突き合わせの鍵は実行ツールが使うものと同じ
 * `itemId`と`operationIndex`にする。鍵が一致しても操作種別や対象が食い違う記録は
 * 状態を借りず、食い違い自体を報告へ出す。
 */
function stepsFor(unit, journalByKey) {
  return (unit.plan?.executionSteps || []).map((step) => {
    const record = journalByKey.get(`${unit.item.id}:${step.operationIndex}`);
    const mismatched = Boolean(
      record &&
        (record.operationType !== step.operationType ||
          record.targetCommentNumber !== step.targetCommentNumber),
    );
    return {
      operationIndex: step.operationIndex,
      operationType: step.operationType,
      operationTypeLabel: RESOLVED_PLAN_OPERATION_LABELS[step.operationType] || step.operationType,
      targetCommentNumber: step.targetCommentNumber,
      // 通報IDは承認境界の内部識別子なので、報告へは件数だけを出す。
      reportCount: (step.reportIds || []).length,
      messages: (step.messages || []).map((message) => ({
        label: message.label,
        text: message.text,
        // 承認時に確定した代替本文。どちらを送ったかは、同じ対象の削除操作の状態で分かる。
        ...(message.alreadyDeletedText === undefined
          ? {}
          : { alreadyDeletedText: message.alreadyDeletedText }),
      })),
      status: mismatched ? null : record?.status || null,
      journalMismatch: mismatched,
    };
  });
}

/**
 * 報告へ載せる処理単位の内容。通報の`reportId`は承認境界の内部識別子であり、
 * 判断には使わないので、保存されるファイルからは落とす。
 */
function reportedItem(item) {
  return {
    ...item,
    reports: (item.reports || []).map(({ reportId, ...report }) => report),
  };
}

function sectionFor(batch, journal) {
  const journalByKey = new Map(
    (journal?.operations || []).map((operation) => [
      `${operation.itemId}:${operation.operationIndex}`,
      operation,
    ]),
  );
  return {
    batchId: batch.batchId,
    batchTitle: batch.batchTitle,
    createdAt: batch.createdAt,
    submittedAt: batch.submittedAt,
    submitted: batch.submitted,
    authorizedBy: batch.authorizedBy,
    expiresAt: batch.expiresAt,
    expired: batch.expired,
    blockedDependencyGroups: batch.blockedDependencyGroups,
    units: batch.units.map((unit) => ({
      item: reportedItem(unit.item),
      choice: unit.choice,
      steps: stepsFor(unit, journalByKey),
    })),
  };
}

/**
 * 報告の内容を組み立てる。実行済みバッチの判断と実行状態を載せる。
 */
export function buildModerationReport({
  store,
  executionJournal,
  batchId,
  displayName,
  now = () => Date.now(),
}) {
  const executed = store.get(batchId, { scope: "report" });
  if (!executed.submitted) {
    throw new ModerationReportError(
      "このバッチにはまだ判断がありません。実行した結果のバッチIDを指定してください。",
    );
  }
  return {
    generatedAt: new Date(now()).toISOString(),
    displayName,
    executed: sectionFor(executed, executionJournal.getBatch(batchId)),
  };
}

/** 実行先リポジトリでの並びを日付順にするため、一覧の作成日（JST）を先頭に置く。 */
export function reportFileName({ batchId, createdAt }) {
  const created = Date.parse(createdAt);
  const day = Number.isFinite(created)
    ? new Date(created + JST_OFFSET_MS).toISOString().slice(0, 10)
    : "unknown-date";
  return `${day}-${batchId}.html`;
}

export function renderModerationReportHtml(uiHtml, report) {
  const html = injectBootstrap(
    uiHtml,
    `<script>window.__zawazawaReport = ${embedJson(report)};</script>`,
  );
  if (html === null) {
    throw new ModerationReportError("一覧UIへ結果報告を差し込めませんでした。");
  }
  return html;
}

/**
 * 報告を実行先リポジトリのルート直下へ書き出す。同じ一覧の報告は同じ名前へ上書きし、
 * 実行が進むたびに最新の状態へ更新できるようにする。
 */
export function writeModerationReport({ repositoryRoot, report, html }) {
  const directory = join(repositoryRoot, REPORT_DIRECTORY_NAME);
  const path = join(directory, reportFileName(report.executed));
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path, html, { mode: 0o600 });
  } catch (cause) {
    throw new ModerationReportError(
      `結果報告を${path}へ書き出せません。書き込みできる場所か管理者へ確認してください。`,
      { cause },
    );
  }
  return path;
}
