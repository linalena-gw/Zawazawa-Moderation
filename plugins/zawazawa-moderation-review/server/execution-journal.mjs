/**
 * ExecutionJournal。
 *
 * 承認済み原子操作ごとに1レコードを持ち、外部送信境界をまたいだかどうかを記録する。
 * 目的は一つで、結果不明かもしれない操作を「未送信」として自動再実行しないことである。
 * 送信せずに確定した操作も同じく一度だけ結果を持ち、そこから送信を開き直せない。
 *
 * 記録は`temporary file → rename`の置換で更新する。敵対的な改ざん、複数プロセス間の
 * 同時実行競合、電源断に対する完全な永続性は扱わない。同一プロセス内の同時実行だけは
 * 軽量なロックで防ぐ。レコードごとの`fsync`は行わない。
 *
 * この記録は実行許可ではなく、ZAWAZAWAの現在状態の正本でもない。ジャーナルの存在、欠落、
 * 削除、`ready`はいずれも実行許可を作らない。示すのは、このワークフローが最後に何を試し、
 * その結果を確定できたかだけである。管理画面と食い違う場合は差分を報告して停止し、
 * ジャーナルの値で管理画面の現在状態を上書きしない。掃除後に記録が見つからないことも、
 * 未実行や実行許可の証拠にならない。
 *
 * 保存先は承認ストアと同じ`ZAWAZAWA_REVIEW_STORE_DIR`配下の`execution-journal/`とし、
 * レビュー本体`*.review.json`・承認`*.submission.json`とはファイルもAPIも分離する。
 * ジャーナルの更新が承認を書き換えないためで、別ホストは同じ`batchId`で両者をそれぞれ取る。
 *
 * 外部送信境界:
 * ・`dispatching`の保存が完了した後にだけ送信する。保存できなければ送信しない。これにより
 *   通常のプロセス停止や例外で、送信後の操作が「未送信」として扱われることはない。
 * ・`dispatching`、`confirmed`、`unknown`になった操作は同じ承認では二度と開き直せない。
 *   結果照合専用APIだけはunknownからconfirmedへ進め、以前の状態と時刻を履歴へ残す。
 *   v2の旧記録は識別子と最後の観測をそのまま引き継ぎ、欠けた過去の時刻を作らない。
 *   `dispatching`のままプロセスが終了した場合も`unknown`と同じ扱いにする。「送信前に落ちた
 *   可能性」があっても、重複操作の防止を優先する。
 * ・送信を開始した後は、`confirmed`を証明できない限り`unknown`へ倒す。応答が効果の不在を
 *   示していても、同じ承認での自動再送を許す根拠にしない。
 * ・`no_action_needed`も結果を確定した終端とし、同じ記録の繰り返しだけを通す。送信を開始した
 *   操作をこの状態へ言い換えることも、この状態から送信を開き直すこともできない。
 * ・送信前の実行直前照合や送信準備で失敗した場合だけは、外部送信を開始していないため記録を
 *   残さず再試行できる。やり直しにはライブ状態の確認と新しい`submissionId`が要る。
 *
 * `createOperationId`は`batchId`、`submissionId`、処理単位ID、`resolvedPlanToken`、0始まりの
 * 操作番号をハッシュし、ホストをまたいで安定した決定的なIDを作る。同じ承認の同じ原子操作は
 * 何度呼んでも同じIDになり、送信済みかもしれない操作を別の操作として作り直せない。
 * `submissionId`が入るため、同じ完全案を承認し直した場合は新しい実行として区別できる。
 * 値はサーバーが承認ストアの保存済み判断から導き、呼び出し側は`submissionId`と
 * `resolvedPlanToken`を申告できない。
 *
 * 記録できるのは、構造識別子（`batchId`、`submissionId`、処理単位ID、`operationId`、操作番号）、
 * 対象（コメント番号、操作種別）、記録（状態、更新時刻とその履歴）だけである。通報者向け任意メッセージは
 * `report_complete`へ束縛して独立した操作にせず、`source_block`と`source_unblock`は接続元を
 * 基準にする操作があったことだけを示してその値を保存しない。コメント本文、通報理由、投稿者情報、
 * 通報者情報、接続元情報、自由文の証拠は保存しない。
 *
 * 確定名の壊れたJSON、許可外の値、未知のファイルは未試行や成功へ倒さず`journal_corrupt`として
 * 停止する。記録の欠落を「まだ送っていない」と読み違えないためである。置換途中の`.tmp`と、
 * OSがフォルダ閲覧時に作る付随ファイル（`.DS_Store`、`._`で始まる名前、`Thumbs.db`、
 * `desktop.ini`）は判定に使う記録ではないため読み飛ばす。これで停止すると、保存先を開いた
 * だけで開始済み操作の結果を記録できなくなる。
 *
 * 掃除は最新レコードのファイル時刻から既定30日でバッチ単位に行い、記録と明示的な`prune`の
 * 際に期限を確認する。不明なファイルがあるバッチは自動掃除せず、通常の取得で破損として停止
 * できるよう保持する。承認の有効期限とは独立しており、ジャーナルが残っていても期限切れの承認は
 * 復活しない。
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  hasEnteredDispatch,
  isExecutionStatus,
  isOperationType,
  isSettledWithoutDispatch,
  permitsFollowingOperation,
} from "./execution-lifecycle.mjs";
import { defaultReviewStoreDirectory } from "./platform-paths.mjs";
import { NUMBER } from "./identifiers.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OPERATION_ID_PATTERN = /^op_[0-9a-f]{64}$/u;
const RESOLVED_PLAN_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
export const EXECUTION_ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const RECORD_KEYS = Object.freeze([
  "version",
  "operationId",
  "batchId",
  "submissionId",
  "itemId",
  "operationIndex",
  "operationType",
  "targetCommentNumber",
  "status",
  "updatedAt",
]);
const HISTORY_KEY = "history";
/** 同じ操作の再保存で変えられない項目。ここが変わる保存は別の操作の記録である。 */
const IDENTITY_KEYS = Object.freeze([
  "batchId",
  "submissionId",
  "itemId",
  "operationIndex",
  "operationType",
  "targetCommentNumber",
]);

export class ExecutionJournalInputError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ExecutionJournalInputError";
    this.code = "journal_input_invalid";
  }
}

export class ExecutionJournalConflictError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ExecutionJournalConflictError";
    this.code = "journal_conflict";
  }
}

export class ExecutionJournalIntegrityError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ExecutionJournalIntegrityError";
    this.code = "journal_corrupt";
  }
}

function assertBatchId(batchId) {
  if (typeof batchId !== "string" || !UUID_PATTERN.test(batchId)) {
    throw new ExecutionJournalInputError("対象のレビュー一覧が見つかりません。");
  }
}

function assertSubmissionId(submissionId) {
  if (typeof submissionId !== "string" || !UUID_PATTERN.test(submissionId)) {
    throw new ExecutionJournalInputError("承認送信IDの形式が正しくありません。");
  }
}

function assertItemId(itemId) {
  if (typeof itemId !== "string" || !EXECUTION_ITEM_ID_PATTERN.test(itemId)) {
    throw new ExecutionJournalInputError("処理単位IDの形式が正しくありません。");
  }
}

function assertOperationIndex(operationIndex) {
  if (
    !Number.isSafeInteger(operationIndex) ||
    operationIndex < 0 ||
    operationIndex > 9999
  ) {
    throw new ExecutionJournalInputError("操作番号の形式が正しくありません。");
  }
}

/**
 * 同じ承認の同じ原子操作へ、常に同じ操作IDを与える。呼び出しごとに新しいIDを発行すると、
 * 送信済みかもしれない操作が別の操作として再実行できてしまう。
 *
 * `submissionId`が入るため、同じ完全案を承認し直した場合は新しい実行として区別できる。
 */
export function createOperationId({
  batchId,
  submissionId,
  itemId,
  resolvedPlanToken,
  operationIndex,
}) {
  assertBatchId(batchId);
  assertSubmissionId(submissionId);
  assertItemId(itemId);
  assertOperationIndex(operationIndex);
  if (
    typeof resolvedPlanToken !== "string" ||
    !RESOLVED_PLAN_TOKEN_PATTERN.test(resolvedPlanToken)
  ) {
    throw new ExecutionJournalInputError("完全案トークンの形式が正しくありません。");
  }
  const canonical = JSON.stringify([
    batchId,
    submissionId,
    itemId,
    resolvedPlanToken,
    operationIndex,
  ]);
  return `op_${createHash("sha256").update(canonical).digest("hex")}`;
}

export function defaultExecutionJournalDirectory() {
  return join(defaultReviewStoreDirectory(), "execution-journal");
}

function normalizeSaveInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ExecutionJournalInputError("実行ジャーナルの入力形式が正しくありません。");
  }
  const operationId = createOperationId(input);
  if (!isOperationType(input.operationType)) {
    throw new ExecutionJournalInputError("操作種別の形式が正しくありません。");
  }
  if (
    typeof input.targetCommentNumber !== "string" ||
    !NUMBER.test(input.targetCommentNumber)
  ) {
    throw new ExecutionJournalInputError("対象コメント番号の形式が正しくありません。");
  }
  if (!isExecutionStatus(input.status)) {
    throw new ExecutionJournalInputError("実行状態の形式が正しくありません。");
  }
  return {
    operationId,
    batchId: input.batchId,
    submissionId: input.submissionId,
    itemId: input.itemId,
    operationIndex: input.operationIndex,
    operationType: input.operationType,
    targetCommentNumber: input.targetCommentNumber,
    status: input.status,
  };
}

function sameIdentity(left, right) {
  return IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

// FinderやエクスプローラがフォルダをのぞいたときにOSが作る付随ファイル。
// 判定に使う記録ではないので、これで実行ジャーナル全体を破損として止めない。
const OS_METADATA_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function isIgnorableEntry(entry) {
  return (
    entry.isFile() &&
    (OS_METADATA_FILES.has(entry.name) ||
      entry.name.startsWith("._") ||
      entry.name.endsWith(".tmp"))
  );
}

function directoryEntries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (cause) {
    if (cause.code === "ENOENT") return [];
    throw cause;
  }
}

export function createExecutionJournal(options = {}) {
  const directory = options.directory || defaultExecutionJournalDirectory();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now || (() => Date.now());
  // 同一サーバープロセス内で同じ操作を並行実行させないための軽量な排他。
  // 複数プロセス間の排他は扱わない。
  const runningOperations = new Set();

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new ExecutionJournalInputError("実行ジャーナルの有効期限が正しくありません。");
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new Error(
      `実行ジャーナルの保存先を作成できません: ${directory}。書き込みできる場所を ZAWAZAWA_REVIEW_STORE_DIR に指定してください。`,
      { cause },
    );
  }

  function batchDirectory(batchId) {
    assertBatchId(batchId);
    return join(directory, batchId);
  }

  function recordPath(batchId, operationId) {
    return join(batchDirectory(batchId), `${operationId}.json`);
  }

  function validateStoredRecord(record, batchId, operationId) {
    const keys = Object.keys(record);
    if (
      keys.length !== RECORD_KEYS.length + (record.version === 3 ? 1 : 0) ||
      RECORD_KEYS.some((key) => !keys.includes(key)) ||
      ![2, 3].includes(record.version) ||
      (record.version === 3 && !validHistory(record)) ||
      record.batchId !== batchId ||
      record.operationId !== operationId ||
      !UUID_PATTERN.test(record.submissionId || "") ||
      !EXECUTION_ITEM_ID_PATTERN.test(record.itemId || "") ||
      !Number.isSafeInteger(record.operationIndex) ||
      record.operationIndex < 0 ||
      record.operationIndex > 9999 ||
      !isOperationType(record.operationType) ||
      !NUMBER.test(record.targetCommentNumber || "") ||
      !isExecutionStatus(record.status) ||
      !Number.isFinite(Date.parse(record.updatedAt))
    ) {
      throw new ExecutionJournalIntegrityError(
        "実行ジャーナルの記録値が正しくありません。ライブ状態を確認して停止してください。",
      );
    }
    return record;
  }

  function validHistory(record) {
    const history = record.history;
    return Array.isArray(history) && history.length > 0 && history.length <= 8 &&
      history.every((event) => event && Object.keys(event).length === 2 &&
        isExecutionStatus(event.status) && Number.isFinite(Date.parse(event.updatedAt))) &&
      history.at(-1).status === record.status && history.at(-1).updatedAt === record.updatedAt;
  }

  function updatedRecord(input, existing) {
    const updatedAt = new Date(now()).toISOString();
    const history = existing?.history || (existing
      ? [{ status: existing.status, updatedAt: existing.updatedAt }] : []);
    // 同じ状態の反復保存は履歴を増やさない。
    if (existing?.status === input.status) return existing;
    return { version: 3, ...input, updatedAt,
      [HISTORY_KEY]: [...history, { status: input.status, updatedAt }] };
  }

  function readRecord(batchId, operationId) {
    let raw;
    try {
      raw = readFileSync(recordPath(batchId, operationId), "utf8");
    } catch (cause) {
      if (cause.code === "ENOENT") return null;
      throw cause;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      // JSON.parseの例外は入力断片を含み得るのでcauseへ保持しない。
      throw new ExecutionJournalIntegrityError(
        "実行ジャーナルに破損した記録があります。ライブ状態を確認して停止してください。",
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ExecutionJournalIntegrityError(
        "実行ジャーナルの記録形式が正しくありません。ライブ状態を確認して停止してください。",
      );
    }
    return validateStoredRecord(value, batchId, operationId);
  }

  function writeRecord(record) {
    const batchPath = batchDirectory(record.batchId);
    mkdirSync(batchPath, { recursive: true, mode: 0o700 });
    const finalPath = join(batchPath, `${record.operationId}.json`);
    const temporaryPath = `${finalPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, finalPath);
    return record;
  }

  /**
   * 状態を保存する。外部送信境界へ入った記録は、同じ承認では二度と開き直せない。
   * 一般化された遷移表は持たず、この一点だけを閉じる。
   */
  function save(rawInput) {
    const input = normalizeSaveInput(rawInput);
    const existing = readRecord(input.batchId, input.operationId);
    if (existing && !sameIdentity(existing, input)) {
      throw new ExecutionJournalConflictError(
        "同じ操作IDへ異なる対象または操作を記録できません。ライブ状態を確認し、承認を取り直してください。",
      );
    }
    if (hasEnteredDispatch(existing?.status)) {
      if (input.status !== "confirmed" && input.status !== "unknown") {
        throw new ExecutionJournalConflictError(
          "この操作はすでに外部送信を開始しています。自動再実行せず、管理画面で現在状態を読み戻してください。",
        );
      }
      if (existing.status !== "dispatching") {
        throw new ExecutionJournalConflictError(
          "この操作の結果はすでに記録されています。自動再実行せず、管理画面で現在状態を読み戻してください。",
        );
      }
    } else if (isSettledWithoutDispatch(existing?.status)) {
      // 送信せずに確定した操作は終端である。同じ記録の繰り返しだけを通し、送信を開く
      // 状態へは戻さない。実行し直す必要があれば、ライブ状態を確認して承認を取り直す。
      if (!isSettledWithoutDispatch(input.status)) {
        throw new ExecutionJournalConflictError(
          "この操作は送信せずに確定しています。自動で実行し直さず、管理画面で現在状態を読み戻してください。",
        );
      }
    } else if (input.status === "confirmed" || input.status === "unknown") {
      throw new ExecutionJournalInputError(
        "外部送信の開始を記録する前に操作結果を記録できません。",
      );
    }
    return writeRecord(updatedRecord(input, existing));
  }

  function batchRecords(batchId) {
    const batchPath = batchDirectory(batchId);
    const records = [];
    for (const entry of directoryEntries(batchPath)) {
      if (isIgnorableEntry(entry)) continue;
      const operationId = entry.name.endsWith(".json")
        ? entry.name.slice(0, -".json".length)
        : "";
      if (!entry.isFile() || !OPERATION_ID_PATTERN.test(operationId)) {
        throw new ExecutionJournalIntegrityError(
          "実行ジャーナルに未知の記録があります。ライブ状態を確認して停止してください。",
        );
      }
      const record = readRecord(batchId, operationId);
      if (record) records.push(record);
    }
    records.sort(
      (left, right) =>
        left.itemId.localeCompare(right.itemId) ||
        left.operationIndex - right.operationIndex ||
        left.operationId.localeCompare(right.operationId),
    );
    return records;
  }

  /**
   * 承認済み完全案の順序に照らし、この操作より前の全操作が成功確定しているかを返す。
   * 判定は保存済みレコードだけから行うため、同じ保存先を開き直した後も変わらない。
   */
  function operationOrder(key, orderedOperationIndexes) {
    if (!Array.isArray(orderedOperationIndexes)) {
      throw new ExecutionJournalInputError("承認済み操作の順序が正しくありません。");
    }
    const seen = new Set();
    for (const operationIndex of orderedOperationIndexes) {
      assertOperationIndex(operationIndex);
      if (seen.has(operationIndex)) {
        throw new ExecutionJournalInputError("承認済み操作の順序が正しくありません。");
      }
      seen.add(operationIndex);
    }
    const position = orderedOperationIndexes.indexOf(key.operationIndex);
    if (position < 0) {
      throw new ExecutionJournalInputError("操作番号が承認済み操作の順序にありません。");
    }
    for (const operationIndex of orderedOperationIndexes.slice(0, position)) {
      const record = readRecord(
        key.batchId,
        createOperationId({ ...key, operationIndex }),
      );
      if (!permitsFollowingOperation(record?.status)) {
        return { allowed: false, operationIndex, status: record?.status ?? null };
      }
    }
    return { allowed: true };
  }

  function sequenceLockId(key) {
    const operationId = createOperationId({ ...key, operationIndex: 0 });
    return `sequence_${operationId.slice("op_".length)}`;
  }

  async function runExclusive(lockId, handler) {
    if (
      typeof lockId !== "string" ||
      !/^(?:op|sequence)_[0-9a-f]{64}$/u.test(lockId)
    ) {
      throw new ExecutionJournalInputError("操作IDの形式が正しくありません。");
    }
    if (runningOperations.has(lockId)) {
      throw new ExecutionJournalConflictError(
        "この処理単位は同じサーバーで実行中です。完了を待ち、結果を確認してください。",
      );
    }
    runningOperations.add(lockId);
    try {
      return await handler();
    } finally {
      runningOperations.delete(lockId);
    }
  }

  /** 保持期間を過ぎたバッチを消す。破損した記録は消さず、取得時に停止できるよう残す。 */
  function prune() {
    let removedBatches = 0;
    for (const entry of directoryEntries(directory)) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      const batchPath = join(directory, entry.name);
      let latest = 0;
      let trusted = true;
      for (const file of directoryEntries(batchPath)) {
        if (!file.isFile()) {
          trusted = false;
          continue;
        }
        if (file.name.endsWith(".tmp")) continue;
        if (!file.name.endsWith(".json")) {
          if (!isIgnorableEntry(file)) trusted = false;
          continue;
        }
        try {
          latest = Math.max(latest, statSync(join(batchPath, file.name)).mtimeMs);
        } catch (cause) {
          if (cause.code !== "ENOENT") throw cause;
        }
      }
      if (!trusted) continue;
      try {
        if (now() - (latest || statSync(batchPath).mtimeMs) >= ttlMs) {
          rmSync(batchPath, { recursive: true, force: true });
          removedBatches += 1;
        }
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
      }
    }
    return { removedBatches };
  }

  return {
    directory,
    ttlMs,
    createOperationId,

    save(input) {
      prune();
      return save(input);
    },

    /** 結果照合専用。呼出元が保存済み操作に対する成功証拠を確認した場合だけ呼ぶ。 */
    reconcile(input) {
      const normalized = normalizeSaveInput({ ...input, status: "confirmed" });
      const existing = readRecord(normalized.batchId, normalized.operationId);
      if (!existing || !sameIdentity(existing, normalized) ||
          !["dispatching", "unknown"].includes(existing.status)) {
        throw new ExecutionJournalConflictError("結果不明の同一操作だけを照合で確定できます。");
      }
      // 中断したdispatchingも結果不明として履歴へ残してから確認を追記する。
      const uncertain = existing.status === "dispatching"
        ? updatedRecord({ ...normalized, status: "unknown" }, existing) : existing;
      return writeRecord(updatedRecord(normalized, uncertain));
    },

    /** 保存済みレコードを返す。記録が無い場合は`null`。 */
    getOperation(key) {
      const operationId = createOperationId(key);
      return readRecord(key.batchId, operationId);
    },

    // 取得は記録を消さない。保持期間の掃除は保存側だけで行い、読み取りだけの
    // 呼び出しが実行記録を削除しないようにする。
    getBatch(batchId) {
      assertBatchId(batchId);
      // ジャーナルは実行許可を評価せず、ライブ状態の正本にもならない。この性質は
      // 常に同じなので値としては返さず、ツール説明と文書が持つ。
      return { batchId, operations: batchRecords(batchId) };
    },

    operationOrder,

    /**
     * 同一プロセス内で同じ操作を並行実行させない。外部送信境界の内側を二重に
     * 走らせないための最小限の排他であり、複数プロセス間の排他は扱わない。
     */
    async runExclusive(operationId, handler) {
      return runExclusive(operationId, handler);
    },

    /** 同じ承認・同じ処理単位の順序検査から送信境界までを直列化する。 */
    async runExclusiveSequence(key, handler) {
      return runExclusive(sequenceLockId(key), handler);
    },

    prune,
  };
}
