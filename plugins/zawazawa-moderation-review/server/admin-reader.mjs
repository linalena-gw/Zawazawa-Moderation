/**
 * ZAWAZAWA管理画面readerの契約の正本。認証済みコネクタからのHTTP取得とHTML解析だけで
 * 対象コメント、通報、投稿履歴を読む。読み取り目的でページを描画せず、JavaScriptも
 * 実行しない。人が認証するときだけ専用ブラウザの画面を使う。
 *
 * どのreaderをいつ使うか、失敗時にどの経路へ移るかはskills/zawazawa-moderation/
 * references/live-read.md、`errorCode`と`nextAction`の分類はerror-codes.mjs、
 * 外部フィールドの型と列挙値・モデルへ返す最小projectionはserver.mjsのツール登録が持つ。
 *
 * 取得境界:
 * ・専用ブラウザのプロファイルの認証済みCookieを共有し、`browserContext.request.get`で取得する。
 * ・1要求のタイムアウトはDEFAULT_TIMEOUT_MS。リダイレクト後の最終URLを画面同定に使う。
 * ・本文上限はMAX_RESPONSE_BYTES。申告長が上限を超える応答は本文を読まずに止め、
 *   長さを申告しない応答は読み切った後のバイト数で同じ上限を当てる。どちらも`page_changed`。
 * ・並行取得はrequest-limiter.mjsの共有枠で抑え、取得が速いことを理由に
 *   ZAWAZAWAへの並行負荷を増やさない。
 * ・状態コードと取得失敗は解析へ進めず`errorCode`へ正規化する。403=`blocked`、
 *   429/503=`rate_limited`、404=`not_found`、timeout=`timed_out`、他の非2xx=`unknown`。
 * ・画面同定・解析・一意性のいずれかに失敗した画面は`page_changed`、詳細画面以外や
 *   通報タブ以外へ転送された場合は`reauth_required`とする。
 *
 * 解析規則:
 * ・HTMLはブラウザ同等の木構造補正を行う解析器（html-parse.mjs）で読み、平坦な正規表現で
 *   要素を対応付けない。クラス名はトークン単位で照合する。
 * ・実体参照はタグ除去後に復号し、投稿本文中のHTMLらしき記述を要素として再解釈しない。
 * ・表は対象表の直下の行・セルだけを読み、入れ子の表や近傍の管理欄へ広げない。
 *   通報行は`data-key`を持つ行に限り、正規の空表示はそれとは別の肯定的な標識として確認する。
 * ・コメント本文はソース欄`textarea.md-code-editor`を原文として優先し、無いか空のときだけ
 *   同じ`.comment-view`内の描画済み`.panel-body`を可視テキストへ落とす。
 *
 * 横断不変条件:
 * ・画面同定はリダイレクト後の管理URLの完全一致で行い、見出し文言は使わない。公開投稿URLは
 *   必須の存在証明ではなく、別対象を指すリンクの矛盾検出にだけ使う。
 * ・「表が無い」「空配列」「`0件中`の文字」だけを0件の根拠にしない。肯定的な空表示標識と
 *   件数の一致でだけ0件を確定し、確認できないものは`page_changed`または`completeness: unknown`
 *   にする。状態欄を読めないときは`公開中`を推測せず未確認のまま返す。
 * ・`.comment-view`が複数ある画面は対象を一意にできず`page_changed`。
 * ・通報表の読み取り失敗は`reportsError`へ分離し、本文と状態の取得を巻き込まない。
 * ・1ページに収まらない通報表は`openReportsTruncated`で示し、読めた行を全部と混ぜない。
 *   総件数は件数表示（`N件中`）から読める場合だけ`openReportsTotalCount`で示し、
 *   読み切れていない表の残件数を推測しない。
 * ・返却は読み取り目的ごとの許可項目だけへ射影し、生HTML、DOM、近傍の管理欄、通報表全体、
 *   接続元値、通報者の表示名・トリップを外部応答・ログ・エラー文・フィクスチャへ出さない。
 *   同一通報者かどうかは内部照合した`repeatAfterResponse`だけを返す。IP、ホスト、ポート、
 *   User-Agent、セッションはどこへも出さない。
 */

import { cleanText } from "./input-text.mjs";
import { ZawazawaConnectorError } from "./identifiers.mjs";
import { htmlToText, loadDocument } from "./html-parse.mjs";

export const BASE_URL = "https://z.wikiwiki.jp";
export const DEFAULT_TIMEOUT_MS = 15000;
// 1本あたりの上限。想定を超える応答で常駐プロセスの記憶域を食い潰さない。
// 申告された長さは本文を読む前に見る。読み切ってから数えるだけでは、上限を超えた
// 応答がすでに全量メモリへ載っており、上限を置いた目的を果たさない。
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const CANONICAL_EMPTY_REPORTS_TEXT = "結果が得られませんでした。";
const TABLE_SECTION_NAMES = new Set(["thead", "tbody", "tfoot"]);

export function adminCommentUrl({ groupKey, topicNumber, commentNumber }) {
  return `${BASE_URL}/m/${groupKey}/comment/${topicNumber}/${commentNumber}`;
}

export function publicCommentUrl({ groupKey, topicNumber, commentNumber }) {
  return `${BASE_URL}/${groupKey}/topic/${topicNumber}/${commentNumber}`;
}

/**
 * 欄の値は`textContent`と同じ規則で取り出す。`htmlToText`は改行を足して
 * 可読テキストへ落とすため、欄の値の照合には使わない。
 */
function cellText(selection) {
  return selection.text().trim();
}

/**
 * 欄の子ノードを、DOMの`childNodes`と同じ並びで取り出す。
 * 通報欄の分割規則（`splitReportMessage`）が受け取る形をここで作る。
 */
function childNodes($, selection) {
  if (!selection.length) return [];
  return selection
    .contents()
    .toArray()
    .map((node) =>
      node.type === "text"
        ? { tag: "", text: node.data || "", cls: "" }
        : {
            tag: (node.name || "").toUpperCase(),
            text: $(node).text(),
            cls: node.attribs?.class || "",
          },
    );
}

/**
 * 表を、見出し行と`data-key`を持つ直下の行へ分ける。
 * 入れ子の表や近傍欄まで広げると、接続元欄など不要な値を許可済みの列として
 * 取り込む余地が生まれるため、対象表の行・セル境界を越えない。
 */
function directTableRows($, table) {
  const rows = [];
  for (const child of table.children().toArray()) {
    if (child.name === "tr") {
      rows.push(child);
      continue;
    }
    if (TABLE_SECTION_NAMES.has(child.name)) {
      rows.push(...$(child).children("tr").toArray());
    }
  }
  return rows;
}

function parseTable($, table) {
  const tableRows = directTableRows($, table);
  const headers = tableRows.flatMap((element) =>
    $(element)
      .children("th")
      .toArray()
      .map((cell) => cellText($(cell))),
  );
  const rows = [];
  let emptyStateConfirmed = false;
  for (const element of tableRows) {
    const row = $(element);
    // 通報が無い表には「結果が得られませんでした。」の1行だけが入り、`data-key`を持たない。
    const reportId = row.attr("data-key") || "";
    const cells = row.children("td").toArray();
    if (!cells.length) continue;
    if (!reportId) {
      emptyStateConfirmed ||=
        cells.length === 1 && cleanText(cellText($(cells[0]))) === CANONICAL_EMPTY_REPORTS_TEXT;
      continue;
    }
    rows.push({ reportId, cells: cells.map((cell) => $(cell)) });
  }
  return { headers, rows, emptyStateConfirmed };
}

/**
 * 報告メッセージ欄を、理由本文と差出人へ分ける。管理画面は理由本文の後ろに
 * 差出人の表示名とトリップを連結して描画する。解析層では再通報の内部照合に使うため
 * 分離するが、コネクタの外部応答へは返さない。理由本文へ混ぜると通報理由の表示と
 * 同一性の比較が壊れる。
 *
 * 区切りは差出人ブロックの直前にある`<br>`で、欄の末尾に`<br>`が付く描画でも
 * 差出人より後ろで切らない。`<br>`が無い対処メッセージ欄は`" -- "`に続けて
 * `<strong>`を描画するため、`<strong>`の手前で切ったうえでこの区切り文字も除く。
 * 差出人ブロックが無い欄は全体を本文として扱う。
 */
export function splitReportMessage(nodes = []) {
  const senderIndex = nodes.findIndex((node) => node.tag === "STRONG");
  let cut = -1;
  nodes.forEach((node, index) => {
    if (node.tag !== "BR") return;
    if (senderIndex >= 0 && index > senderIndex) return;
    cut = index;
  });
  if (cut < 0 && senderIndex >= 0) cut = senderIndex;

  const bodyNodes = cut < 0 ? nodes : nodes.slice(0, cut);
  let bodyText = bodyNodes.map((node) => node.text).join("");
  // 実画面の対処メッセージは`本文 -- <strong>管理者</strong>`というDOMになる。
  // `<strong>`だけで切ると区切りが承認本文へ混ざり、完全一致の成功判定が偽になる。
  if (cut === senderIndex && senderIndex >= 0) bodyText = bodyText.replace(/\s+--\s*$/u, "");

  const trip = nodes.find((node) => String(node.cls).split(/\s+/u).includes("user-trip"));
  return {
    text: cleanText(bodyText),
    reporterName: senderIndex >= 0 ? cleanText(nodes[senderIndex].text) : "",
    reporterTrip: trip ? cleanText(trip.text) : "",
  };
}

/** 同一通報者かどうかの照合に使う内部キー。トリップが無い通報者は表示名で照合する。 */
function reporterKey({ reporterTrip, reporterName }) {
  return reporterTrip || reporterName || "";
}

const DETAIL_CREATED_AT = "作成日時";
const DETAIL_LABELS = ["削除済み", "無視", DETAIL_CREATED_AT, "親コメント"];
const REPORT_LABELS = Object.freeze({
  reason: "報告メッセージ",
  createdAt: "通報日時",
  responseMessage: "対処メッセージ",
  respondedAt: "対処日時",
});
const OPEN_REPORT_LABELS = Object.freeze({
  location: "発生箇所",
  reason: "報告メッセージ",
  createdAt: "通報日時",
});
/** 一覧のページ送り。1ページに収まる一覧では描画されない。 */
const PAGINATION_CLASS = "pagination";
/**
 * 未処理一覧をたどるページ数の上限。1ページの件数は管理画面が決めるので、取得件数の
 * 上限だけでは取得回数を抑えられない。1ページが極端に少ない画面でも往復を増やさない。
 */
const MAX_OPEN_REPORT_PAGES = 10;

function mainOf($) {
  const main = $("main").first();
  if (!main.length) {
    throw new ZawazawaConnectorError(
      "page_changed",
      "管理画面の本体を確認できません。管理権限と管理画面の変更を確認してください。",
    );
  }
  return main;
}

function topLevelTables($, root) {
  return root
    .find("table")
    .toArray()
    .filter((element) => $(element).parents("table").length === 0);
}

function cellReader($, headers, cells) {
  return (label) => {
    const index = headers.indexOf(label);
    return index < 0 || !cells[index] ? "" : cellText(cells[index]);
  };
}

/**
 * 通報が一度も無いコメントの管理画面であることを、画面の側の目印で確かめる。
 * ZAWAZAWAは通報のあるコメントにだけ通報表を描画するため、表の不在そのものは
 * 「通報が無い」と「画面が変わった」の両方になりうる。前者だと言い切れるのは次の
 * 2つがそろうときだけにする。
 * ・詳細表の`作成日時`が読める。この画面を想定どおりの形で読めている根拠。
 * ・`data-key`を持つ行が1つも無い。通報行は必ず`data-key`を持つので、見出しだけが
 *   変わった通報表を「表が無い」と読み違えていない根拠。
 */
function hasNoReportSection($) {
  const main = mainOf($);
  if (main.find("tr[data-key]").length) return false;
  return readDetailValues($)[DETAIL_CREATED_AT] !== undefined;
}

/**
 * 表の前に描かれる件数表示（`N件中`）を数として読む。通報表の直前には「すべて完了」欄が
 * 挟まるため、直前の兄弟だけでは件数表示に届かない。さかのぼりは手前の表で打ち切り、
 * 通報者が書いた通報理由の中の数字を件数表示と読み違えない。生の文面は保持せず、
 * 読み取った数だけを返す。
 */
function totalCountBefore(table) {
  for (let node = table.prev(); node.length; node = node.prev()) {
    if (node.is("table")) return undefined;
    const total = parseTotalCount(node.text().trim());
    if (total !== undefined) return total;
  }
  return undefined;
}

/**
 * コメント管理画面の通報表を読む。未処理と処理済みは列で区別する（処理済みだけが
 * 「対処メッセージ」列を持つ）。行の`data-key`は通報ごとに一意で、表示文が同じ通報を
 * 取り違えずに数え、実行直前の再確認で差分を機械的に取るための識別子になる。
 * 表が見つからない画面のうち、通報が無いことを画面の側で確かめられないものは、
 * 0件として扱わず画面変更として止める。0件と未確認を混ぜると通報を見落とす。
 */
function readReportTables($) {
  const tables = [];
  for (const element of topLevelTables($, mainOf($))) {
    const table = $(element);
    const parsed = parseTable($, table);
    if (!parsed.headers.includes(REPORT_LABELS.reason)) continue;
    tables.push({
      ...parsed,
      processed: parsed.headers.includes(REPORT_LABELS.responseMessage),
      // 件数表示（`N件中`）は表の前、ページ送りは表の直後の兄弟要素に出る。
      // どちらも1ページに収まる表では描画されない。
      summaryTotalCount: totalCountBefore(table),
      paginated: table.next().hasClass(PAGINATION_CLASS),
    });
  }

  if (!tables.length) {
    // 通報が一度も無いコメントには表そのものが描画されない。ここを一律に画面変更と
    // すると、通報の無い通常のコメント（投稿履歴のほぼ全件）が未確認になる。
    if (hasNoReportSection($)) {
      return {
        openReports: [],
        closedReports: [],
        openReportsTruncated: false,
        openReportsTotalCount: 0,
      };
    }
    throw new ZawazawaConnectorError(
      "page_changed",
      "コメント管理画面に通報表が無く、通報が無い画面であることも確認できません。未処理通報の有無を判定できないため、0件として扱わないでください。",
    );
  }
  if (tables.filter((table) => !table.processed).length > 1) {
    throw new ZawazawaConnectorError(
      "page_changed",
      "コメント管理画面に未処理通報の表が複数あり、対象を一意に特定できません。",
    );
  }

  const openRows = [];
  const closedRows = [];
  for (const table of tables) {
    for (const row of table.rows) {
      const text = cellReader($, table.headers, row.cells);
      const nodesOf = (label) => {
        const index = table.headers.indexOf(label);
        return index < 0 || !row.cells[index] ? [] : childNodes($, row.cells[index]);
      };
      const reason = splitReportMessage(nodesOf(REPORT_LABELS.reason));
      const response = splitReportMessage(nodesOf(REPORT_LABELS.responseMessage));
      (table.processed ? closedRows : openRows).push({
        reportId: cleanText(row.reportId),
        reason: reason.text,
        reporterName: reason.reporterName || undefined,
        reporterTrip: reason.reporterTrip || undefined,
        reporterKey: reporterKey(reason),
        createdAt: cleanText(text(REPORT_LABELS.createdAt)) || undefined,
        responseMessage: response.text || undefined,
        respondedAt: cleanText(text(REPORT_LABELS.respondedAt)) || undefined,
      });
    }
  }

  // 同じ通報者が、対処メッセージ付きで回答済みの同じコメントを再通報したか。
  const respondedReporters = new Set(
    closedRows
      .filter((row) => row.responseMessage)
      .map((row) => row.reporterKey)
      .filter(Boolean),
  );

  const openTable = tables.find((table) => !table.processed);
  // 件数表示が読めた行より多い画面は、ページ送りを読み取れていなくても読み切れていない。
  // ページ送りの描画だけを打ち切りの根拠にすると、その表示が変わった画面で読めた行を
  // 全部として出してしまう。
  const parsedTotalCount = openTable?.summaryTotalCount;
  const moreThanRead = parsedTotalCount !== undefined && parsedTotalCount > openRows.length;
  // 読めた行がその対象の未処理通報の全部かどうか。1ページに収まらない通報表では、
  // 読めなかった通報を0件と混ぜないためにこの区別が要る。
  const openReportsTruncated = Boolean(openTable?.paginated) || moreThanRead;

  // 照合用のキーは呼び出し側へ渡さない。差出人の実値もこの解析層だけに留め、
  // コネクタ側では`repeatAfterResponse`という判定結果だけを許可する。
  return {
    openReports: openRows.map(
      ({ reporterKey: matchKey, responseMessage, respondedAt, ...row }) => ({
        ...row,
        repeatAfterResponse: Boolean(matchKey) && respondedReporters.has(matchKey),
      }),
    ),
    closedReports: closedRows.map(({ reporterKey: matchKey, ...row }) => row),
    openReportsTruncated,
    // 未処理通報の総件数。読み切れた表では読めた行数がそのまま総件数になり、読み切れて
    // いない表では件数表示が読めた行より多いときにだけ分かる。件数表示が読めない、または
    // 読めた行数と矛盾する画面は`undefined`にする。残りが何件あるかを推測すると、通報の
    // 多さを判断材料にしている管理者へ根拠のない数を出すことになる。
    openReportsTotalCount: openReportsTruncated
      ? moreThanRead
        ? parsedTotalCount
        : undefined
      : openRows.length,
  };
}

export function parseReportTables(html) {
  return readReportTables(loadDocument(html));
}

/**
 * 本文はソース表示欄の原文を優先して読む。管理者が見るものと同じ文面を、
 * 整形による差異なしに扱うため。ソース欄の中身は原文であって描画結果ではないので、
 * `textarea`の値としてそのまま読み、タグ除去はしない。除去すると本文中のHTMLらしき
 * 記述が削れて原文でなくなる。改行のLFへの統一と開始タグ直後の改行の除去は、
 * ブラウザが`textarea`の値を取り出すときと同じ規則で解析器が行う。
 * ソース欄が無い画面では描画済み本文で補う。
 * コメント表示が複数ある画面では対象を取り違えるため、読まずに画面変更として止める。
 */
function readCommentBody($) {
  const views = $(".comment-view");
  if (views.length > 1) {
    throw new ZawazawaConnectorError(
      "page_changed",
      "管理画面に複数のコメント表示があり、対象の本文を一意に特定できません。",
    );
  }
  if (!views.length) return "";
  const view = views.first();

  const source = view.find("textarea.md-code-editor").first();
  if (source.length) {
    const value = cleanText(source.text());
    if (value) return value;
  }
  const rendered = view.find(".panel-body").first();
  if (rendered.length) {
    const value = cleanText(htmlToText(rendered));
    if (value) return value;
  }
  return "";
}

export function parseCommentBody(html) {
  return readCommentBody(loadDocument(html));
}

/** ラベル付きの箇条書きから値を読む。 */
function readLabeledListValue($, label) {
  const prefix = `${label}:`;

  const views = $(".comment-view");
  if (views.length !== 1) return undefined;

  // 現行画面の接続元欄は、コメント表示の直下にある管理メタデータ列へ置かれる。
  // `.comment-view`全体を探索すると投稿本文の偽ラベルを拾えるため、管理画面が生成する
  // `row > col > small > ul.list-inline > li`の直下関係だけを候補にする。
  const metadataItems = views
    .first()
    .children(".row:not(.moderator-operations)")
    .children('[class*="col-"]')
    .children("small")
    .children("ul.list-inline")
    .children("li")
    .toArray();
  const currentMatches = metadataItems.filter((element) => {
    const text = $(element).text().replace(/\s+/gu, " ").trim();
    return text.startsWith(prefix);
  });
  if (currentMatches.length === 1) {
    const text = $(currentMatches[0]).text().replace(/\s+/gu, " ").trim();
    return text.slice(prefix.length).trim();
  }

  // 旧画面では同じ欄が`.comment-view`外の箇条書きにあった。現行構造を一意に
  // 読めない場合は混在を推測せず止め、現行候補が無い場合だけ旧構造を読む。
  if (currentMatches.length > 1) return undefined;
  const legacyMatches = mainOf($)
    .find("li")
    .toArray()
    .filter((entry) => !$(entry).parents(".comment-view, table").length)
    .filter((element) => {
      const text = $(element).text().replace(/\s+/gu, " ").trim();
      return text.startsWith(prefix);
    });
  if (legacyMatches.length === 1) {
    const text = $(legacyMatches[0]).text().replace(/\s+/gu, " ").trim();
    return text.slice(prefix.length).trim();
  }
  return undefined;
}

export function parseLabeledListValue(html, label) {
  return readLabeledListValue(loadDocument(html), label);
}

function readDetailValues($) {
  const found = {};
  for (const tableElement of topLevelTables($, mainOf($))) {
    for (const element of directTableRows($, $(tableElement))) {
      const row = $(element);
      const header = row.children("th").first();
      if (!header.length) continue;
      const label = cellText(header);
      if (!DETAIL_LABELS.includes(label) || label in found) continue;
      const value = row.children("td").first();
      found[label] = value.length ? cellText(value) : undefined;
    }
  }
  return found;
}

const PUBLIC_COMMENT_PATH = /^\/([^/]+)\/topic\/([1-9][0-9]*)\/([1-9][0-9]*)$/u;

/**
 * 管理画面UIが生成したヘッダーだけを信頼領域として特定する。`.comment-view`は管理
 * ヘッダーと投稿者が制御する本文の両方を含むため、`.comment-view`全体を除外すると
 * 管理ヘッダーまで読めず、`.comment-view`の子孫を無条件に読むと本文中のリンクを
 * 管理画面側の証拠と誤認する。直接の子である`.forum-management-header`に限れば、
 * 本文に似たクラスが現れても混ざらない。一意に特定できない画面では信頼しない。
 * `.comment-view`の一意性は本文読み取り（`readCommentBody`）と同じ範囲で数える。
 */
function trustedManagementHeader($) {
  const views = $(".comment-view");
  if (views.length !== 1) return null;
  const header = views.first().children(".forum-management-header");
  return header.length === 1 ? header : null;
}

/**
 * 管理ヘッダー内の公開投稿URLが指す対象を集める。クエリとフラグメントは対象の
 * 同一性を変えないため、pathnameだけで対象を判定する。投稿者が制御する描画領域の
 * リンクは、ヘッダー内に入れ子になっていても使わない。
 */
function headerPublicTargets($, header) {
  const expectedOrigin = new URL(BASE_URL).origin;
  const targets = new Set();
  for (const element of header.find("a[href]").toArray()) {
    if ($(element).parents(".panel-body, textarea.md-code-editor").length) continue;
    let url;
    try {
      url = new URL($(element).attr("href"), BASE_URL);
    } catch {
      continue;
    }
    if (url.origin !== expectedOrigin) continue;
    const match = PUBLIC_COMMENT_PATH.exec(url.pathname.replace(/\/$/u, ""));
    if (match) targets.add(`${match[1]}/${match[2]}/${match[3]}`);
  }
  return targets;
}

/**
 * 画面が対象コメントの管理画面であることを、リダイレクト後の管理URLで確かめる。
 * 見出し文言は表示仕様の変更を受けやすいため使わない。
 *
 * 公開投稿URLは管理画面の表示要素であって、その有無や件数が対象コメントの同一性を
 * 変えるわけではない。存在を必須にすると、位置や構造の変更だけで対象が正しくても
 * 読めなくなる。そのため必須の存在証明とはせず、信頼できる管理ヘッダーを特定できた
 * ときだけ、別対象を指すリンクの有無を矛盾検出として見る。
 */
export function assertCommentDetailPage($, { groupKey, topicNumber, commentNumber, finalUrl }) {
  let finalPath = "";
  try {
    finalPath = new URL(finalUrl, BASE_URL).pathname.replace(/\/$/u, "");
  } catch {
    // 下の再認証エラーへまとめる。
  }
  const expectedPath = `/m/${groupKey}/comment/${topicNumber}/${commentNumber}`;
  const commentPath = /^\/m\/[^/]+\/comment\/([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(finalPath);

  if (!commentPath) {
    throw new ZawazawaConnectorError(
      "reauth_required",
      `ZAWAZAWA専用認証プロファイルの再認証が必要です。これはコネクタの利用不能ではありません。手動検索へ切り替えず、プラグインディレクトリで「npm run auth:zawazawa -- ${groupKey}」を実行し、専用ブラウザで対象グループのコメント管理画面を確認してから再試行してください。`,
    );
  }

  if (
    finalPath !== expectedPath ||
    commentPath[1] !== topicNumber ||
    commentPath[2] !== commentNumber
  ) {
    throw new ZawazawaConnectorError(
      "page_changed",
      `対象コメント ${topicNumber}/${commentNumber} と管理画面URLが一致しません。別対象を読み取らずに中止しました。`,
    );
  }

  const header = trustedManagementHeader($);
  if (!header) return;
  const expectedTarget = `${groupKey}/${topicNumber}/${commentNumber}`;
  for (const target of headerPublicTargets($, header)) {
    // 同じ対象のリンクが何本あっても曖昧ではない。件数ではなく、別対象の混在だけを見る。
    if (target === expectedTarget) continue;
    const [, otherTopic, otherComment] = target.split("/");
    throw new ZawazawaConnectorError(
      "page_changed",
      `対象コメント ${topicNumber}/${commentNumber} の管理画面が別対象 ${otherTopic}/${otherComment} の投稿URLを表示しています。別対象を読み取らずに中止しました。`,
    );
  }
}

function readCommentDetail(
  $,
  { groupKey, topicNumber, commentNumber, finalUrl },
  { includeReports = true } = {},
) {
  assertCommentDetailPage($, { groupKey, topicNumber, commentNumber, finalUrl });

  const body = readCommentBody($);
  if (!body) {
    throw new ZawazawaConnectorError(
      "page_changed",
      `投稿 ${commentNumber} の本文を確認できません。`,
    );
  }

  // 通報表の失敗で本文の解決まで巻き込まない。本文だけが要る投稿履歴は読み進められ、
  // 通報が要る処置対象だけが`reportsError`を見た呼び出し側で止まる。
  let reports = {};
  if (includeReports) {
    try {
      reports = readReportTables($);
    } catch (error) {
      const failure =
        error instanceof ZawazawaConnectorError
          ? error
          : new ZawazawaConnectorError("unknown", "通報表を読み取れませんでした。");
      reports = { error: { code: failure.code, message: failure.message } };
    }
  }

  const values = readDetailValues($);
  const parent = values["親コメント"];
  const currentState =
    values["削除済み"] === "はい"
      ? "削除済み"
      : values["無視"] === "はい"
        ? "投稿時に自動無視"
        : values["削除済み"] === "いいえ" && values["無視"] === "いいえ"
          ? "公開中"
          : undefined;
  return {
    commentNumber,
    topicNumber,
    body,
    createdAt: values["作成日時"] ? cleanText(values["作成日時"]) : undefined,
    // 状態欄を読めない場合は公開中と推測しない。undefinedは未確認であり公開中ではない。
    currentState,
    parentCommentNumber:
      parent && parent !== "トップレベル" ? cleanText(parent) : undefined,
    publicUrl: publicCommentUrl({ groupKey, topicNumber, commentNumber }),
    ...(includeReports
      ? {
          // 読めなかった場合は`undefined`にする。空配列にすると0件と未確認が混ざる。
          openReports: reports.openReports,
          closedReports: reports.closedReports,
          openReportsTruncated: reports.openReportsTruncated,
          openReportsTotalCount: reports.openReportsTotalCount,
          ...(reports.error ? { reportsError: reports.error } : {}),
        }
      : {}),
  };
}

export function parseCommentDetail(html, reference) {
  // 同じ画面を経路ごとに読み直さない。木は一度だけ組む。
  return readCommentDetail(loadDocument(html), reference);
}

export function parseTotalCount(summary) {
  const match = summary.match(/([0-9,]+)\s*件中/u);
  return match ? Number(match[1].replace(/,/gu, "")) : undefined;
}

/**
 * 未処理の1ページ分を読む。グループ管理画面ホームの「通報」表はグループ自体への通報で
 * あり、コメント通報の件数を示さない。開いている表がコメント通報であることは
 * `発生箇所`列で確認し、確認できない画面の0件を未処理なしの根拠にしない。
 * 通報と対象コメントの対応付けは、表示文ではなく行のリンク先から取る。
 *
 * 一覧は表の前後に件数表示とページ送りを描画し、1ページに収まる一覧では両方を出さない。
 * 総件数とページ送りの有無を返し、全件を読めたかどうかの判定は呼び出し側が行う。
 */
function readOpenReportsPage(html, { groupKey, limit }) {
  const $ = loadDocument(html);
  const main = mainOf($);

  const tabs = main
    .find("a[href]")
    .toArray()
    .map((element) => $(element).attr("href"));
  if (!tabs.includes(`/m/${groupKey}/abuse/open`)) {
    throw new ZawazawaConnectorError(
      "reauth_required",
      `ZAWAZAWA専用認証プロファイルの再認証が必要です。手動検索へ切り替えず、プラグインディレクトリで「npm run auth:zawazawa -- ${groupKey}」を実行し、専用ブラウザで対象グループの通報一覧を確認してから再試行してください。`,
    );
  }

  const tables = [];
  for (const element of topLevelTables($, main)) {
    const table = $(element);
    const parsed = parseTable($, table);
    if (!parsed.headers.includes(OPEN_REPORT_LABELS.location)) continue;
    // 件数表示（`N件中`）は表の直前、ページ送りは表の直後の兄弟要素に出る。
    tables.push({
      ...parsed,
      summary: table.prev().text().trim(),
      paginated: table.next().hasClass(PAGINATION_CLASS),
    });
  }
  if (tables.length !== 1) {
    throw new ZawazawaConnectorError(
      "page_changed",
      "コメント通報の未処理一覧（`発生箇所`列を持つ表）を一意に特定できません。グループ自体への通報表と取り違えないため、この画面の0件を未処理なしの根拠にしないでください。",
    );
  }

  const [table] = tables;
  const pattern = new RegExp(`^/m/${groupKey}/comment/([1-9][0-9]*)/([1-9][0-9]*)$`, "u");
  const reports = [];
  for (const row of table.rows) {
    const text = cellReader($, table.headers, row.cells);
    const locationCell = row.cells[table.headers.indexOf(OPEN_REPORT_LABELS.location)];
    const href = locationCell ? locationCell.find("a").first().attr("href") || "" : "";
    const match = href.match(pattern);
    if (!match) {
      throw new ZawazawaConnectorError(
        "page_changed",
        "未処理通報の発生箇所からコメント管理URLを読み取れません。表示文から対象を推測しないでください。",
      );
    }
    const request = { groupKey, topicNumber: match[1], commentNumber: match[2] };
    const reasonIndex = table.headers.indexOf(OPEN_REPORT_LABELS.reason);
    const reason = splitReportMessage(
      reasonIndex < 0 || !row.cells[reasonIndex] ? [] : childNodes($, row.cells[reasonIndex]),
    );
    reports.push({
      reportId: cleanText(row.reportId),
      topicNumber: request.topicNumber,
      commentNumber: request.commentNumber,
      reason: reason.text,
      reporterName: reason.reporterName || undefined,
      reporterTrip: reason.reporterTrip || undefined,
      createdAt: cleanText(text(OPEN_REPORT_LABELS.createdAt)) || undefined,
    });
    if (reports.length >= limit) break;
  }

  const parsedTotalCount = parseTotalCount(table.summary);
  if (
    (table.emptyStateConfirmed && table.rows.length > 0) ||
    (table.emptyStateConfirmed && parsedTotalCount !== undefined && parsedTotalCount !== 0) ||
    (parsedTotalCount !== undefined && parsedTotalCount < table.rows.length)
  ) {
    throw new ZawazawaConnectorError(
      "page_changed",
      "未処理通報一覧の件数表示または空表示が、読み取った通報行と一致しません。",
    );
  }
  // 件数表示とページ送りは対で描画される。片方だけの画面は一覧の描画が変わった合図
  // なので、残りが何件あるか分からないまま読み進めない。
  if (table.paginated && parsedTotalCount === undefined) {
    throw new ZawazawaConnectorError(
      "page_changed",
      "未処理通報一覧にページ送りがあるのに件数表示を読み取れません。残件を確認できないため中止しました。",
    );
  }

  // 正規の空表示は、件数要約が無い0件画面でも0件を肯定できる標識になる。ページ送りが
  // 無い一覧はその1ページで終わるので、件数表示が無くても読んだ行数が総件数になる。
  // 行が無い画面はこれで0件を導かない。行を読めなかった画面と区別できないため。
  const rowCountIsTotal = !table.paginated && table.rows.length > 0;
  const totalCount = table.emptyStateConfirmed
    ? 0
    : (parsedTotalCount ?? (rowCountIsTotal ? table.rows.length : undefined));
  // `0件中`という件数だけでは、行を読めなかった画面と正規の0件画面を
  // 区別できない。行が無いときは正規の空表示も必須とし、欠ける画面を
  // `complete`にしない。
  return {
    reports,
    totalCount,
    emptyStateUnconfirmed: table.rows.length === 0 && !table.emptyStateConfirmed,
    paginated: table.paginated,
  };
}

/**
 * 読み終えた通報と総件数から完全性を決める。総件数を確認できない画面と、上限や
 * ページ数の打ち切りで残りがある場合を、`complete`と混ぜない。
 */
function summarizeOpenReports({ reports, totalCount, emptyStateUnconfirmed }) {
  const completeness =
    totalCount === undefined || (emptyStateUnconfirmed && totalCount === 0)
      ? "unknown"
      : reports.length < totalCount
        ? "partial"
        : "complete";
  const incompleteReason =
    completeness === "partial"
      ? {
          code: "more_reports_available",
          returnedCount: reports.length,
          totalCount,
        }
      : completeness === "unknown"
        ? {
            code:
              emptyStateUnconfirmed && totalCount === 0
                ? "canonical_empty_state_unconfirmed"
                : "total_count_unconfirmed",
            returnedCount: reports.length,
            ...(totalCount !== undefined ? { totalCount } : {}),
          }
        : undefined;
  return {
    reports,
    totalCount,
    totalCountConfirmed: totalCount !== undefined,
    completeness,
    ...(incompleteReason ? { incompleteReason } : {}),
    truncated: completeness !== "complete",
  };
}

/** 1ページだけを読んで完全性まで決める経路。ページ送りのある一覧では`partial`になる。 */
export function parseOpenReportsPage(html, { groupKey, limit }) {
  return summarizeOpenReports(readOpenReportsPage(html, { groupKey, limit }));
}

/**
 * コメント検索の結果から参照を読む。クイック検索は`q`だけを持つGETフォームなので、
 * 画面操作ではなくURLで同じ絞り込みを行う。フォームの有無は確認する。
 * 適用されたか判定できない画面の結果を、絞り込み済みとして扱わないため。
 */
export function parseSearchReferences(html, { groupKey, limit }) {
  const $ = loadDocument(html);
  const main = mainOf($);
  const searchInputs = main.find('input[name="q"][placeholder="クイック検索..."]');
  if (searchInputs.length !== 1) {
    throw new ZawazawaConnectorError(
      "page_changed",
      "コメントのクイック検索を確認できません。管理権限と管理画面の変更を確認してください。",
    );
  }

  // 参照は`href`の完全一致だけを採る。前方一致で拾うとクエリ付きリンクや
  // 別画面へのリンクが混ざり、検索結果でないものを履歴として数えてしまう。
  const pattern = new RegExp(`^/m/${groupKey}/comment/([1-9][0-9]*)/([1-9][0-9]*)$`, "u");
  const references = [];
  const seen = new Set();
  for (const element of main.find("table a[href]").toArray()) {
    const match = ($(element).attr("href") || "").match(pattern);
    if (!match) continue;
    const key = `${match[1]}/${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ topicNumber: match[1], commentNumber: match[2] });
    if (references.length >= limit) break;
  }
  return references;
}

/**
 * 申告された本文長が上限を超えている応答を、本文を読む前に断る。
 * 長さを申告しない応答（chunked等）は不明として通し、読み切った後のバイト数で見る。
 */
export function assertDeclaredLengthWithinLimit(headers) {
  const declared = Number(headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ZawazawaConnectorError(
      "page_changed",
      "管理画面の応答が想定より大きすぎます。読み取らずに中止しました。",
    );
  }
}

/**
 * 認証済みコンテキストのCookieを共有したままHTTPで取得する。描画もJS実行も行わない。
 * ZAWAZAWAは`HeadlessChrome`を含むUser-Agentをこの経路でもHTTP 403で拒むため、
 * 呼び出し元のコンテキストは`ZAWAZAWA_USER_AGENT`を名乗る（zawazawa-connector.mjs）。
 */
export function createAdminReader(options = {}) {
  const requestContext = options.requestContext;
  const baseUrl = options.baseUrl || BASE_URL;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const requestLimiter = options.requestLimiter;

  async function unrestrictedRequest(url) {
    let response;
    try {
      response = await requestContext.get(url, { timeout: timeoutMs });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      if (/timeout/iu.test(message)) {
        throw new ZawazawaConnectorError(
          "timed_out",
          `ZAWAZAWA管理画面が${timeoutMs}ミリ秒以内に応答しませんでした。間隔を置いて再試行してください。`,
        );
      }
      throw new ZawazawaConnectorError(
        "unknown",
        "ZAWAZAWA管理画面を取得できませんでした。接続状態を確認して再試行してください。",
      );
    }

    const status = response.status();
    if (status === 403) {
      throw new ZawazawaConnectorError(
        "blocked",
        `ZAWAZAWAが自動アクセスをHTTP ${status}で拒否しました。再認証でも設定変更でも解消しません。管理画面を直接読み取ってください。`,
      );
    }
    if (status === 429 || status === 503) {
      throw new ZawazawaConnectorError(
        "rate_limited",
        `ZAWAZAWAがHTTP ${status}を返しました。一時的な制限または保守中です。再認証でも手動検索でも解消しないため、間隔を置いて再試行してください。`,
      );
    }
    // 404とその他の非2xxを画面変更や認証切れと取り違えない。消えたコメントと
    // 再認証が要る状態は復旧手段が異なる。
    if (status === 404) {
      throw new ZawazawaConnectorError(
        "not_found",
        "管理画面に該当の対象がありません。コメントまたはグループが存在しない可能性があります。",
      );
    }
    if (status < 200 || status >= 300) {
      throw new ZawazawaConnectorError(
        "unknown",
        `ZAWAZAWA管理画面がHTTP ${status}を返しました。`,
      );
    }

    assertDeclaredLengthWithinLimit(response.headers?.());
    const text = await response.text();
    // 文字数ではなくUTF-8のバイト数で数える。日本語の管理画面では文字数の3倍近い
    // バイト数になり、文字数で数えると実効上限が契約値から大きくずれる。
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new ZawazawaConnectorError(
        "page_changed",
        "管理画面の応答が想定より大きすぎます。読み取らずに中止しました。",
      );
    }
    return { html: text, finalUrl: response.url() };
  }

  function request(url) {
    const read = () => unrestrictedRequest(url);
    return requestLimiter ? requestLimiter.run(read) : read();
  }

  return {
    /**
     * 対象コメントの管理画面をそのまま返す。同じ取得から詳細と操作リンクの両方を
     * 読む送信経路が使う。返す文字列はこのモジュールの取得規則を通っている。
     */
    async readCommentPage(reference) {
      return request(adminCommentUrl(reference));
    },

    async readCommentDetail(reference) {
      const { html, finalUrl } = await request(adminCommentUrl(reference));
      return parseCommentDetail(html, { ...reference, finalUrl });
    },

    /** 投稿履歴に不要な通報表を読まず、本文・日時・状態・親だけを返す。 */
    async readAuthorCommentDetail(reference) {
      const { html, finalUrl } = await request(adminCommentUrl(reference));
      return readCommentDetail(loadDocument(html), { ...reference, finalUrl }, {
        includeReports: false,
      });
    },

    /** 投稿履歴の対象詳細と内部検索キーを、同じ対象ページの一度の取得から読む。 */
    async readCommentDetailAndHost(reference) {
      const { html, finalUrl } = await request(adminCommentUrl(reference));
      const $ = loadDocument(html);
      const targetComment = readCommentDetail($, { ...reference, finalUrl }, {
        includeReports: false,
      });
      return {
        targetComment,
        // この値はコネクタ内部の検索にだけ使い、ツール応答へ含めない。
        hostValue: readLabeledListValue($, "ホスト"),
      };
    },

    async readHostValue(reference) {
      const { html, finalUrl } = await request(adminCommentUrl(reference));
      const $ = loadDocument(html);
      assertCommentDetailPage($, { ...reference, finalUrl });
      return readLabeledListValue($, "ホスト");
    },

    /**
     * 未処理一覧を、取得件数の上限に達するまでページ送りをたどって読む。1ページの件数は
     * 管理画面が決めるため、上限を上げるだけでは2ページ目以降が読めない。ページ番号は
     * 画面のリンクをたどらず自分で組み立て、同じ通報が二重に入らないよう`reportId`で
     * 重複を落とす。
     *
     * 読み進める途中で通報が処理されると一覧が繰り上がり、まだ読んでいない行が読み終えた
     * ページ側へ移って抜け落ちる。このとき総件数も同じだけ減るため、最後に読んだページの
     * 件数と比べると抜けたぶんがちょうど埋まって`complete`になる。総件数は読んだページの
     * 最大値を採り、読めた件数がそこに届かない一覧を`complete`にしない。
     */
    async readOpenReports({ groupKey, limit }) {
      const reports = [];
      const seenReportIds = new Set();
      let totalCount;
      let page = 1;
      let lastPage;
      for (;;) {
        const url = `${baseUrl}/m/${groupKey}/abuse/open${page === 1 ? "" : `?page=${page}`}`;
        const { html } = await request(url);
        lastPage = readOpenReportsPage(html, { groupKey, limit: limit - reports.length });
        if (lastPage.totalCount !== undefined) {
          totalCount = Math.max(lastPage.totalCount, totalCount ?? 0);
        }
        let added = 0;
        for (const report of lastPage.reports) {
          if (seenReportIds.has(report.reportId)) continue;
          seenReportIds.add(report.reportId);
          reports.push(report);
          added += 1;
        }
        // 1件も増えない画面は、ページ番号が効いていない合図でもある。同じ画面を
        // 読み続けないため、残件があってもここで打ち切る。読み終わりの判定には最大値
        // ではなく今の画面の件数を使い、今ある一覧の末尾より先を要求しない。
        if (
          !lastPage.paginated ||
          added === 0 ||
          reports.length >= limit ||
          page >= MAX_OPEN_REPORT_PAGES ||
          (lastPage.totalCount !== undefined && reports.length >= lastPage.totalCount)
        ) {
          break;
        }
        page += 1;
      }
      return summarizeOpenReports({
        reports,
        totalCount,
        emptyStateUnconfirmed: lastPage.emptyStateUnconfirmed,
      });
    },

    async searchCommentReferences({ groupKey, hostValue, limit }) {
      const url = `${baseUrl}/m/${groupKey}/comment?q=${encodeURIComponent(hostValue)}`;
      const { html, finalUrl } = await request(url);
      let appliedUrl;
      let expectedOrigin;
      try {
        appliedUrl = new URL(finalUrl);
        expectedOrigin = new URL(baseUrl).origin;
      } catch {
        // 下の固定文エラーへまとめ、内部検索値や応答URLを外へ出さない。
      }
      const appliedQueries = appliedUrl?.searchParams.getAll("q") || [];
      if (
        !appliedUrl ||
        appliedUrl.origin !== expectedOrigin ||
        appliedUrl.pathname !== `/m/${groupKey}/comment` ||
        appliedQueries.length !== 1 ||
        appliedQueries[0] !== hostValue
      ) {
        throw new ZawazawaConnectorError(
          "page_changed",
          "コメントのクイック検索が指定した条件で適用されたことを確認できません。検索結果を投稿履歴として扱わずに中止しました。",
        );
      }
      return parseSearchReferences(html, { groupKey, limit });
    },
  };
}
