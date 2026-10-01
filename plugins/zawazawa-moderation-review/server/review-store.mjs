/**
 * 承認記録の保存。
 *
 * 一覧のスナップショットと、管理者が下した判断という事実だけをファイルへ保存する。
 * 実行許可、依存グループ停止、実行候補は読み込みのたびに導き、保存済み完全案は
 * 承認時のトークンへ突き合わせる。完全案の解決規則そのものはここには無い。
 *
 * 保存先はホストのプロセス外で、`ZAWAZAWA_REVIEW_STORE_DIR`で変更できる。リポジトリ内へは
 * 保存しない。これにより、一覧UIを描画できるホストで承認し、ブラウザ操作ができる別のホストで
 * 同じ`batchId`から承認を取得できる。
 *
 * ・レビュー本体と承認はそれぞれ書き込み一回きりとし、後から書き換えない。同じ一覧への送信が
 *   競合した場合、先に保存できた一つだけが残る。
 * ・有効期限は一覧を作った時点で記録へ焼き込む（`DEFAULT_TTL_MS`）。読む側の設定が作成時と
 *   異なっても判定が食い違わないためで、期限の解釈自体は`review-authorization.mjs`が持つ。
 * ・レビュー本体には作成時点の対象グループを記録する。承認ストアは実行先をまたいで共有され
 *   うるため、`batchId`だけで保存済み本文を読み書きする経路はこの値を束縛中の対象へ照合する。
 * ・承認記録は`submissionId`ごとに、判断、承認済み完全案、`resolvedPlanToken`、有効期限、
 *   実行許可の出所を持つ。出所は管理者の承認か、自律承認を認めた運用モードのいずれかで、
 *   実行する時点の設定から読み替えず記録の値をそのまま使う。導出値は保存しないため、保存済み
 *   ファイルへ書き足しても実行許可は増えない。
 * ・承認済み完全案は読み込みのたびにレビュー本体の識別子と保存済み案からトークンを作り直して
 *   照合する。案だけを書き換えても、実行する対象と操作は変えられない。
 *
 * 古い一覧は作成時と取得時に自動で掃除し、有効期限の倍を過ぎたレビュー本文は残さない。期限内の
 * 承認済み一覧は件数上限による掃除の対象外とする。実行ホストが取得する前に承認を消して、
 * 期限切れではなく「見つからない」となることを防ぐ。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  ADMINISTRATOR_AUTHORIZATION,
  applyExpiration,
  AUTONOMOUS_AUTHORIZATIONS,
  AUTONOMOUS_DECISION_CHOICES,
  authorizedByOf,
  REVIEW_AUTHORIZATION_SOURCES,
  deriveAuthorization,
  expiryOf,
  isDecisionChoice,
  isExpired as isRecordExpired,
  UNDECIDED_CHOICE,
} from "./review-authorization.mjs";
import {
  assertNoSensitiveData,
  inputArray,
  inputText,
  ReviewInputError,
} from "./input-text.mjs";
import { createSnapshotToken } from "./review-input.mjs";
import {
  createResolvedPlanToken,
  recommendedResolvedPlan,
  resolveAlternativePlan,
} from "./resolved-plan.mjs";
import { defaultReviewStoreDirectory } from "./platform-paths.mjs";

export { defaultReviewStoreDirectory } from "./platform-paths.mjs";

const MAX_BATCHES = 20;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * 保存済み承認の導出値が、同じ純粋関数で再計算した値と食い違う場合に使う。
 * 実行許可を保存値の側へ倒さず、破損として停止するための型である。
 */
export class ReviewStoreIntegrityError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ReviewStoreIntegrityError";
  }
}

// 承認はホストのプロセスをまたいで受け渡すため、ファイルへ保存する。
// レビュー本体と送信はどちらも書き込み一回きりで、後から書き換えない。
export function createReviewStore(options = {}) {
  const directory = options.directory || defaultReviewStoreDirectory();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now || (() => Date.now());

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new Error(
      `承認の保存先を作成できません: ${directory}。書き込みできる場所を ZAWAZAWA_REVIEW_STORE_DIR に指定してください。`,
      { cause },
    );
  }

  function pathFor(batchId, suffix) {
    if (!UUID_PATTERN.test(batchId)) {
      throw new ReviewInputError("対象のレビュー一覧が見つかりません。");
    }
    return join(directory, `${batchId}.${suffix}.json`);
  }

  function readJson(path) {
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch (cause) {
      if (cause.code === "ENOENT") return null;
      throw new Error("レビュー一覧を読み込めませんでした。再表示してください。", {
        cause,
      });
    }
    try {
      return JSON.parse(raw);
    } catch (cause) {
      throw new Error("レビュー一覧が壊れています。再表示してください。", { cause });
    }
  }

  // 一時ファイルへ書き切ってからlinkで確定させる。書き込み途中で落ちても、
  // 半端なJSONが本来の名前で残って読めなくなることがない。linkは既存名では
  // EEXISTになるので、二重送信の排除もそのまま成り立つ。
  function writeOnce(path, value) {
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const handle = openSync(temporary, "wx", 0o600);
    try {
      writeSync(handle, JSON.stringify(value));
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    try {
      linkSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  function isExpired(record) {
    return isRecordExpired(record, now());
  }

  // 完全案は送信内容そのものなので、実行許可の集合と同じく読み込みのたびに照合する。
  // 保存済みトークンを信用せず、レビュー本体の識別子と保存済み案から作り直して
  // 突き合わせる。案だけを書き換えても、実行する対象と操作は変えられない。
  function assertStoredPlansIntact(record, decisions) {
    for (const decision of decisions) {
      if (!decision?.resolvedPlan) continue;
      const expected = createResolvedPlanToken({
        batchId: record.batchId,
        snapshotToken: record.snapshotToken,
        resolvedPlan: decision.resolvedPlan,
      });
      if (decision.resolvedPlanToken !== expected) {
        throw new ReviewStoreIntegrityError(
          "保存済み承認の完全案が承認時の内容と一致しません。実行せず、一覧を再表示して承認を取り直してください。",
        );
      }
    }
  }

  /**
   * 保存済み承認を読み、実行許可と依存グループ停止を読み込みのたびに導出する。
   * 保存するのは管理者が下した判断という事実だけで、そこから導ける値は保存しない。
   * 承認済み完全案は承認時のトークンへ突き合わせる。
   */
  function verifiedSubmission(record, submission) {
    if (!submission) return null;
    const decisions = submission.decisions || [];
    assertStoredPlansIntact(record, decisions);
    // 記録の無い古い承認だけを人間の承認として読む。読めない値を既定へ寄せると、
    // 自律承認が人間の承認として実行できてしまう。
    if (
      submission.authorizedBy !== undefined &&
      !REVIEW_AUTHORIZATION_SOURCES.includes(submission.authorizedBy)
    ) {
      throw new ReviewStoreIntegrityError(
        "保存済み承認の実行許可の出所を読み取れません。実行せず、一覧を再表示して承認を取り直してください。",
      );
    }
    return {
      ...submission,
      ...deriveAuthorization(record.review?.items || [], decisions),
    };
  }

  function load(batchId) {
    const record = readJson(pathFor(batchId, "review"));
    if (!record) throw new ReviewInputError("対象のレビュー一覧が見つかりません。");
    return {
      ...record,
      submission: verifiedSubmission(record, readJson(pathFor(batchId, "submission"))),
    };
  }

  function remove(batchId) {
    rmSync(pathFor(batchId, "review"), { force: true });
    rmSync(pathFor(batchId, "submission"), { force: true });
  }

  // 期限切れは「見つからない」ではなく期限切れとして報告したいので、
  // 期限の倍の時間が過ぎるまで記録を残す。
  function prune() {
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    const submitted = new Set(
      entries
        .filter((name) => name.endsWith(".submission.json"))
        .map((name) => name.slice(0, -".submission.json".length)),
    );
    const records = [];
    for (const name of entries) {
      // 書き込み中に落ちた一時ファイルを片づける。書き込み中のものを消さない
      // よう、有効期限より古いものだけを対象にする。
      if (name.endsWith(".tmp")) {
        const path = join(directory, name);
        try {
          if (now() - statSync(path).mtimeMs >= ttlMs) rmSync(path, { force: true });
        } catch {
          // 別のプロセスが先に片づけた場合は何もしない。
        }
        continue;
      }
      if (!name.endsWith(".review.json")) continue;
      const batchId = name.slice(0, -".review.json".length);
      if (!UUID_PATTERN.test(batchId)) continue;
      // 壊れた記録は読み飛ばさず、日時なしとして掃除の対象に入れる。
      let record = null;
      try {
        record = readJson(join(directory, name));
      } catch {
        record = null;
      }
      records.push({
        batchId,
        createdAt: Date.parse(record?.createdAt) || 0,
        expiresAt: record ? expiryOf(record) : Number.NaN,
        hasSubmission: submitted.has(batchId),
      });
    }
    records.sort((left, right) => right.createdAt - left.createdAt);
    for (const [index, entry] of records.entries()) {
      if (now() - entry.createdAt >= ttlMs * 2) {
        remove(entry.batchId);
        continue;
      }
      if (index < MAX_BATCHES) continue;
      // 期限内の承認は件数上限では消さない。実行ホストが取りに来る前に消えると、
      // 期限切れではなく「見つからない」になり、承認そのものが失われる。
      if (entry.hasSubmission && now() < entry.expiresAt) continue;
      remove(entry.batchId);
    }
  }

  function commonBatch(batch) {
    // 期限の正本は、承認済みなら承認記録へ焼き込んだ`expiresAt`とする。承認したホストと
    // 実行するホストで一覧の保持設定が違っても、実行許可の判定が食い違わない。
    const deadlineRecord = batch.submission ?? batch;
    const expired = isExpired(deadlineRecord);
    const expiresAt = expiryOf(deadlineRecord);
    return {
      batchId: batch.batchId,
      expiresAt: Number.isFinite(expiresAt)
        ? new Date(expiresAt).toISOString()
        : null,
      expired,
    };
  }

  function summarySubmission(submission, expired) {
    if (!submission) return null;
    const effective = applyExpiration(submission, expired);
    return {
      authorizedBy: authorizedByOf(effective),
      approvedCount: effective.approvedItemIds.length,
      heldCount: effective.heldItemIds.length,
      alternativeCount: effective.alternativeItemIds.length,
      executableAuthorizedCount: effective.executableAuthorizedItemIds.length,
      blockedDependencyGroupCount: effective.blockedDependencyGroups.length,
    };
  }

  function summaryBatch(batch) {
    const common = commonBatch(batch);
    return {
      ...common,
      snapshotToken: batch.snapshotToken,
      itemCount: batch.review.items.length,
      submission: summarySubmission(batch.submission, common.expired),
    };
  }

  function snapshotBatch(batch) {
    const common = commonBatch(batch);
    return {
      ...common,
      snapshotToken: batch.snapshotToken,
      createdAt: batch.createdAt,
      items: batch.review.items.map((item) => {
        const resolvedPlan = recommendedResolvedPlan(item);
        return {
          ...item,
          recommendedResolvedPlan: resolvedPlan,
          recommendedResolvedPlanToken: createResolvedPlanToken({
            batchId: batch.batchId,
            snapshotToken: batch.snapshotToken,
            resolvedPlan,
          }),
        };
      }),
      submission: batch.submission
        ? applyExpiration(batch.submission, common.expired)
        : null,
    };
  }

  function executionSubmission(submission, expired) {
    if (!submission) return null;
    const effective = applyExpiration(submission, expired);
    return {
      submissionId: effective.submissionId,
      authorizedBy: authorizedByOf(effective),
      blockedDependencyGroups: effective.blockedDependencyGroups,
      executableAuthorizedItemIds: effective.executableAuthorizedItemIds,
      // 依存関係で停止した単位も含め、管理者が承認した完全案を失わない。
      // 実際の候補判定には上のexecutableAuthorizedItemIdsだけを使う。
      authorizedPlans: effective.decisions
        .filter((decision) => decision.resolvedPlan)
        .map((decision) => ({
          itemId: decision.itemId,
          resolvedPlan: decision.resolvedPlan,
          resolvedPlanToken: decision.resolvedPlanToken,
        })),
    };
  }

  function executionBatch(batch) {
    const common = commonBatch(batch);
    return {
      ...common,
      submission: executionSubmission(batch.submission, common.expired),
      dependencyGroups: [...new Set(batch.review.items.map((item) => item.dependencyGroup).filter(Boolean))]
        .map((group) => ({ group, itemIds: batch.review.items
          .filter((item) => item.dependencyGroup === group).map((item) => item.id) })),
    };
  }

  function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function decisionType(decision) {
    if (decision.choice === "approve") return "recommended_approved";
    if (decision.choice === "hold") return "held";
    const hasExternalOperation = (decision.resolvedPlan?.operations || []).some(
      (operation) => operation.operationType !== "no_external_action",
    );
    return hasExternalOperation ? "alternative" : "alternative_no_external_action";
  }

  function changedPlanFields(recommendedPlan, decision) {
    if (decision.choice === "approve") return [];
    if (decision.choice === "hold") return ["decision"];
    return ["targets", "operations", "messages"].filter(
      (field) => !sameValue(recommendedPlan[field], decision.resolvedPlan?.[field]),
    );
  }

  function decisionDiffUnits(batch) {
    if (!batch.submission) return [];
    const itemById = new Map(batch.review.items.map((item) => [item.id, item]));
    return batch.submission.decisions.map((decision) => {
      const item = itemById.get(decision.itemId);
      const recommendedPlan = recommendedResolvedPlan(item);
      const changedFields = changedPlanFields(recommendedPlan, decision);
      return {
        itemId: decision.itemId,
        decisionType: decisionType(decision),
        differsFromRecommendation: changedFields.length > 0,
        changedFields,
      };
    });
  }

  function decisionContext(item) {
    const commentContext = ({
      commentNumber,
      topicNumber,
      topicName,
      body,
      displayName,
      createdAt,
      currentState,
      parentCommentNumber,
    }) => ({
      commentNumber,
      ...(topicNumber ? { topicNumber } : {}),
      ...(topicName ? { topicName } : {}),
      body,
      ...(displayName ? { displayName } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(currentState ? { currentState } : {}),
      ...(parentCommentNumber ? { parentCommentNumber } : {}),
    });
    return {
      title: item.title,
      reports: item.reports.map(
        ({ targetCommentNumber, reason, createdAt, repeatAfterResponse }) => ({
          ...(targetCommentNumber ? { targetCommentNumber } : {}),
          reason,
          ...(createdAt ? { createdAt } : {}),
          repeatAfterResponse,
        }),
      ),
      comments: item.comments.map(commentContext),
      history: item.history.map(commentContext),
    };
  }

  function decisionDiffBatch(batch, itemId) {
    if (!batch.submission) {
      throw new ReviewInputError("未送信のレビュー一覧から判断差分は取得できません。");
    }
    const common = commonBatch(batch);
    const units = decisionDiffUnits(batch);
    const changedItemIds = units
      .filter((unit) => unit.differsFromRecommendation)
      .map((unit) => unit.itemId);
    const result = {
      ...common,
      submitted: true,
      changedItemIds,
      units,
    };
    if (itemId === undefined) return result;
    const unit = units.find((entry) => entry.itemId === itemId);
    if (!unit) throw new ReviewInputError(`投稿 ${itemId} は一覧にありません。`);
    if (!unit.differsFromRecommendation) {
      throw new ReviewInputError(`投稿 ${itemId} の最終判断は初期推奨案と同じです。`);
    }
    const item = batch.review.items.find((entry) => entry.id === itemId);
    const decision = batch.submission.decisions.find((entry) => entry.itemId === itemId);
    return {
      ...result,
      unit: {
        ...unit,
        context: decisionContext(item),
        recommendation: {
          basis: item.basis,
          resolvedPlan: recommendedResolvedPlan(item),
        },
        finalDecision: {
          choice: decision.choice,
          resolvedPlan: decision.resolvedPlan || null,
          ...(decision.supplementalReason
            ? { supplementalReason: decision.supplementalReason }
            : {}),
        },
      },
    };
  }

  function assertActiveSnapshot(batch, snapshotToken) {
    if (isExpired(batch)) {
      throw new ReviewInputError("この一覧は有効期限が切れています。再表示してください。");
    }
    if (batch.snapshotToken !== snapshotToken) {
      throw new ReviewInputError("表示内容のスナップショットが一致しません。再表示してください。");
    }
    if (batch.submission) {
      throw new ReviewInputError("この一覧は送信済みです。変更する場合は新しい一覧を表示してください。");
    }
  }

  function itemFor(batch, rawItemId) {
    const itemId = inputText(rawItemId, "投稿ID", { max: 300 });
    const item = batch.review.items.find((entry) => entry.id === itemId);
    if (!item) throw new ReviewInputError(`投稿 ${itemId} は一覧にありません。`);
    return item;
  }

  function normalizeSupplementalReason(value, itemId) {
    const supplementalReason = inputText(value, `投稿 ${itemId} の補足理由`, {
      optional: true,
    });
    if (supplementalReason) {
      assertNoSensitiveData(supplementalReason, `投稿 ${itemId} の補足理由`);
    }
    return supplementalReason;
  }

  function previewAlternative(batch, { itemId: rawItemId, changes, supplementalReason }) {
    const item = itemFor(batch, rawItemId);
    const normalizedReason = normalizeSupplementalReason(supplementalReason, item.id);
    const resolvedPlan = resolveAlternativePlan(item, changes);
    const resolvedMessageById = new Map(
      resolvedPlan.messages.map((message) => [message.messageId, message]),
    );
    const resolvedChanges = {
      selectedTargetCommentNumbers: resolvedPlan.targets.map((target) => target.commentNumber),
      selectedOperationIds: resolvedPlan.operations.map((operation) => operation.operationId),
      // 保存する差分もサーバー側で完全化する。クライアントが付けた未使用キーや
      // 未指定の扱いを承認記録へ持ち込まない。
      messageChanges: item.recommendation.messages.map((message) => {
        const resolved = resolvedMessageById.get(message.messageId);
        if (!resolved) return { messageId: message.messageId, action: "omit" };
        if (
          resolved.label === message.label &&
          resolved.text === message.text &&
          resolved.alreadyDeletedText === message.alreadyDeletedText
        ) {
          return { messageId: message.messageId, action: "keep" };
        }
        return {
          messageId: message.messageId,
          action: "replace",
          replacement: {
            label: resolved.label,
            text: resolved.text,
            ...(resolved.alreadyDeletedText === undefined
              ? {}
              : { alreadyDeletedText: resolved.alreadyDeletedText }),
          },
        };
      }),
    };
    const resolvedPlanToken = createResolvedPlanToken({
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      resolvedPlan,
    });
    return {
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      itemId: item.id,
      changes: resolvedChanges,
      resolvedPlan,
      resolvedPlanToken,
      supplementalReason: normalizedReason,
    };
  }

  function normalizeDecisions(batch, rawDecisions) {
    const decisions = inputArray(rawDecisions, "レビュー判断", { min: 1, max: 100 });
    const seen = new Set();
    const normalized = decisions.map((decision) => {
      if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
        throw new ReviewInputError("レビュー判断の形式が正しくありません。");
      }
      const item = itemFor(batch, decision.itemId);
      if (seen.has(item.id)) {
        throw new ReviewInputError(`投稿 ${item.id} の判断が重複しています。`);
      }
      seen.add(item.id);
      if (!isDecisionChoice(decision.choice)) {
        throw new ReviewInputError(`投稿 ${item.id} の判断が正しくありません。`);
      }

      if (decision.choice === "hold") {
        if (
          decision.changes !== undefined ||
          decision.supplementalReason !== undefined ||
          decision.resolvedPlanToken !== undefined ||
          decision.alternative !== undefined
        ) {
          throw new ReviewInputError(
            `投稿 ${item.id} の保留には構造化変更、補足理由、または完全案トークンを指定できません。`,
          );
        }
        return { itemId: item.id, choice: "hold" };
      }

      if (decision.choice === "approve") {
        if (
          decision.changes !== undefined ||
          decision.supplementalReason !== undefined ||
          decision.alternative !== undefined
        ) {
          throw new ReviewInputError(
            `投稿 ${item.id} の推奨案承認には構造化変更または補足理由を指定できません。`,
          );
        }
        const resolvedPlan = recommendedResolvedPlan(item);
        const expectedToken = createResolvedPlanToken({
          batchId: batch.batchId,
          snapshotToken: batch.snapshotToken,
          resolvedPlan,
        });
        const receivedToken = inputText(
          decision.resolvedPlanToken,
          `投稿 ${item.id} の推奨完全案トークン`,
          { max: 64 },
        );
        if (!/^[0-9a-f]{64}$/u.test(receivedToken) || receivedToken !== expectedToken) {
          throw new ReviewInputError(
            `投稿 ${item.id} の推奨完全案が表示後に変わりました。一覧を再表示してください。`,
          );
        }
        return {
          itemId: item.id,
          choice: "approve",
          resolvedPlan,
          resolvedPlanToken: expectedToken,
        };
      }

      if (decision.alternative !== undefined && decision.changes === undefined) {
        throw new ReviewInputError(
          `投稿 ${item.id} の自由文だけでは実行許可を作れません。構造化変更をプレビューしてください。`,
        );
      }
      const preview = previewAlternative(batch, decision);
      const receivedToken = inputText(
        decision.resolvedPlanToken,
        `投稿 ${item.id} の解決済み案トークン`,
        { max: 64 },
      );
      if (!/^[0-9a-f]{64}$/u.test(receivedToken) || receivedToken !== preview.resolvedPlanToken) {
        throw new ReviewInputError(
          `投稿 ${item.id} の解決済み案がプレビュー後に変わりました。もう一度確認してください。`,
        );
      }
      return {
        itemId: item.id,
        choice: "alternative",
        changes: preview.changes,
        supplementalReason: preview.supplementalReason,
        resolvedPlan: preview.resolvedPlan,
        resolvedPlanToken: preview.resolvedPlanToken,
      };
    });
    assertNoSensitiveData(normalized, "decisions");
    return normalized;
  }

  /**
   * 自律処理が承認できるのは、一覧作成時に確定した推奨案そのものだけとする。
   * 対象、操作、順序、本文は一覧作成時のスナップショットが正本になり、
   * 承認内容と結果報告の内容が同じ一つの案に揃う。
   */
  function normalizeAutonomousDecisions(batch, rawDecisions) {
    const items = batch.review?.items || [];
    const decisions = inputArray(rawDecisions, "自律処理の判断", { min: 1, max: 100 });
    const seen = new Set();
    const normalized = decisions.map((decision) => {
      if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
        throw new ReviewInputError("自律処理の判断の形式が正しくありません。");
      }
      const item = itemFor(batch, decision.itemId);
      if (seen.has(item.id)) {
        throw new ReviewInputError(`投稿 ${item.id} の判断が重複しています。`);
      }
      seen.add(item.id);
      if (!AUTONOMOUS_DECISION_CHOICES.includes(decision.choice)) {
        throw new ReviewInputError(
          `投稿 ${item.id} の自律処理の判断は承認か保留のいずれかにしてください。`,
        );
      }
      if (
        decision.changes !== undefined ||
        decision.supplementalReason !== undefined ||
        decision.resolvedPlanToken !== undefined ||
        decision.alternative !== undefined
      ) {
        throw new ReviewInputError(
          `投稿 ${item.id} の自律処理の判断には、推奨案の承認か保留以外を指定できません。`,
        );
      }
      if (decision.choice === "hold") return { itemId: item.id, choice: "hold" };
      const resolvedPlan = recommendedResolvedPlan(item);
      return {
        itemId: item.id,
        choice: "approve",
        resolvedPlan,
        resolvedPlanToken: createResolvedPlanToken({
          batchId: batch.batchId,
          snapshotToken: batch.snapshotToken,
          resolvedPlan,
        }),
      };
    });
    // 判断の無い処理単位を黙って未実行にしない。自律処理では、確認する人がいない
    // まま「未回答」が残ると、対応漏れが結果報告にも現れない。
    if (seen.size !== items.length) {
      throw new ReviewInputError(
        "自律処理では、一覧の全処理単位に承認か保留のいずれかを指定してください。",
      );
    }
    return normalized;
  }

  function persistSubmission(batch, { snapshotToken, decisions, authorizedBy }) {
    // 保存するのは下された判断という事実だけにする。実行許可、依存グループ停止、
    // 実行候補は読み込みのたびに純粋関数から導くため、保存値と再計算結果が
    // 食い違うことがない。
    const submission = {
      submissionId: randomUUID(),
      batchId: batch.batchId,
      snapshotToken,
      submittedAt: new Date(now()).toISOString(),
      // 承認の期限は承認記録へ焼き込む。承認したホストと実行するホストで設定が
      // 違っても、実行許可の判定が食い違わない。
      expiresAt: batch.expiresAt,
      // 実行許可の出所も記録へ焼き込む。実行する時点の設定から読み替えると、
      // モードを戻した後に自律承認を人間の承認として実行できてしまう。
      authorizedBy,
      decisions,
    };

    // 同じ一覧を別ホストから同時に送信しても、先に書けた一つだけを採用する。
    try {
      writeOnce(pathFor(batch.batchId, "submission"), submission);
    } catch (cause) {
      if (cause.code === "EEXIST") {
        throw new ReviewInputError(
          "この一覧は送信済みです。変更する場合は新しい一覧を表示してください。",
        );
      }
      throw cause;
    }
    // 返す要約も、読み込み経路と同じ導出を通す。保存済み記録は事実だけを持つ。
    return summaryBatch({ ...batch, submission: verifiedSubmission(batch, submission) });
  }

  /**
   * 結果報告に要る送信済み判断を返す。報告は保存されるファイルになるため、
   * 実行許可を作れる`resolvedPlanToken`は載せない。未送信の一覧は報告内容にしない。
   */
  function reportBatch(batch) {
    const common = commonBatch(batch);
    const submission = batch.submission
      ? applyExpiration(batch.submission, common.expired)
      : null;
    const decisionByItemId = new Map(
      (submission?.decisions || []).map((decision) => [decision.itemId, decision]),
    );
    return {
      ...common,
      batchTitle: batch.review.batchTitle,
      createdAt: batch.createdAt,
      submitted: Boolean(submission),
      authorizedBy: submission ? authorizedByOf(submission) : null,
      submittedAt: submission?.submittedAt || null,
      blockedDependencyGroups: submission?.blockedDependencyGroups || [],
      units: submission
        ? batch.review.items.map((item) => {
            const decision = decisionByItemId.get(item.id);
            return {
              item,
              choice: decision?.choice || UNDECIDED_CHOICE,
              plan: decision?.resolvedPlan || null,
            };
          })
        : [],
    };
  }

  return {
    directory,
    ttlMs,

    create(review, { groupKey } = {}) {
      const batchId = randomUUID();
      const record = {
        batchId,
        // 一覧を作った時点の対象グループ。承認ストアは実行先をまたいで共有されうるため、
        // 後から本文を読む経路はこの値を束縛中の対象へ照合する。
        groupKey,
        snapshotToken: createSnapshotToken(review),
        createdAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + ttlMs).toISOString(),
        review,
      };
      writeOnce(pathFor(batchId, "review"), record);
      prune();
      return summaryBatch({ ...record, submission: null });
    },

    /** 一覧を作った時点の対象グループ。呼び出し側が束縛中の対象へ照合するために読む。 */
    groupKeyOf(batchId) {
      return load(batchId).groupKey;
    },

    snapshot({ batchId, snapshotToken }) {
      const batch = load(batchId);
      assertActiveSnapshot(batch, snapshotToken);
      return snapshotBatch(batch);
    },

    preview({ batchId, snapshotToken, itemId, changes, supplementalReason }) {
      const batch = load(batchId);
      assertActiveSnapshot(batch, snapshotToken);
      return previewAlternative(batch, { itemId, changes, supplementalReason });
    },

    submit({ batchId, snapshotToken, decisions }) {
      const batch = load(batchId);
      assertActiveSnapshot(batch, snapshotToken);
      return persistSubmission(batch, {
        snapshotToken,
        decisions: normalizeDecisions(batch, decisions),
        authorizedBy: ADMINISTRATOR_AUTHORIZATION,
      });
    },

    /**
     * 自律処理の判断を保存する。保存の仕組みと一回性は人間の承認と同じにし、
     * 違うのは判断の出所と、承認できる案が推奨案そのものに限られることだけである。
     * 運用モードの可否はここでは見ない。呼び出し前に対象コンテキストで確かめる。
     */
    submitAutonomous({ batchId, snapshotToken, decisions, authorizedBy }) {
      if (!AUTONOMOUS_AUTHORIZATIONS.includes(authorizedBy)) {
        throw new ReviewInputError("自律処理の判断として保存できる運用モードではありません。");
      }
      const batch = load(batchId);
      assertActiveSnapshot(batch, snapshotToken);
      return persistSubmission(batch, {
        snapshotToken,
        decisions: normalizeAutonomousDecisions(batch, decisions),
        authorizedBy,
      });
    },

    get(batchId, { scope = "summary", itemId } = {}) {
      // 読むだけの日が続いても古い本文を残さないよう、取得のたびに掃除する。
      // 対象は読み込んだ後に消えても、返す内容には影響しない。
      const batch = load(batchId);
      prune();
      if (scope === "summary") return summaryBatch(batch);
      if (scope === "execution") return executionBatch(batch);
      if (scope === "report") return reportBatch(batch);
      if (scope === "decision_diff") return decisionDiffBatch(batch, itemId);
      throw new ReviewInputError(
        "レビュー取得範囲はsummary、execution、decision_diff、reportのいずれかを指定してください。",
      );
    },
  };
}
