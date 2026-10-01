/**
 * 承認済みの原子操作を、認証済みコンテキストのままHTTPで送信する。
 *
 * 送信先はURLを組み立てて作らない。対象コメントの管理画面に描画されている操作リンク
 * （Yii2の`data-method="post"`、複数通報の一括完了だけは`.close-all-abuse`クラスの
 * モーダルトリガ）を一意に同定し、その`href`をそのまま送る。管理画面に
 * 無い操作は送信できず、リンクを一意にできない画面では止まる。ブラウザ経路が
 * 「画面に出ているUIだけを押す」ことで得ていた保証を、同じ画面の同じ要素を根拠に保つ。
 *
 * 確認ダイアログはこの経路には無い。ZAWAZAWAの確認はクライアント側の`data-confirm`で
 * あって、サーバー側の二段階ではない（`/…/delete`はGETに405を返し、確認画面を持たない）。
 * したがって対象の同定は、承認済み計画との照合と、この画面での一意な同定が担う。
 *
 * 本文、通報理由、投稿者、接続元はここで読まない。返すのは送信先、送信の可否、
 * 操作結果の判定に要る最小限の事実だけである。
 *
 * 実行許可は保存済みの承認ストアだけを出所とする。`execute_zawazawa_moderation_operation`は
 * `batchId`、`itemId`、`operationIndex`しか受け取らず、操作種別、対象、`reportIds`、本文は
 * サーバーが承認から解決する。呼び出し側が申告した操作内容は入力にならない。対象の管理画面
 * 参照は承認時に確定した公開URLからだけ解決し、解決したグループキーは束縛済み対象設定の
 * 許可リストを必ず通す。ブラウザ経路と違い、対象外グループへの送信は経路として存在しない。
 *
 * 実行直前照合は送信前に対象コメントの管理画面を一度読み、その原子操作に本当に必要な条件
 * だけを照合する。「送信する」「送らずに確定する（`no_action_needed`）」「止める
 * （`precheck_mismatch`と`differences`）」の三つへ分かれ、条件の構造・導出・比較は
 * `execution-preconditions.mjs`が正本である。誰の操作で到達点になったかは管理画面から
 * 読めないので区別しない。承認済み保存データ側の不正は差分ではなく前提の不成立として、
 * ライブ側の差分と混ぜずに止める。
 *
 * 対象と操作種別は承認済みの値のまま動かさない。照合の結果で選び直すのは、承認済みの値の
 * 中から選ぶ次の二つだけである。
 * ・閉じる通報: 承認済み通報のうち実行直前も未処理のものへそろえる。承認後に増えた未処理
 *   通報も閉じる完了では、通報ごとの送信ではなく一括操作（`close-all-abuse`）を選ぶ。
 *   通報表が1ページに収まらず読み切れない完了も同じ一括操作にし、読めた行だけを閉じて
 *   残りを取り残さない。効果の判定も実際に閉じた通報だけを見て、他の管理者がすでに
 *   閉じた通報を含めない。処理済みの表が1ページに収まらず閉じた行を追えない完了だけは、
 *   その対象に未処理通報が一件も残っていないことを到達点の確認にする。
 * ・送る本文: 対象が承認時は削除されておらず、承認済み完全案が同じ対象へ持つ削除を送信
 *   しないまま削除済みになっていた場合に限り、承認済みの`alreadyDeletedText`を送り、結果へ
 *   `messageVariant: "already_deleted"`を付ける。別の対象への削除を送信済みであることは
 *   この判定に入らない。
 *
 * 送信先の同定は送ると決めた後に同じ取得結果から行い、別の取得を挟まない。送らずに確定する
 * 操作は、対応する操作リンクが画面から消えていても止まらない。
 *
 * 結果には送信の有無（`dispatched`）と、ブラウザ経路へ移ってよいか（`browserFallbackAllowed`）
 * を必ず含める。送信前の失敗だけが`browserFallbackAllowed: true`で、権限・照合・ジャーナルに
 * よる停止と、送信を開始した後の結果はすべて`false`である。送信した事実は結果が不明でも
 * 消えない。承認済み完全案、入力値、ジャーナル記録、CSRFトークン、送信先URLは結果へ再掲
 * しない。ブラウザ経路が要る完全案は`get_moderation_review`の`scope: "browser_plan"`で取る。
 */
import {
  BASE_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  assertCommentDetailPage,
  parseCommentDetail,
  parseReportTables,
} from "./admin-reader.mjs";
import { DELETED_COMMENT_STATE, ZawazawaConnectorError } from "./identifiers.mjs";
import { loadDocument } from "./html-parse.mjs";

/** MCPから送信できる操作。ここに無い操作はブラウザ経路のままにする。 */
export const WRITABLE_OPERATION_TYPES = Object.freeze([
  "comment_delete",
  "author_auto_ignore",
  "report_complete",
  "report_ignore",
]);

/**
 * 操作ごとの送信仕様。`pathSegment`は照合のためだけに使い、送信先は画面のリンクから取る。
 * `messageField`を持つ操作だけが本文を送れる。
 */
const OPERATION_SPECS = Object.freeze({
  comment_delete: {
    pathSegment: "delete",
    targetsReport: false,
    messageField: null,
  },
  author_auto_ignore: {
    pathSegment: "ignore-user",
    targetsReport: false,
    messageField: null,
  },
  report_complete: {
    pathSegment: "close-abuse",
    targetsReport: true,
    messageField: "AbuseCloseForm[message]",
  },
  // 同じコメントに未処理通報が複数ある完了は、通報ごとの送信に分けず一括の操作を使う。
  // 原子操作の単位は承認済みステップであり、途中まで成功した状態を作らないため。
  report_complete_all: {
    pathSegment: "close-all-abuse",
    targetsReport: false,
    messageField: "AllCommentAbuseCloseForm[message]",
  },
  report_ignore: {
    pathSegment: "ignore-abuse",
    targetsReport: true,
    messageField: null,
  },
});

/**
 * 承認済みステップに対応する送信仕様を選ぶ。選べない組み合わせは`null`を返し、
 * 呼び出し側はブラウザ経路へ回す。無視には一括操作が無いため、同じコメントに
 * 複数IDを一つに束ねた旧承認の無視はここでは送信しない。新しい案は通報IDごとに分かれる。
 *
 * `closeAllReports`は、対象コメントの未処理通報を読み切れていない完了で立つ。通報表が
 * 1ページに収まらない画面では読めた行が全部ではないため、通報ごとの送信では残りが閉じない。
 */
export function writableOperationSpec(operationType, reportIds = [], closeAllReports = false) {
  if (!WRITABLE_OPERATION_TYPES.includes(operationType)) return null;
  if (operationType === "report_complete" && (closeAllReports || reportIds.length > 1)) {
    return { key: "report_complete_all", ...OPERATION_SPECS.report_complete_all };
  }
  if (["report_complete", "report_ignore"].includes(operationType)) {
    if (reportIds.length !== 1) return null;
  }
  return { key: operationType, ...OPERATION_SPECS[operationType] };
}

/**
 * 投稿者が制御する領域を除いた要素だけを見る。本文に管理操作らしいリンクが
 * 書かれていても送信先の候補にしない。
 */
function trustedElements($, selector) {
  return $(selector)
    .toArray()
    .filter((element) => !$(element).parents(".panel-body, textarea.md-code-editor").length);
}

/** CSRFトークンは画面が一つの値で一致している場合だけ使う。 */
function readCsrfToken($) {
  const values = new Set();
  const meta = $('meta[name="csrf-token"]').attr("content");
  if (meta) values.add(meta);
  for (const element of trustedElements($, 'input[name="_csrf"]')) {
    const value = $(element).attr("value");
    if (value) values.add(value);
  }
  if (values.size !== 1) {
    throw new ZawazawaConnectorError(
      "page_changed",
      values.size === 0
        ? "管理画面のCSRFトークンを確認できません。送信せずに中止しました。"
        : "管理画面のCSRFトークンが一意ではありません。送信せずに中止しました。",
    );
  }
  return [...values][0];
}

/**
 * 承認済み操作に対応する操作リンクを、対象コメントの管理画面から一意に同定する。
 * 通報ごとの操作は、リンクの`id`と通報行の`data-key`の両方が承認済み`reportId`と
 * 一致することまで確かめる。表示文からは対象を決めない。
 *
 * 通常の操作リンクはYii2の`data-method="post"`を持つ。例外は同じコメントの複数通報を
 * まとめて閉じる一括完了（`close-all-abuse`）で、これは`data-method`を持たず
 * `.close-all-abuse`クラスのリンクをクリックするとモーダル（`AllCommentAbuseCloseForm`）を
 * 開いてそのリンクの`href`へPOSTする配線になっている。単一完了のモーダルも同じ仕組みで、
 * コネクタが単一完了で`close-abuse?id=`の`href`へ本文付きPOSTしているのと対称に、一括完了も
 * クラスと`href`で同定して同じ`href`へPOSTする。送信先URLは組み立てず、描画されたリンクの
 * `href`をそのまま使う点は変えない。
 */
export function parseOperationSubmission(
  html,
  {
    groupKey,
    topicNumber,
    commentNumber,
    finalUrl,
    operationType,
    reportIds = [],
    closeAllReports = false,
    message,
  },
) {
  const spec = writableOperationSpec(operationType, reportIds, closeAllReports);
  if (!spec) {
    throw new ZawazawaConnectorError(
      "invalid_input",
      "この操作種別と通報件数の組み合わせはMCPから送信できません。",
    );
  }
  if (message !== undefined && !spec.messageField) {
    throw new ZawazawaConnectorError(
      "invalid_input",
      "この操作種別に本文は送信できません。",
    );
  }

  const $ = loadDocument(html);
  assertCommentDetailPage($, { groupKey, topicNumber, commentNumber, finalUrl });

  const expectedPath = `/m/${groupKey}/comment/${topicNumber}/${commentNumber}/${spec.pathSegment}`;
  const expectedOrigin = new URL(BASE_URL).origin;
  const [reportId] = reportIds;
  // 一括完了だけは`data-method`を持たないモーダルトリガなので、クラスで候補を絞る。
  const bulkComplete = spec.key === "report_complete_all";
  const matches = [];
  for (const element of trustedElements(
    $,
    bulkComplete ? "main a.close-all-abuse" : "main a[data-method]",
  )) {
    const anchor = $(element);
    // 一括完了のクラスはセレクタが空白区切りのトークンとして照合済みである。実画面では
    // 通報欄の見出しに1本だけ描かれ、通報行の中には無い。通報者が書いた理由セルに
    // 同じクラスのリンクがあっても送信先の候補にしない。
    if (bulkComplete && anchor.closest("tr[data-key]").length) continue;
    if (!bulkComplete && String(anchor.attr("data-method")).toLowerCase() !== "post") continue;
    let url;
    try {
      url = new URL(anchor.attr("href") || "", BASE_URL);
    } catch {
      continue;
    }
    if (url.origin !== expectedOrigin) continue;
    // `origin`は`user:pass@`を含まない。管理画面が描くリンクに認証情報は付かないので、
    // 付いているものは同定の対象にしない。送信先へそのまま持ち込ませない。
    if (url.username || url.password) continue;
    if (url.pathname.replace(/\/$/u, "") !== expectedPath) continue;

    if (spec.targetsReport) {
      const ids = url.searchParams.getAll("id");
      if (ids.length !== 1 || ids[0] !== reportId) continue;
      if ([...url.searchParams.keys()].some((name) => name !== "id")) continue;
      // 行の識別子と送信先の識別子が同じ通報を指すことまで確かめる。
      if (anchor.closest("tr[data-key]").attr("data-key") !== reportId) continue;
    } else if ([...url.searchParams.keys()].length > 0) {
      continue;
    }
    matches.push(url);
  }

  if (matches.length !== 1) {
    throw new ZawazawaConnectorError(
      "page_changed",
      matches.length === 0
        ? `対象コメント ${topicNumber}/${commentNumber} の管理画面に、承認済み操作に対応する操作リンクがありません。送信せずに中止しました。`
        : `対象コメント ${topicNumber}/${commentNumber} の管理画面で、承認済み操作に対応する操作リンクを一意に同定できません。送信せずに中止しました。`,
    );
  }

  const form = { _csrf: readCsrfToken($) };
  if (spec.messageField && message !== undefined) {
    // 本文の送信口が画面にあることを確かめてから載せる。無い画面へ本文を付けて
    // 送ると、対処メッセージなしの完了として通報が閉じうる。
    const fields = trustedElements(
      $,
      `form textarea[name="${spec.messageField}"], form input[name="${spec.messageField}"]`,
    );
    if (fields.length !== 1) {
      throw new ZawazawaConnectorError(
        "page_changed",
        "管理画面に対処メッセージの入力欄を一意に確認できません。本文なしで閉じないため送信せずに中止しました。",
      );
    }
    form[spec.messageField] = message;
  }

  return { url: matches[0].toString(), form };
}

/**
 * 操作結果を、応答として返ってきた管理画面の状態から判定する。
 * `true`は承認済み効果の確認、`false`は効果が生じていないことの確認、
 * `undefined`は未確認である。未確認を成功にも失敗にも寄せない。
 */
export function evaluateOperationEffect(
  html,
  { groupKey, topicNumber, commentNumber, finalUrl, operationType, reportIds = [], message },
) {
  const reference = { groupKey, topicNumber, commentNumber, finalUrl };
  if (operationType === "comment_delete") {
    let detail;
    try {
      detail = parseCommentDetail(html, reference);
    } catch {
      return undefined;
    }
    if (detail.currentState === DELETED_COMMENT_STATE) return true;
    return detail.currentState === undefined ? undefined : false;
  }

  if (operationType === "report_complete" || operationType === "report_ignore") {
    let reports;
    try {
      const $ = loadDocument(html);
      assertCommentDetailPage($, reference);
      reports = parseReportTables(html);
    } catch {
      return undefined;
    }
    const results = reportIds.map((reportId) => {
      if (reports.openReports.some((report) => report.reportId === reportId)) return false;
      const closed = reports.closedReports.find((report) => report.reportId === reportId);
      if (!closed) return undefined;
      if (operationType === "report_ignore") return !closed.responseMessage;
      // 完了は、承認した本文が対処メッセージとして記録されていることまでを一つの結果とする。
      if (message === undefined) return true;
      return closed.responseMessage === message;
    });
    // 承認済みステップは一つの結果として扱う。全件確認できた場合だけ成功とし、
    // 一件でも効果が無ければ失敗、判定できない通報が混ざれば未確認にする。
    if (results.some((result) => result === false)) return false;
    if (results.length > 0 && results.every((result) => result === true)) return true;
    // 通報表が1ページに収まらない画面では、閉じた通報が処理済み表の1ページ目に現れない
    // ことがある。読めた行だけでは追えなくても、対象コメントに未処理通報が一件も残って
    // いなければ、その完了の到達点には達している。
    if (
      operationType === "report_complete" &&
      reports.openReports.length === 0 &&
      !reports.openReportsTruncated
    ) {
      return true;
    }
    return undefined;
  }

  if (operationType === "author_auto_ignore") {
    let $;
    try {
      $ = loadDocument(html);
      assertCommentDetailPage($, reference);
    } catch {
      return undefined;
    }
    // 既存コメントの「無視」欄は投稿時点の状態であり、投稿者の現在設定を示さない。
    // 現在設定は、管理操作として設定と解除のどちらが提示されているかで読む。
    const paths = trustedElements($, "main a[data-method]").map((element) => {
      try {
        return new URL($(element).attr("href") || "", BASE_URL).pathname.replace(/\/$/u, "");
      } catch {
        return "";
      }
    });
    const base = `/m/${groupKey}/comment/${topicNumber}/${commentNumber}`;
    const offersIgnore = paths.includes(`${base}/ignore-user`);
    const offersRelease = paths.some(
      (path) => path.startsWith(`${base}/`) && /ignore-user-(?:remove|cancel)|unignore/u.test(path),
    );
    if (offersRelease && !offersIgnore) return true;
    if (offersIgnore && !offersRelease) return false;
    return undefined;
  }

  return undefined;
}

/**
 * 送信結果の画面から、その対象にまだ残っている未処理通報を読む。読めない画面では
 * `undefined`を返し、0件と未確認を混ぜない。読めた行が全部ではない画面（`truncated`）も
 * 残件の有無だけは読めるので、そのまま返す。
 */
export function readRemainingOpenReportIds(html, reference) {
  try {
    const $ = loadDocument(html);
    assertCommentDetailPage($, reference);
    return parseReportTables(html).openReports.map((report) => report.reportId);
  } catch {
    return undefined;
  }
}

/**
 * 送信結果の観測を実行状態へ写す。ZAWAZAWA固有の観測（管理画面の状態を読めたか、
 * 応答が効果の不在を示したか）はここで終わらせ、DOM構造や画面文言を実行経路へ
 * 持ち込まない。
 *
 * `effect`は`evaluateOperationEffect`の三値である。外部送信を開始した後は、効果を
 * 確認できた場合だけ`confirmed`とし、それ以外はすべて`unknown`へ倒す。効果が生じて
 * いないという観測も、同じ承認での自動再送を許す根拠にはしない。
 */
export function executionStatusForEffect(effect) {
  return effect === true ? "confirmed" : "unknown";
}

/**
 * 承認済み操作を送信する。GETと解析までは副作用が無く、`dispatched`が立った後の
 * 失敗はZAWAZAWAへ届いた可能性がある。呼び出し側はこの境界で、ブラウザ経路への
 * 切り替えと自動再試行の禁止を分ける。
 */
export function createAdminWriter(options = {}) {
  const requestContext = options.requestContext;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const reader = options.reader;
  const requestLimiter = options.requestLimiter;

  function statusError(status) {
    if (status === 403) {
      return new ZawazawaConnectorError(
        "blocked",
        `ZAWAZAWAが自動アクセスをHTTP ${status}で拒否しました。再認証では解消しません。`,
      );
    }
    if (status === 429 || status === 503) {
      return new ZawazawaConnectorError(
        "rate_limited",
        `ZAWAZAWAがHTTP ${status}を返しました。間隔を置いて再試行してください。`,
      );
    }
    if (status === 404) {
      return new ZawazawaConnectorError(
        "not_found",
        "管理画面に該当の対象がありません。",
      );
    }
    return new ZawazawaConnectorError(
      "unknown",
      `ZAWAZAWA管理画面がHTTP ${status}を返しました。`,
    );
  }

  async function unrestrictedPost(url, form) {
    let response;
    try {
      response = await requestContext.post(url, { form, timeout: timeoutMs });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      throw /timeout/iu.test(message)
        ? new ZawazawaConnectorError(
            "timed_out",
            `ZAWAZAWAが${timeoutMs}ミリ秒以内に応答しませんでした。`,
          )
        : new ZawazawaConnectorError("unknown", "ZAWAZAWAへの送信を完了できませんでした。");
    }
    const status = response.status();
    const tooLarge = () =>
      new ZawazawaConnectorError(
        "page_changed",
        "送信結果の応答が想定より大きすぎます。読み取らずに中止しました。",
      );
    const declaredLength = Number(response.headers?.()?.["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw tooLarge();
    }
    const html = status >= 200 && status < 300 ? await response.text() : "";
    // 管理画面readerと同じくUTF-8のバイト数で数える。文字数では実効上限がずれる。
    if (Buffer.byteLength(html, "utf8") > MAX_RESPONSE_BYTES) throw tooLarge();
    return { status, html, finalUrl: response.url() };
  }

  function post(url, form) {
    const send = () => unrestrictedPost(url, form);
    return requestLimiter ? requestLimiter.run(send) : send();
  }

  return {
    /**
     * 送信前に対象画面を一度だけ読む。副作用は無い。送信先の同定は`resolveSubmission`
     * へ残し、実行直前照合で送らないと決めた操作が、消えた操作リンクで止まらないようにする。
     * 同定は読んだその画面だけを根拠にするので、追加の取得は起きない。
     */
    async prepare(request) {
      const { html, finalUrl } = await reader.readCommentPage(request);
      return {
        detail: parseCommentDetail(html, { ...request, finalUrl }),
        resolveSubmission: (bound) =>
          parseOperationSubmission(html, { ...request, ...bound, finalUrl }),
      };
    },

    /**
     * 送信する。戻り値の`dispatched`は常にtrueで、`effect`が判定結果である。
     * 例外は送信そのものが完了しなかった場合にだけ起き、結果は不明として扱う。
     */
    async dispatch(request, submission) {
      const { status, html, finalUrl } = await post(submission.url, submission.form);
      if (status < 200 || status >= 300) {
        // 4xxは操作が受け付けられなかったことを示すが、応答だけでは効果の
        // 不在を確定できない。判定は呼び出し側の読み戻しに委ねる。
        return { status, effect: undefined, rejected: status >= 400 && status < 500 };
      }
      return {
        status,
        effect: evaluateOperationEffect(html, { ...request, finalUrl }),
        // 同じ応答から、その対象に残っている未処理通報も読む。追加の取得はしない。
        openReportIds: readRemainingOpenReportIds(html, { ...request, finalUrl }),
        rejected: false,
      };
    },

    /** 送信後に現在状態を読み直して効果の有無を確定する。 */
    async readback(request) {
      const { html, finalUrl } = await reader.readCommentPage(request);
      return {
        effect: evaluateOperationEffect(html, { ...request, finalUrl }),
        openReportIds: readRemainingOpenReportIds(html, { ...request, finalUrl }),
      };
    },

    statusError,
  };
}
