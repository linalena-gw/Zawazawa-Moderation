import { chromium } from "playwright-core";
import { cleanText } from "./input-text.mjs";
import {
  GROUP_KEY,
  NUMBER,
  ZAWAZAWA_USER_AGENT,
  ZawazawaConnectorError,
} from "./identifiers.mjs";
import { createAdminReader, splitReportMessage } from "./admin-reader.mjs";
import { createAdminWriter, writableOperationSpec } from "./admin-writer.mjs";
import {
  createRequestLimiter,
  MAX_CONCURRENT_ZAWAZAWA_REQUESTS,
} from "./request-limiter.mjs";
import { defaultConnectorProfileDirectory } from "./platform-paths.mjs";

// 分割規則の持ち主は`admin-reader.mjs`。読み取り経路が増えても規則を分岐させない。
export { splitReportMessage };

const DEFAULT_OPEN_REPORT_LIMIT = 50;
// 同時に投げる取得の上限。HTTPが速いことを理由に負荷は上げない。
const PROFILE_LOCK_PATTERN = /ProcessSingleton|SingletonLock|already in use|profile is in use/iu;
// 同梱ブラウザの本体は`npm install`のpostinstallで入るため、導入が失敗した環境、
// スクリプトを走らせない環境、共有キャッシュを消した環境では、依存関係だけがあって
// 本体が無い状態になりうる。この失敗を一般の読み取り失敗へ丸めると、管理者は入れ直せば
// 直ることに気づけないまま、手動経路を続けることになる。
const BROWSER_MISSING_PATTERN = /Executable doesn't exist|download new browser/iu;

function pickDefined(value, keys) {
  const result = {};
  for (const key of keys) {
    if (value?.[key] !== undefined) result[key] = value[key];
  }
  return result;
}

/**
 * MCPへ返す構造は項目の許可リストで作る。低レベルのparserが内部判定のために
 * 通報者名やトリップ、接続元を読むことは許容するが、ここを通った値だけが外へ出る。
 */
export const AUTHOR_COMMENT_FIELDS = Object.freeze([
  "commentNumber",
  "topicNumber",
  "body",
  "createdAt",
  "currentState",
  "parentCommentNumber",
  "publicUrl",
]);

export const OPEN_REPORT_FIELDS = Object.freeze([
  "reportId",
  "reason",
  "createdAt",
  "repeatAfterResponse",
]);

/** 管理画面の近傍欄が増えても、読み取り層の外へは必要な項目だけを渡す。 */
function allowlistedCommentDetail(detail) {
  return {
    ...pickDefined(detail, AUTHOR_COMMENT_FIELDS),
    ...(detail.openReports
      ? {
          openReports: detail.openReports.map((report) => pickDefined(report, OPEN_REPORT_FIELDS)),
          // 読めた通報行がその対象の全部かどうかと、分かる場合の総件数。行そのものと
          // 同じ経路で渡さないと、読めた件数を全部として扱う一覧を作ってしまう。
          openReportsTruncated: detail.openReportsTruncated === true,
          ...pickDefined(detail, ["openReportsTotalCount"]),
        }
      : {}),
    ...(detail.reportsError
      ? { reportsError: pickDefined(detail.reportsError, ["code", "message"]) }
      : {}),
  };
}

/**
 * 投稿履歴としてモデルへ返す項目。判断に使うのは番号、本文、状態、親子関係だけで、
 * 公開URLは通常の判断に要らない。参照解決はこの画面の`publicUrl`をサーバー内部で
 * 使い続けるが、その値をモデルの文脈へは載せない。
 */
export const AUTHOR_HISTORY_FIELDS = Object.freeze(
  AUTHOR_COMMENT_FIELDS.filter((field) => field !== "publicUrl"),
);

function allowlistedAuthorComment(detail) {
  return pickDefined(detail, AUTHOR_HISTORY_FIELDS);
}

/**
 * 未処理通報一覧としてモデルへ返す項目。対象はトピック番号とコメント番号で指し、
 * URLは載せない。一覧作成ツールはサーバー側で参照を再解決し、
 * ブラウザ経路の管理画面URLは承認済み完全案が返すため、1行ごとに2本のURLを
 * モデルの文脈へ積む必要がない。
 */
export const OPEN_REPORT_LIST_FIELDS = Object.freeze([
  "reportId",
  "topicNumber",
  "commentNumber",
  "reason",
  "createdAt",
]);

function allowlistedOpenReport(report) {
  return pickDefined(report, OPEN_REPORT_LIST_FIELDS);
}

/**
 * macOSは既存互換、WindowsはLOCALAPPDATA配下。正式対応外OSでは明示設定を必須とする。
 * パスの`Codex/`は最初に使ったホストの名前が、`chrome-profile`は最初に使ったブラウザの
 * 名前が残ったもので、どちらも現在の構成を指してはいない。他のホストからも、Playwright
 * 同梱ブラウザへ切り替えた後も、同じプロファイルをそのまま共有する。改名すると既存の
 * 認証済みプロファイルから切り離され、管理者に再認証を強いるため、名前は動かさない。
 */
export function defaultProfileDirectory() {
  return defaultConnectorProfileDirectory();
}

/**
 * 認証用と読み取り用で共通の起動設定。サンドボックスは常に有効にする。
 * 使うのはPlaywrightが`npm install`で入れる同梱ブラウザで、`channel`は指定しない。
 * 管理者が普段Chromeを使っていなくても管理業務のためだけに入れずに済み、アプリ一覧にも
 * 出ない。手元のChromeを消しても、このプラグインは動き続ける。
 * ZAWAZAWAが403で拒むのは起動形態ではなくUser-Agentで、`HeadlessChrome`を含む値だけが
 * 対象である。ヘッドレス起動は既定でその綴りを名乗るため、`ZAWAZAWA_USER_AGENT`を
 * 明示して名乗り直す。これで読み取りは窓を出さずに済み、画面を出すのは人が認証するときだけになる。
 * 動きを目で追いたいときは`ZAWAZAWA_CONNECTOR_HEADLESS=0`で表示ありへ戻す。
 */
export function persistentContextOptions(overrides = {}) {
  return {
    headless: process.env.ZAWAZAWA_CONNECTOR_HEADLESS !== "0",
    userAgent: ZAWAZAWA_USER_AGENT,
    viewport: { width: 1280, height: 900 },
    ...overrides,
    chromiumSandbox: true,
  };
}

/**
 * 人がログインする画面の起動設定。表示ありで開き、ブラウザ自身のUser-Agentのまま見せる。
 * 読み取り経路が名乗る値はヘッドレスの403を避けるためのもので、ログイン画面がUser-Agentで
 * 表示を変える場合に人の操作を巻き込む理由が無い。Cookieは名乗りに依存しないため、
 * ここで取れた認証はヘッドレスの読み取りでもそのまま使える。
 */
export function authContextOptions() {
  return persistentContextOptions({ headless: false, viewport: null, userAgent: undefined });
}

/**
 * 認証用のコンテキストを開く。起動失敗は読み取りと同じ文言へ写す。同梱ブラウザの本体が
 * 入っていない場合やプロファイルを開けない場合に、Playwrightの失敗をそのまま見せても、
 * 管理者は何をすれば再認証を始められるのか分からない。
 */
export async function launchAuthContext(browserType = chromium) {
  try {
    return await browserType.launchPersistentContext(
      defaultProfileDirectory(),
      authContextOptions(),
    );
  } catch (error) {
    throw asConnectorError(error);
  }
}

export function normalizeHistoryRequest(input) {
  const groupKey = cleanText(input.groupKey || "");
  const topicNumber = cleanText(input.topicNumber || "");
  const commentNumber = cleanText(input.commentNumber || "");
  const limit = input.limit;

  if (!GROUP_KEY.test(groupKey)) {
    throw new ZawazawaConnectorError("invalid_input", "グループキーの形式が不正です。");
  }
  if (!NUMBER.test(topicNumber)) {
    throw new ZawazawaConnectorError("invalid_input", "トピック番号の形式が不正です。");
  }
  if (!NUMBER.test(commentNumber)) {
    throw new ZawazawaConnectorError("invalid_input", "コメント番号の形式が不正です。");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new ZawazawaConnectorError(
      "invalid_input",
      "履歴件数は必須で、1から20の整数で指定してください。",
    );
  }

  return { groupKey, topicNumber, commentNumber, limit };
}

export function normalizeCommentRequest(input) {
  const groupKey = cleanText(input.groupKey || "");
  const topicNumber = cleanText(input.topicNumber || "");
  const commentNumber = cleanText(input.commentNumber || "");

  if (!GROUP_KEY.test(groupKey)) {
    throw new ZawazawaConnectorError("invalid_input", "グループキーの形式が不正です。");
  }
  if (!NUMBER.test(topicNumber)) {
    throw new ZawazawaConnectorError("invalid_input", "トピック番号の形式が不正です。");
  }
  if (!NUMBER.test(commentNumber)) {
    throw new ZawazawaConnectorError("invalid_input", "コメント番号の形式が不正です。");
  }

  return {
    groupKey,
    topicNumber,
    commentNumber,
    // 既定は通報表つき。要らないと明示された参照だけを軽い経路へ回す。
    ...(input.includeReports === false ? { includeReports: false } : {}),
  };
}

const BLOCKED_STATUSES = new Set([403]);
const RATE_LIMITED_STATUSES = new Set([429, 503]);

/**
 * 人が認証するための画面を開く。読み取りには使わない（読み取りは`admin-reader.mjs`の
 * HTTP取得が行う）。拒否された画面はログイン失敗と見分けが付かないため、
 * 恒久的な拒否（403）と一時的な制限（429、503）を分けて理由を示す。
 */
export async function gotoChecked(page, targetUrl) {
  const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  const status = response?.status?.();
  if (status && BLOCKED_STATUSES.has(status)) {
    throw new ZawazawaConnectorError(
      "blocked",
      `ZAWAZAWAが自動アクセスをHTTP ${status}で拒否しました。再認証でも設定変更でも解消しません。管理画面を直接読み取ってください。`,
    );
  }
  if (status && RATE_LIMITED_STATUSES.has(status)) {
    throw new ZawazawaConnectorError(
      "rate_limited",
      `ZAWAZAWAがHTTP ${status}を返しました。一時的な制限または保守中です。再認証でも手動検索でも解消しないため、間隔を置いて再試行してください。`,
    );
  }
  return response;
}

/** 参照ごとの詳細を、上限を決めて並行に読む。 */
export async function readCommentDetails(adminReader, references, method = "readCommentDetail") {
  if (!references.length) return [];
  const results = new Array(references.length);
  let next = 0;

  const workerCount = Math.min(MAX_CONCURRENT_ZAWAZAWA_REQUESTS, references.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next++;
      if (index >= references.length) return;
      const reference = references[index];
      // 通報表が要らない参照は、同じ並行枠のまま通報表を読まない経路で解決する。
      const readMethod =
        reference.includeReports === false ? "readAuthorCommentDetail" : method;
      results[index] = await adminReader[readMethod](reference);
    }
  });

  await Promise.all(workers);
  return results;
}

function asConnectorError(error) {
  if (error instanceof ZawazawaConnectorError) return error;
  const message = error instanceof Error ? error.message : "";
  if (PROFILE_LOCK_PATTERN.test(message)) {
    return new ZawazawaConnectorError(
      "profile_locked",
      "ZAWAZAWA専用認証プロファイルが使用中です。「npm run auth:zawazawa」で開いた専用ブラウザが残っていれば閉じ、それでも解消しない場合はこのプラグインを読み込んだホストを終了してから再試行してください。手動検索へ切り替えないでください。",
    );
  }
  if (BROWSER_MISSING_PATTERN.test(message)) {
    return new ZawazawaConnectorError(
      "unknown",
      "管理画面を読む専用ブラウザの本体がありません。プラグインディレクトリで「npm install」を実行し、ブラウザの導入まで終わったことを確かめてから再試行してください。導入には通信が要ります。",
    );
  }
  return new ZawazawaConnectorError(
    "unknown",
    "ZAWAZAWA管理画面を安全に読み取れませんでした。",
  );
}

export function createZawazawaConnector(options = {}) {
  const profileDirectory = options.profileDirectory || defaultProfileDirectory();
  const browserType = options.browserType || chromium;
  // connectorの全呼び出しが同じ枠を共有する。server.mjsから渡された場合は公開readerとも共有する。
  const requestLimiter = options.requestLimiter || createRequestLimiter();
  let contextPromise;
  let readerPromise;
  let writerPromise;

  /** 掴んでいるコンテキストを手放し、次の呼び出しで開き直せる状態へ戻す。 */
  function forgetContext() {
    const pending = contextPromise;
    contextPromise = undefined;
    readerPromise = undefined;
    writerPromise = undefined;
    return pending;
  }

  async function context() {
    if (!contextPromise) {
      contextPromise = browserType
        .launchPersistentContext(profileDirectory, persistentContextOptions())
        .catch((error) => {
          // 起動に失敗したコンテキストは読み取り側にも残さない。掴んだままだと、専用
          // ブラウザを閉じても本体を入れ直しても開き直しを試みず、文言が指す再試行が
          // ホストの再起動まで通らない。
          forgetContext();
          throw asConnectorError(error);
        });
    }
    return contextPromise;
  }

  /**
   * 読み取りは認証済みコンテキストのCookieを共有したHTTP取得で行う。
   * ページを開かないため、描画待ちもロケータ待ちも起きない。
   */
  async function reader() {
    if (!readerPromise) {
      readerPromise = context().then((browserContext) =>
        createAdminReader({ requestContext: browserContext.request, requestLimiter }),
      );
    }
    return readerPromise;
  }

  async function writer() {
    if (!writerPromise) {
      writerPromise = Promise.all([context(), reader()]).then(
        ([browserContext, adminReader]) =>
          createAdminWriter({
            requestContext: browserContext.request,
            reader: adminReader,
            requestLimiter,
          }),
      );
    }
    return writerPromise;
  }

  /** 開いているコンテキストを閉じ、次の呼び出しで開き直せる状態へ戻す。 */
  async function closeContext() {
    const pending = forgetContext();
    if (!pending) return;
    const browserContext = await pending.catch(() => undefined);
    if (browserContext) await browserContext.close().catch(() => {});
  }

  /**
   * 失敗を返す前に、再認証が要るときだけコンテキストを閉じる。開いたままのHTTP取得が
   * 持つCookieは開いた時点のもので、`npm run auth:zawazawa`が同じプロファイルへ書いた
   * 新しいCookieを拾わない。閉じずにいると、管理者が案内どおり入り直しても読み取りは
   * 古いCookieを送り続け、ホストを再起動するまで同じ失敗を返す。`reauth_required`は
   * このプロファイルではもう読めないという意味なので、閉じても失う状態は無く、次の
   * 呼び出しが開き直して新しい認証を読む。
   */
  async function failed(error) {
    const mapped = asConnectorError(error);
    if (mapped.code === "reauth_required") await closeContext();
    return mapped;
  }

  return {
    /**
     * 承認済み操作の送信を組み立てる。ここまでに副作用は無く、`bind`が返す`submit`を
     * 呼んだ時点で初めてZAWAZAWAへ届きうる。送信先とCSRFトークンは閉包の中に
     * 留め、呼び出し側の応答へ出さない。
     */
    async reconcileApprovedOperation(input) {
      const request = { ...normalizeCommentRequest(input), operationType: input.operationType };
      // prepare/bind/dispatchを経由せず、読み戻しだけを呼ぶ。
      if (!["comment_delete", "author_auto_ignore"].includes(request.operationType)) {
        return { effect: undefined };
      }
      try { return await (await writer()).readback(request); }
      catch (error) { throw await failed(error); }
    },

    async prepareApprovedOperation(input) {
      const request = {
        ...normalizeCommentRequest(input),
        operationType: input.operationType,
        reportIds: input.reportIds || [],
        closeAllReports: input.closeAllReports === true,
        ...(input.message !== undefined ? { message: input.message } : {}),
      };
      if (
        !writableOperationSpec(request.operationType, request.reportIds, request.closeAllReports)
      ) {
        throw new ZawazawaConnectorError(
          "invalid_input",
          "この操作種別と通報件数の組み合わせはMCPから送信できません。",
        );
      }
      try {
        const adminWriter = await writer();
        const { detail, resolveSubmission } = await adminWriter.prepare(request);
        return {
          // 実行直前照合に要る事実だけを返す。本文と通報理由は返さない。
          precheck: {
            currentState: detail.currentState,
            openReportIds: (detail.openReports || []).map((report) => report.reportId).sort(),
            // 読めた未処理通報がその対象の全部かどうか。1ページに収まらない通報表では、
            // 承認済み通報の行が見えないことがある。
            openReportsTruncated: detail.openReportsTruncated === true,
            // 処理済みの通報IDも返す。未処理から消えた通報が閉じられたのか、行ごと
            // 消えたのかは、この二つを見比べないと分けられない。
            closedReportIds: (detail.closedReports || []).map((report) => report.reportId).sort(),
            reportsUnavailable: !detail.openReports || !detail.closedReports,
          },
          /**
           * 送信すると決めた後にだけ送信先を確定する。実行直前照合で送らないと決めた
           * 操作は、対応する操作リンクが画面に無くてもここへ来ないので止まらない。
           * `overrides`で渡せるのは実際に閉じる通報の集合、その通報を一括で閉じるか、
           * 承認済みの本文のうちどれを送るかだけで、対象コメントと操作種別は承認済みの値の
           * まま動かさない。
           */
          bind(overrides = {}) {
            const bound = {
              ...request,
              ...(overrides.reportIds ? { reportIds: overrides.reportIds } : {}),
              ...(overrides.closeAllReports !== undefined
                ? { closeAllReports: overrides.closeAllReports === true }
                : {}),
              ...(overrides.message !== undefined ? { message: overrides.message } : {}),
            };
            let submission;
            try {
              submission = resolveSubmission(bound);
            } catch (error) {
              throw asConnectorError(error);
            }
            return {
              submit: async () => {
                try {
                  return await adminWriter.dispatch(bound, submission);
                } catch (error) {
                  throw await failed(error);
                }
              },
              readback: async () => {
                try {
                  return await adminWriter.readback(bound);
                } catch (error) {
                  throw await failed(error);
                }
              },
            };
          },
        };
      } catch (error) {
        throw await failed(error);
      }
    },

    async getAuthorHistory(input) {
      const request = normalizeHistoryRequest(input);
      try {
        const adminReader = await reader();
        // 対象詳細を先に確定する。検索結果や件数上限から対象を推測せず、対象ページを
        // 読めない場合はこの時点で既存のerrorCodeにより失敗する。
        const { targetComment: rawTargetComment, hostValue } =
          await adminReader.readCommentDetailAndHost(request);
        if (!hostValue) {
          throw new ZawazawaConnectorError(
            "page_changed",
            "対象投稿の接続元情報を管理画面で確認できません。",
          );
        }

        const references = await adminReader.searchCommentReferences({
          groupKey: request.groupKey,
          hostValue,
          limit: request.limit,
        });
        const targetKey = `${request.topicNumber}/${request.commentNumber}`;
        const targetIncludedInHistory = references.some(
          (reference) => `${reference.topicNumber}/${reference.commentNumber}` === targetKey,
        );
        const otherReferences = references.filter(
          (reference) => `${reference.topicNumber}/${reference.commentNumber}` !== targetKey,
        );
        const otherDetails = await readCommentDetails(
          adminReader,
          otherReferences.map((reference) => ({ groupKey: request.groupKey, ...reference })),
          "readAuthorCommentDetail",
        );
        const targetComment = allowlistedAuthorComment(rawTargetComment);
        // 対象本文はtargetCommentが1回だけ返す。履歴は対象以外の投稿だけを検索結果順で
        // 持ち、同じ本文を同一応答内で繰り返さない。
        const history = otherDetails.map((detail) => allowlistedAuthorComment(detail));

        return {
          groupKey: request.groupKey,
          target: {
            topicNumber: request.topicNumber,
            commentNumber: request.commentNumber,
          },
          targetComment,
          targetIncludedInHistory,
          checkedAt: new Date().toISOString(),
          history,
        };
      } catch (error) {
        throw await failed(error);
      }
    },

    /** 未処理通報の一覧。読み取りだけで、通報の処理は行わない。 */
    async getOpenReports(input) {
      const groupKey = cleanText(input.groupKey || "");
      const limit = input.limit ?? DEFAULT_OPEN_REPORT_LIMIT;
      if (!GROUP_KEY.test(groupKey)) {
        throw new ZawazawaConnectorError("invalid_input", "グループキーの形式が不正です。");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ZawazawaConnectorError(
          "invalid_input",
          "取得件数は1から100の整数で指定してください。",
        );
      }
      try {
        const adminReader = await reader();
        const result = await adminReader.readOpenReports({ groupKey, limit });
        return {
          groupKey,
          checkedAt: new Date().toISOString(),
          reports: result.reports.map(allowlistedOpenReport),
          totalCount: result.totalCount,
          totalCountConfirmed: result.totalCountConfirmed,
          completeness: result.completeness,
          ...(result.incompleteReason
            ? {
                incompleteReason: pickDefined(result.incompleteReason, [
                  "code",
                  "returnedCount",
                  "totalCount",
                ]),
              }
            : {}),
          truncated: result.truncated,
        };
      } catch (error) {
        throw await failed(error);
      }
    },

    async getComment(input) {
      const [comment] = await this.getComments([input]);
      return comment;
    },

    /** 複数の参照をまとめて解決する。同じ参照は一度だけ読む。 */
    async getComments(inputs) {
      const requests = inputs.map(normalizeCommentRequest);
      const unique = [];
      const indexByKey = new Map();
      for (const request of requests) {
        const key = `${request.groupKey}/${request.topicNumber}/${request.commentNumber}`;
        const index = indexByKey.get(key);
        if (index === undefined) {
          indexByKey.set(key, unique.length);
          unique.push(request);
          continue;
        }
        // 同じ参照で通報表の要否が混ざる場合は、要る方に合わせて一度だけ読む。
        if (request.includeReports !== false) delete unique[index].includeReports;
      }

      try {
        const adminReader = await reader();
        const details = await readCommentDetails(adminReader, unique);
        return requests.map((request) => {
          const key = `${request.groupKey}/${request.topicNumber}/${request.commentNumber}`;
          return allowlistedCommentDetail(details[indexByKey.get(key)]);
        });
      } catch (error) {
        throw await failed(error);
      }
    },

    async close() {
      await closeContext();
    },
  };
}
