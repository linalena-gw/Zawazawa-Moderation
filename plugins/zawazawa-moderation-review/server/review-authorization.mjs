/**
 * ReviewAuthorization。
 *
 * 管理者判断から実行可能性までを、保存済みの事実だけから導く純粋な判定である。
 * 判断の選択肢、実行許可の意味、依存グループによる停止、有効期限、実行候補の導出を
 * ここへ集約する。永続化、時刻の取得、I/O、ホスト固有の表示は扱わない。
 *
 * 承認ストアが保存するのは管理者の判断という事実だけで、ここで導く値は保存しない。
 * 実行のたびに同じ入力から導き直すため、保存値と再計算結果が食い違うことがない。
 */

/**
 * 実行許可の出所。人間の承認と、運用モードが認めた自律承認を区別する。
 * 記録の無い古い承認は人間の承認として読む（自律承認を後から増やさない）。
 */
export const ADMINISTRATOR_AUTHORIZATION = "administrator";
/** 新規に記録できる自律承認。 */
export const AUTONOMOUS_AUTHORIZATIONS = Object.freeze(["autonomous"]);
/** 旧設定で記録済みの自律承認を人間の承認へ読み替えず、安全に判定するための読取語彙。 */
export const LEGACY_AUTONOMOUS_AUTHORIZATIONS = Object.freeze(["auto-review"]);
export const REVIEW_AUTHORIZATION_SOURCES = Object.freeze([
  ADMINISTRATOR_AUTHORIZATION,
  ...AUTONOMOUS_AUTHORIZATIONS,
  ...LEGACY_AUTONOMOUS_AUTHORIZATIONS,
]);

const AUTONOMOUS_AUTHORIZATION_SET = new Set([
  ...AUTONOMOUS_AUTHORIZATIONS,
  ...LEGACY_AUTONOMOUS_AUTHORIZATIONS,
]);

export function authorizedByOf(submission) {
  const stored = submission?.authorizedBy;
  return REVIEW_AUTHORIZATION_SOURCES.includes(stored)
    ? stored
    : ADMINISTRATOR_AUTHORIZATION;
}

/** 自律承認は、自律処理を宣言した運用モードでだけ実行してよい。 */
export function isAutonomousAuthorization(submission) {
  return AUTONOMOUS_AUTHORIZATION_SET.has(authorizedByOf(submission));
}

/** 自律経路が自分で作れる判断。代替案の編集はこの経路に持たせない。 */
export const AUTONOMOUS_DECISION_CHOICES = Object.freeze(["approve", "hold"]);

export const REVIEW_DECISION_CHOICES = Object.freeze([
  "approve",
  "hold",
  "alternative",
]);

/** 実行許可を作る判断。保留と未回答は実行しない。 */
export const AUTHORIZING_DECISION_CHOICES = Object.freeze([
  "approve",
  "alternative",
]);

export const UNDECIDED_CHOICE = "undecided";

export const BLOCKED_DEPENDENCY_GROUP_REASON =
  "依存グループ内の全単位に実行許可がありません。";

export const EXPIRED_EXECUTION_BLOCKED_REASON =
  "承認から有効期限を過ぎています。一覧を再表示し、承認を取り直してください。";

const DECISION_CHOICE_SET = new Set(REVIEW_DECISION_CHOICES);
const AUTHORIZING_CHOICE_SET = new Set(AUTHORIZING_DECISION_CHOICES);

export function isDecisionChoice(value) {
  return DECISION_CHOICE_SET.has(value);
}

/** その判断単体が実行許可を作るか。依存グループと期限はここでは見ない。 */
export function isAuthorizingChoice(choice) {
  return AUTHORIZING_CHOICE_SET.has(choice);
}

function itemIdsFor(decisions, choice) {
  return decisions
    .filter((decision) => decision.choice === choice)
    .map((decision) => decision.itemId);
}

/**
 * 依存グループのうち、実行許可と保留・未回答が混在するものを停止対象として返す。
 * 共有操作を持つ単位を部分的に実行しないためである。
 */
export function blockedDependencyGroupsFor(items, decisions) {
  const decisionById = new Map(
    decisions.map((decision) => [decision.itemId, decision]),
  );
  const groups = new Map();
  for (const item of items) {
    if (!item.dependencyGroup) continue;
    const groupItems = groups.get(item.dependencyGroup) || [];
    groupItems.push(item.id);
    groups.set(item.dependencyGroup, groupItems);
  }
  return [...groups.entries()]
    .map(([group, itemIds]) => {
      const choices = itemIds.map((itemId) => ({
        itemId,
        choice: decisionById.get(itemId)?.choice || UNDECIDED_CHOICE,
      }));
      const hasAuthorized = choices.some((entry) => isAuthorizingChoice(entry.choice));
      const allAuthorized = choices.every((entry) => isAuthorizingChoice(entry.choice));
      return hasAuthorized && !allAuthorized
        ? { group, itemIds, choices, reason: BLOCKED_DEPENDENCY_GROUP_REASON }
        : null;
    })
    .filter(Boolean);
}

/**
 * 一覧の処理単位と管理者判断から、実行許可と実行候補を導く。期限はここでは見ない。
 * 期限は保存済み記録の`expiresAt`と現在時刻から別に判定し、`applyExpiration`で重ねる。
 */
export function deriveAuthorization(items, decisions) {
  const approvedItemIds = itemIdsFor(decisions, "approve");
  const heldItemIds = itemIdsFor(decisions, "hold");
  const alternativeItemIds = itemIdsFor(decisions, "alternative");
  const authorizedItemIds = decisions
    .filter((decision) => isAuthorizingChoice(decision.choice))
    .map((decision) => decision.itemId);
  const blockedDependencyGroups = blockedDependencyGroupsFor(items, decisions);
  const blockedItemIds = new Set(
    blockedDependencyGroups.flatMap((group) => group.itemIds),
  );
  const executable = (itemIds) => itemIds.filter((itemId) => !blockedItemIds.has(itemId));
  return {
    approvedItemIds,
    heldItemIds,
    alternativeItemIds,
    authorizedItemIds,
    blockedDependencyGroups,
    executableApprovedItemIds: executable(approvedItemIds),
    executableAlternativeItemIds: executable(alternativeItemIds),
    executableAuthorizedItemIds: executable(authorizedItemIds),
  };
}

// 期限は承認記録へ焼き込む。承認したホストと実行するホストで設定が違っても、
// 判定が食い違わないようにする。欠落・破損時にローカル設定から許可を復元すると
// fail-openになるため、有効な`expiresAt`だけを採用する。
export function expiryOf(record) {
  const stored = Date.parse(record?.expiresAt);
  return Number.isFinite(stored) ? stored : Number.NaN;
}

/** 日時を読み取れない記録は期限切れとして扱う。実行許可を残す方向へ倒さない。 */
export function isExpired(record, nowMs) {
  return !(nowMs < expiryOf(record));
}

/**
 * 期限切れの承認から実行候補を落とす。個別の判断結果は残し、実行できる集合だけを
 * 空にする。何を承認したかの記録は期限切れでも失わない。
 */
export function applyExpiration(submission, expired) {
  if (!submission || !expired) return submission;
  return {
    ...submission,
    executableApprovedItemIds: [],
    executableAlternativeItemIds: [],
    executableAuthorizedItemIds: [],
    executionBlockedReason: [
      submission.executionBlockedReason,
      EXPIRED_EXECUTION_BLOCKED_REASON,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/**
 * 一つの処理単位を今この時点で実行してよいか。期限、送信の有無、依存グループの
 * 停止をまとめて見る唯一の述語であり、実行経路はこれ以外の条件で許可を作らない。
 */
export function isExecutableItem({ submission, expired, itemId }) {
  return Boolean(
    !expired &&
      submission &&
      submission.executableAuthorizedItemIds?.includes(itemId),
  );
}
