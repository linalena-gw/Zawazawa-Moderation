/**
 * 失敗の`errorCode`の正本。コードごとに、どの失敗族に属するかと、次に取る行動の
 * 分類を一箇所で持つ。エージェントが復旧手段をコード別の表から引き直さずに済むよう、
 * サーバー側で一度だけ判定する。
 *
 * 族は失敗の発生源ではなく、分類器の値域である。経路は自分の族のコードを直接返してよい
 * 一方、他の族のコードを返してよいのは、その族を値域に持つ分類器（`ZawazawaConnectorError`、
 * `TargetConfigError`、`classifyReviewError`、`classifyExecutionPreconditionError`）を
 * 通した結果だけで、経路の都合で借りない。実行経路が承認ストアの失敗をreview族のコードで
 * 返すのはその分類器を通しているからであり、実行経路自身の停止理由は`execution`族の
 * コードで返す。
 *
 * この分類は行動の種類だけを示し、何かを承認しない。実行経路でブラウザへ移って
 * よいかは`browserFallbackAllowed`が正本であり、この値では上書きしない。
 *
 * 語彙と純粋な判定だけを持ち、他のモジュールを参照しない。各失敗族の列挙もこの表から
 * 導くため、コードの追加と分類の変更はここだけで完結する。各コードが指す条件と、
 * 外へ返す文言は、そのコードを起こす側が持つ。
 */

export const NEXT_ACTIONS = Object.freeze([
  "retry",
  "reauth",
  "browser",
  "stop",
]);

/** 失敗族。`errorCode`を受け取る型が検証に使う範囲がこの単位で決まる。 */
const ERROR_FAMILIES = Object.freeze([
  "connector",
  "targetConfig",
  "review",
  "execution",
]);

const ERROR_CODES = Object.freeze({
  // 管理画面・公開ページreader
  reauth_required: { family: "connector", nextAction: "reauth", browserFallbackAllowed: true },
  // 専用プロファイルの占有は同じ経路で解消しうるので、まず再試行に寄せる。
  profile_locked: { family: "connector", nextAction: "retry" },
  timed_out: { family: "connector", nextAction: "retry", browserFallbackAllowed: true },
  rate_limited: { family: "connector", nextAction: "retry" },
  // 自動取得を拒否された画面と、readerが同定できない画面は、人が見る経路なら読める。
  blocked: { family: "connector", nextAction: "browser", browserFallbackAllowed: true },
  page_changed: { family: "connector", nextAction: "browser", browserFallbackAllowed: true },
  unknown: { family: "connector", nextAction: "browser", browserFallbackAllowed: true },
  // 対象不在と入力の誤りは、経路を変えても同じ結果になる。
  not_found: { family: "connector", nextAction: "stop" },
  invalid_input: { family: "connector", nextAction: "stop" },

  // 対象設定。サーバーは束縛し直さないので、いずれも`stop`である。束縛だけが失われた
  // `target_context_invalid`を同じ設定ファイルで束縛し直してよいかは、skillの安全契約が持つ。
  target_not_configured: { family: "targetConfig", nextAction: "stop" },
  target_config_invalid: { family: "targetConfig", nextAction: "stop" },
  target_config_changed: { family: "targetConfig", nextAction: "stop" },
  target_context_invalid: { family: "targetConfig", nextAction: "stop" },
  group_not_allowed: { family: "targetConfig", nextAction: "stop" },
  // 宣言された運用モードでは行えない要求。モード自体の変更は管理者の設定変更による。
  moderation_mode_unsupported: { family: "targetConfig", nextAction: "stop" },

  // 承認ストアと実行ジャーナル。承認の作り直しは管理者の判断による。
  review_input_invalid: { family: "review", nextAction: "stop" },
  review_store_corrupt: { family: "review", nextAction: "stop" },
  review_store_unavailable: { family: "review", nextAction: "stop" },
  journal_input_invalid: { family: "review", nextAction: "stop" },
  journal_conflict: { family: "review", nextAction: "stop" },
  journal_corrupt: { family: "review", nextAction: "stop" },
  // 結果報告HTMLを書き出せない。読み書きできる場所を管理者が直すまで復旧しない。
  report_write_failed: { family: "review", nextAction: "stop" },

  // 実行経路。MCPが送信しない操作だけがブラウザ経路へ移る。
  browser_required: { family: "execution", nextAction: "browser", browserFallbackAllowed: true },
  precheck_mismatch: { family: "execution", nextAction: "stop" },
  operation_order_blocked: { family: "execution", nextAction: "stop" },
  already_dispatched: { family: "execution", nextAction: "stop" },
  // 実行直前照合の前提を組み立てられない失敗。承認済み保存データ側の不正と、
  // 承認済み対象とライブ対象の食い違いを分けて示す。どちらも送信していないが、
  // 経路を変えても同じ結果になるので、一覧を作り直すまで止める。
  approved_plan_invalid: { family: "execution", nextAction: "stop" },
  approval_integrity: { family: "execution", nextAction: "stop" },
  execution_precondition_invalid: { family: "execution", nextAction: "stop" },
});

/**
 * 族名の取り違えは検証範囲を静かに空にし、その族の型が受け取るコードをすべて既定値へ
 * 倒してしまうため、列挙を導く前に落とす。表の側の綴り違いも新しい族として通さない。
 */
function assertKnownFamily(family) {
  if (!ERROR_FAMILIES.includes(family)) {
    throw new Error(`未知の失敗族です: ${family}`);
  }
}

for (const { family } of Object.values(ERROR_CODES)) assertKnownFamily(family);

/** 失敗族に属する`errorCode`の列挙。族ごとの検証範囲をこの表から導く。 */
export function errorCodesForFamily(family) {
  assertKnownFamily(family);
  return Object.freeze(
    Object.entries(ERROR_CODES)
      .filter(([, meta]) => meta.family === family)
      .map(([errorCode]) => errorCode),
  );
}

/** 未知のコードは自動復旧経路を持たないものとして扱う（fail closed）。 */
export function nextActionForErrorCode(errorCode) {
  return Object.hasOwn(ERROR_CODES, errorCode)
    ? ERROR_CODES[errorCode].nextAction
    : "stop";
}

/**
 * ブラウザ経路でのやり直しを禁じた失敗では、`browser`を次の行動にしない。
 * 実行経路の停止は`browserFallbackAllowed`を併せて返すため、二つの値が食い違うと
 * 送信境界へ入った操作をブラウザで押し直させてしまう。
 */
export function nextActionForFailure(
  errorCode,
  { browserFallbackAllowed } = {},
) {
  const action = nextActionForErrorCode(errorCode);
  return browserFallbackAllowed === false && action === "browser"
    ? "stop"
    : action;
}

/** 復旧の既定値。代替許可の省略はfalseとし、説明文を処理分岐に使わせない。 */
export function recoveryForErrorCode(errorCode) {
  const nextAction = nextActionForErrorCode(errorCode);
  return {
    nextAction,
    browserFallbackAllowed: Object.hasOwn(ERROR_CODES, errorCode) && ERROR_CODES[errorCode].browserFallbackAllowed === true,
  };
}

/** 実行経路の禁止は読み取り復旧の許可より優先する。 */
export function recoveryForFailure(errorCode, { browserFallbackAllowed } = {}) {
  const recovery = recoveryForErrorCode(errorCode);
  recovery.browserFallbackAllowed &&= browserFallbackAllowed !== false;
  recovery.nextAction = nextActionForFailure(errorCode, recovery);
  return recovery;
}
