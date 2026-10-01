import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AUTHOR_COMMENT_FIELDS,
  OPEN_REPORT_FIELDS,
  OPEN_REPORT_LIST_FIELDS,
  authContextOptions,
  createZawazawaConnector,
  launchAuthContext,
  normalizeHistoryRequest,
  persistentContextOptions,
  readCommentDetails,
  splitReportMessage,
} from "../server/zawazawa-connector.mjs";
import {
  createAdminReader,
  MAX_RESPONSE_BYTES,
  parseCommentBody,
  parseOpenReportsPage,
  parseReportTables,
  parseSearchReferences,
} from "../server/admin-reader.mjs";
import { ZAWAZAWA_USER_AGENT, ZawazawaConnectorError } from "../server/identifiers.mjs";
import { createPublicReader } from "../server/public-reader.mjs";
import { createRequestLimiter } from "../server/request-limiter.mjs";

/**
 * フィクスチャは実物と同じHTML文字列で書く。解析規則そのものを検証するため、
 * DOMを模したオブジェクトへ置き換えない。
 */
function documentOf(mainHtml) {
  return `<!doctype html><html><head><title>t</title></head><body><main>${mainHtml}</main></body></html>`;
}

/**
 * 一覧の骨組みは実画面に合わせる。件数表示は表の前、ページ送りは表の直後に置かれ、
 * 1ページに収まる一覧ではどちらも描画されない。コメント管理画面の通報表では、件数表示と
 * 表の間に「すべて完了」欄が入る（`beforeTable`）。この欄を省いたフィクスチャは、
 * 件数表示を表の直前の兄弟としてしか読めない実装を通してしまう。
 */
function tableHtml({ headers, rows = [], summary = "", paginated = false, beforeTable = "" }) {
  const head = `<tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr>`;
  const body = rows
    .map((row) => {
      const key = row.key ? ` data-key="${row.key}"` : "";
      return `<tr${key}>${row.cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
    })
    .join("");
  const pagination = paginated
    ? '<ul class="pagination"><li><a href="?page=1">1</a></li><li><a href="?page=2">2</a></li></ul>'
    : "";
  return `${summary ? `<p class="summary">${summary}</p>` : ""}${beforeTable}<table>${head}${body}</table>${pagination}`;
}

/** 報告メッセージ欄の描画。本文の後ろに差出人ブロックが連結される。 */
function messageCell({ text = "", sender } = {}) {
  if (!sender) return text;
  const trip = sender.trip ? `<span class="user-trip">${sender.trip}</span>` : "";
  const separator = sender.noBreak ? "" : "<br>";
  return `${text}${separator}${sender.prefix ?? ""}<strong>${sender.name}</strong>${trip}`;
}

const EMPTY_REPORT_TABLE = { headers: ["報告メッセージ", "通報日時", ""], rows: [] };

/** 実画面では通報が1件以上あるとき、件数表示と通報表の間に「すべて完了」欄が入る。 */
const CLOSE_ALL_ABUSE_HTML =
  '<div class="pull-right"><a class="close-all-abuse" href="/m/g/comment/413/669/close-all-abuse">すべて完了</a></div>';

/**
 * コメント詳細の骨組みは実画面のDOM階層に合わせる。公開投稿URLは管理画面が生成する
 * `div.comment-view > div.forum-management-header`の中にあり、投稿本文と同じ
 * `.comment-view`を親に持つ。この入れ子を平らにすると、本文と管理UIの境界を扱う
 * 実装の誤りをフィクスチャが隠す。
 */
function detailDocument({
  heading = "コメント 669",
  managementHeader = true,
  publicHrefs = ["/g/topic/413/669"],
  extraViewHtml = "",
  metadataItems = [],
  source,
  rendered,
  values = {},
  views = 1,
  reportTables = [EMPTY_REPORT_TABLE],
} = {}) {
  const headerHtml = managementHeader
    ? `<div class="forum-management-header"><p>${publicHrefs
        .map((href) => `<a href="${href}">${href}</a>`)
        .join("")}</p></div>`
    : "";
  const view =
    headerHtml +
    `<div class="row"><div class="col-md-7">` +
    (metadataItems.length
      ? `<small><ul class="list-inline">${metadataItems
          .map(([label, value]) => `<li>${label}:&nbsp;${value}</li>`)
          .join("")}</ul></small>`
      : "") +
    extraViewHtml +
    [
      source === undefined ? "" : `<textarea class="md-code-editor">${source}</textarea>`,
      rendered === undefined ? "" : `<div class="panel-body">${rendered}</div>`,
    ].join("") +
    `</div><div class="col-md-5"></div></div>`;
  const views_ = Array.from(
    { length: views },
    () => `<div class="panel comment-view">${view}</div>`,
  ).join("");
  const detailRows = Object.entries(values)
    .map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`)
    .join("");
  return documentOf(
    `<h1>${heading}</h1>${views_}<table>${detailRows}</table>` +
      reportTables
        .map((table) =>
          tableHtml({
            ...table,
            beforeTable: (table.rows || []).length ? CLOSE_ALL_ABUSE_HTML : "",
          }),
        )
        .join(""),
  );
}

function searchDocument(links = []) {
  const input = '<form method="get" action="/m/g/comment"><input name="q" placeholder="クイック検索..."><button>検索</button></form>';
  const rows = links.map((href) => `<tr><td><a href="${href}">表示</a></td></tr>`).join("");
  return documentOf(`${input}<table>${rows}</table>`);
}

function openReportsDocument({ groupKey = "g", tables = [], tabs = [`/m/${groupKey}/abuse/open`] } = {}) {
  const tabHtml = tabs.map((href) => `<a href="${href}">通報</a>`).join("");
  return documentOf(tabHtml + tables.map(tableHtml).join(""));
}

/** 取得層の差し替え。ネットワークへは出ない。 */
function fakeRequestContext(routes) {
  const calls = [];
  const bodyReads = [];
  return {
    calls,
    bodyReads,
    async get(url, options) {
      calls.push({ url, options });
      const route = typeof routes === "function" ? routes(url) : routes[url];
      if (route === undefined) throw new Error(`未定義のURL: ${url}`);
      if (route.throws) throw route.throws;
      return {
        status: () => route.status ?? 200,
        url: () => route.finalUrl ?? url,
        headers: () => route.headers ?? {},
        text: async () => {
          bodyReads.push(url);
          return route.html ?? "";
        },
      };
    },
  };
}

function fakeBrowserType(requestContext, options = {}) {
  return {
    launched: [],
    closed: 0,
    async launchPersistentContext(directory, launchOptions) {
      this.launched.push({ directory, launchOptions });
      if (options.throws) throw options.throws;
      const browserType = this;
      return {
        request: requestContext,
        async close() {
          browserType.closed += 1;
        },
      };
    },
  };
}

const DETAIL_URL = "https://z.wikiwiki.jp/m/g/comment/413/669";

test("履歴取得要求を正規化し、件数は呼び出しの指定をそのまま使う", () => {
  assert.deepEqual(
    normalizeHistoryRequest({
      groupKey: " g ",
      topicNumber: "413",
      commentNumber: "669",
      limit: 10,
    }),
    { groupKey: "g", topicNumber: "413", commentNumber: "669", limit: 10 },
  );
});

test("不正な識別子と件数をinvalid_inputとして拒否する", () => {
  const cases = [
    { groupKey: "G!", topicNumber: "1", commentNumber: "1", limit: 10 },
    { groupKey: "g", topicNumber: "0", commentNumber: "1", limit: 10 },
    { groupKey: "g", topicNumber: "1", commentNumber: "x", limit: 10 },
    { groupKey: "g", topicNumber: "1", commentNumber: "1" },
    { groupKey: "g", topicNumber: "1", commentNumber: "1", limit: 0 },
    { groupKey: "g", topicNumber: "1", commentNumber: "1", limit: 21 },
  ];
  for (const input of cases) {
    assert.throws(
      () => normalizeHistoryRequest(input),
      (error) => error instanceof ZawazawaConnectorError && error.code === "invalid_input",
    );
  }
});

test("認証用と履歴取得用のどちらでもサンドボックスを無効にできない", () => {
  assert.equal(persistentContextOptions({ chromiumSandbox: false }).chromiumSandbox, true);
});

test("既定ではヘッドレスで起動し、環境変数でだけ表示ありへ戻す", () => {
  const previous = process.env.ZAWAZAWA_CONNECTOR_HEADLESS;
  delete process.env.ZAWAZAWA_CONNECTOR_HEADLESS;
  assert.equal(persistentContextOptions().headless, true);
  process.env.ZAWAZAWA_CONNECTOR_HEADLESS = "0";
  assert.equal(persistentContextOptions().headless, false);
  if (previous === undefined) delete process.env.ZAWAZAWA_CONNECTOR_HEADLESS;
  else process.env.ZAWAZAWA_CONNECTOR_HEADLESS = previous;
});

test("ヘッドレス起動でも`HeadlessChrome`を名乗らないUser-Agentを渡す", () => {
  const userAgent = persistentContextOptions().userAgent;
  assert.equal(userAgent, ZAWAZAWA_USER_AGENT);
  assert.doesNotMatch(userAgent, /Headless/iu);
});

// 認証窓が名乗る値は起動設定を共有する側で決める。ここが読み取りと同じUser-Agentを
// 名乗り始めても画面上は変わらないため、意図を残せるのはこのテストだけになる。
test("人が認証する画面はブラウザ自身のUser-Agentのまま表示ありで開く", () => {
  const options = authContextOptions();
  assert.equal(options.headless, false);
  assert.equal(options.userAgent, undefined);
  assert.equal(options.viewport, null);
  assert.equal(options.chromiumSandbox, true);
});

test("認証用の起動も同じ設定を使い、起動失敗を対処の分かる文言へ写す", async () => {
  const browserType = fakeBrowserType(fakeRequestContext({}));
  await launchAuthContext(browserType);
  assert.deepEqual(browserType.launched[0].launchOptions, authContextOptions());

  const locked = fakeBrowserType(fakeRequestContext({}), {
    throws: new Error(
      "browserType.launchPersistentContext: Failed to create SingletonLock: File exists",
    ),
  });
  await assert.rejects(
    launchAuthContext(locked),
    (error) => error.code === "profile_locked" && error.message.includes("ホストを終了"),
  );
});

test("手元のChromeではなくPlaywright同梱ブラウザを使う", () => {
  assert.equal("channel" in persistentContextOptions(), false);
});

// `channel`を外した分は導入側が埋める。片方だけが残ると、新しい環境では起動できない。
test("同梱ブラウザの本体を`npm install`で入れる", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(manifest.scripts.postinstall, /playwright-core install chromium/u);
});

test("コネクタの起動設定にサンドボックスと名乗るUser-Agentが渡る", async () => {
  const request = fakeRequestContext({ [DETAIL_URL]: { html: detailDocument({ source: "本文" }) } });
  const browserType = fakeBrowserType(request);
  const connector = createZawazawaConnector({ browserType, profileDirectory: "/tmp/profile" });
  await connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" });
  assert.equal(browserType.launched[0].directory, "/tmp/profile");
  assert.equal(browserType.launched[0].launchOptions.chromiumSandbox, true);
  // 読み取り経路が実際に名乗る値を、起動設定の単体ではなく起動そのもので押さえる。
  // コネクタが上書きを足せば、`persistentContextOptions`が正しくてもここで落ちる。
  assert.equal(browserType.launched[0].launchOptions.userAgent, ZAWAZAWA_USER_AGENT);
});

test("プロファイル使用中の起動失敗をprofile_lockedとして返す", async () => {
  const browserType = fakeBrowserType(fakeRequestContext({}), {
    throws: new Error("SingletonLock: profile is in use"),
  });
  const connector = createZawazawaConnector({ browserType });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "profile_locked",
  );
});

test("同梱ブラウザの本体が無い起動失敗は入れ直す手順を返す", async () => {
  const browserType = fakeBrowserType(fakeRequestContext({}), {
    throws: new Error(
      "browserType.launchPersistentContext: Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ),
  });
  const connector = createZawazawaConnector({ browserType });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "unknown" && /npm install/u.test(error.message),
  );
});

// どちらの起動失敗も、文言は閉じてから、または入れ直してからの再試行を指す。失敗した
// コンテキストを掴んだままだと、その再試行が同じ失敗を返し、ホストの再起動でしか直らない。
test("起動に失敗したコンテキストを残さず、次の呼び出しで開き直す", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: { html: detailDocument({ source: "本文" }) },
  });
  const options = { throws: new Error("SingletonLock: profile is in use") };
  const browserType = fakeBrowserType(request, options);
  const connector = createZawazawaConnector({ browserType });
  const target = { groupKey: "g", topicNumber: "413", commentNumber: "669" };
  await assert.rejects(connector.getComment(target), (error) => error.code === "profile_locked");
  // 管理者が案内どおり、掴んでいた側を閉じた状態にする。
  delete options.throws;
  const comment = await connector.getComment(target);
  assert.equal(comment.body, "本文");
  assert.equal(browserType.launched.length, 2);
});

test("恒久的な拒否はblockedになり、再認証を促さない", async () => {
  const request = fakeRequestContext({ [DETAIL_URL]: { status: 403, html: "" } });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "blocked" && !error.message.includes("再認証が必要"),
  );
});

test("申告された本文長が上限を超える管理画面は本文を読まずに止める", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      status: 200,
      html: "",
      headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "page_changed",
  );
  // 本文を読む前に断る。読み切ってから数えるだけでは上限の目的を果たさない。
  assert.deepEqual(request.bodyReads, []);
});

test("文字数が上限内でもUTF-8のバイト数が上限を超える管理画面は止める", async () => {
  // 3バイト文字300万字は文字数では上限内だが、バイト数では上限を超える。
  const html = "あ".repeat(3_000_000);
  assert.ok(html.length < MAX_RESPONSE_BYTES);
  assert.ok(Buffer.byteLength(html, "utf8") > MAX_RESPONSE_BYTES);
  const request = fakeRequestContext({ [DETAIL_URL]: { status: 200, html } });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "page_changed",
  );
});

test("一時的な制限はrate_limitedになり、手動検索へ誘導しない", async () => {
  for (const status of [429, 503]) {
    const request = fakeRequestContext({ [DETAIL_URL]: { status, html: "" } });
    const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
    await assert.rejects(
      connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
      (error) => error.code === "rate_limited" && !error.message.includes("手動検索へ切り替え"),
    );
  }
});

test("存在しない対象はnot_foundになり、再認証や画面変更と取り違えない", async () => {
  const request = fakeRequestContext({ [DETAIL_URL]: { status: 404, html: "" } });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "not_found",
  );
});

test("その他の非2xxをunknownとして返し、成功として扱わない", async () => {
  const request = fakeRequestContext({ [DETAIL_URL]: { status: 500, html: "" } });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "unknown",
  );
});

test("応答が返らない場合はtimed_outになる", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: { throws: new Error("apiRequestContext.get: Timeout 15000ms exceeded") },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "timed_out",
  );
});

test("読み取りでページを開かず、HTTP取得だけを行う", async () => {
  const request = fakeRequestContext({ [DETAIL_URL]: { html: detailDocument({ source: "本文" }) } });
  const browserContext = { request, newPage: () => assert.fail("読み取りでページを開いた") };
  const browserType = {
    async launchPersistentContext() {
      return { ...browserContext, async close() {} };
    },
  };
  const connector = createZawazawaConnector({ browserType });
  await connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" });
  assert.equal(request.calls.length, 1);
});

test("コメント表示が複数ある画面はpage_changedになり、本文を推測しない", () => {
  assert.throws(
    () => parseCommentBody(detailDocument({ source: "本文", views: 2 })),
    (error) => error.code === "page_changed",
  );
});

test("実画面と同じ階層にある管理ヘッダーの投稿URLで対象を読める", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      html: detailDocument({
        heading: "雑談/掲示板5 - 669 g/413/669",
        publicHrefs: ["/g/topic/413/669"],
        source: "本文",
      }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(result.body, "本文");
});

test("管理ヘッダーに投稿URLが無くても、管理URLと本文がそろえば対象を読める", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: { html: detailDocument({ publicHrefs: [], source: "本文" }) },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(result.body, "本文");
});

test("管理ヘッダー自体が無い画面でも、管理URLと本文がそろえば対象を読める", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: { html: detailDocument({ managementHeader: false, source: "本文" }) },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(result.body, "本文");
});

test("同じ対象の投稿URLが複数あっても曖昧とせず対象を読める", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      html: detailDocument({
        publicHrefs: ["/g/topic/413/669", "https://z.wikiwiki.jp/g/topic/413/669?from=header"],
        source: "本文",
      }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(result.body, "本文");
});

test("管理ヘッダーの投稿URLが別対象を指す場合はpage_changedになり、別対象を返さない", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: { html: detailDocument({ publicHrefs: ["/g/topic/413/111"], source: "本文" }) },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "page_changed" && error.message.includes("別対象"),
  );
});

test("コメント本文中の一致する投稿URLを対象確認に使わない", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      html: detailDocument({
        publicHrefs: ["/g/topic/413/111"],
        rendered: '<a href="/g/topic/413/669">信頼できないリンク</a>本文',
      }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "page_changed" && error.message.includes("別対象"),
  );
});

test("コメント本文中の別対象リンクを矛盾として扱わない", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      html: detailDocument({
        publicHrefs: ["/g/topic/413/669"],
        rendered: '<a href="/g/topic/413/999">本文に書かれた別投稿</a>本文',
      }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(result.commentNumber, "669");
});

test("管理ヘッダーの外にある投稿者由来のリンクを対象確認に使わない", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      html: detailDocument({
        publicHrefs: ["/g/topic/413/669"],
        extraViewHtml: '<div class="comment-body"><a href="/g/topic/413/999">別投稿</a></div>',
        source: "本文",
      }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(result.commentNumber, "669");
});

test("本文中に管理ヘッダーを装った要素があっても対象確認に使わない", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      html: detailDocument({
        managementHeader: false,
        extraViewHtml:
          '<div class="comment-body">' +
          '<div class="forum-management-header"><a href="/g/topic/413/999">偽ヘッダー</a></div>' +
          "</div>",
        source: "本文",
      }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(result.commentNumber, "669");
});

test("コメント表示が複数ある画面は、管理ヘッダーの投稿URLが一致しても対象を推測しない", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: { html: detailDocument({ source: "本文", views: 2 }) },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "page_changed",
  );
});

test("最終URLが別コメントを指す場合もpage_changedになり、入力番号で上書きしない", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      finalUrl: "https://z.wikiwiki.jp/m/g/comment/413/670",
      html: detailDocument({
        heading: "コメント 670",
        publicHrefs: ["/g/topic/413/670"],
        source: "別対象の本文",
      }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "page_changed" && error.message.includes("別対象"),
  );
});

test("認証画面へ転送された場合はreauth_requiredになる", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      finalUrl: "https://z.wikiwiki.jp/login",
      html: detailDocument({ heading: "ログイン", managementHeader: false, source: "本文" }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "reauth_required" && error.message.includes("npm run auth:zawazawa"),
  );
});

// 開いたままのコンテキストは、認証窓が書いた新しいCookieを拾わない。閉じずにいると、
// 管理者が案内どおり入り直しても同じ失敗が返り続け、ホストの再起動でしか直らない。
test("再認証が要る失敗ではプロファイルを手放し、次の読み取りで開き直す", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      finalUrl: "https://z.wikiwiki.jp/login",
      html: detailDocument({ heading: "ログイン", managementHeader: false, source: "本文" }),
    },
  });
  const browserType = fakeBrowserType(request);
  const connector = createZawazawaConnector({ browserType });
  const target = { groupKey: "g", topicNumber: "413", commentNumber: "669" };
  await assert.rejects(connector.getComment(target), (error) => error.code === "reauth_required");
  assert.equal(browserType.closed, 1);
  await assert.rejects(connector.getComment(target), (error) => error.code === "reauth_required");
  assert.equal(browserType.launched.length, 2);
});

// 手放すのは再認証が要るときだけにする。読み取りのたびに開き直すと、続く読み取りが
// そのぶん遅くなる。
test("再認証以外の失敗ではプロファイルを掴んだままにする", async () => {
  const request = fakeRequestContext({ [DETAIL_URL]: { status: 404, html: "" } });
  const browserType = fakeBrowserType(request);
  const connector = createZawazawaConnector({ browserType });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "not_found",
  );
  assert.equal(browserType.closed, 0);
});

test("詳細表から状態と親コメントを読む", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      html: detailDocument({
        source: "本文",
        values: {
          削除済み: "いいえ",
          無視: "いいえ",
          作成日時: "2026/08/17 (月) 22:20:11",
          親コメント: "660",
        },
      }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const comment = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(comment.currentState, "公開中");
  assert.equal(comment.createdAt, "2026/08/17 (月) 22:20:11");
  assert.equal(comment.parentCommentNumber, "660");
  assert.equal(comment.publicUrl, "https://z.wikiwiki.jp/g/topic/413/669");
});

test("削除済みと自動無視を状態として区別する", async () => {
  const cases = [
    [{ 削除済み: "はい", 無視: "いいえ" }, "削除済み"],
    [{ 削除済み: "いいえ", 無視: "はい" }, "投稿時に自動無視"],
  ];
  for (const [values, expected] of cases) {
    const request = fakeRequestContext({
      [DETAIL_URL]: { html: detailDocument({ source: "本文", values }) },
    });
    const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
    const comment = await connector.getComment({
      groupKey: "g",
      topicNumber: "413",
      commentNumber: "669",
    });
    assert.equal(comment.currentState, expected);
  }
});

test("状態欄を読めない画面を公開中と推測しない", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: { html: detailDocument({ source: "本文", values: { 作成日時: "2026/08/17" } }) },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const comment = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(comment.currentState, undefined);
});

test("トップレベルの投稿には親コメントを付けない", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: { html: detailDocument({ source: "本文", values: { 親コメント: "トップレベル" } }) },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const comment = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(comment.parentCommentNumber, undefined);
});

test("ソース表示欄の原文をタグ除去せず、実体参照だけを復号して読む", () => {
  const body = parseCommentBody(
    detailDocument({ source: "&lt;b&gt;強調&lt;/b&gt; と &amp;amp; 記号" }),
  );
  assert.equal(body, "<b>強調</b> と &amp; 記号");
});

test("ソース表示欄の改行をLFへ揃え、開始タグ直後の改行を落とす", () => {
  // ブラウザが`textarea`の値を取り出すときと同じ規則。経路で本文が変わらないようにする。
  assert.equal(parseCommentBody(detailDocument({ source: "\n一行目\r\n二行目" })), "一行目\n二行目");
});

test("ソース表示欄が無い画面では描画済み本文で補う", () => {
  assert.equal(parseCommentBody(detailDocument({ rendered: "<p>描画された本文</p>" })), "描画された本文");
});

test("ソース表示欄が空の画面でも描画済み本文で補う", () => {
  assert.equal(
    parseCommentBody(detailDocument({ source: "   ", rendered: "<p>描画された本文</p>" })),
    "描画された本文",
  );
});

test("本文を取得できない場合はpage_changedになる", async () => {
  const request = fakeRequestContext({ [DETAIL_URL]: { html: detailDocument({ source: "" }) } });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getComment({ groupKey: "g", topicNumber: "413", commentNumber: "669" }),
    (error) => error.code === "page_changed" && error.message.includes("669"),
  );
});

test("未処理と処理済みの通報を列で区別し、通報ごとの識別子を付ける", () => {
  const result = parseReportTables(
    detailDocument({
      source: "本文",
      reportTables: [
        {
          headers: ["報告メッセージ", "通報日時", ""],
          rows: [{ key: "r1", cells: [messageCell({ text: "宣伝です" }), "2026/08/18 (火) 10:00:00", ""] }],
        },
        {
          headers: ["報告メッセージ", "通報日時", "対処メッセージ", "対処日時"],
          rows: [
            {
              key: "r2",
              cells: [
                messageCell({ text: "既に対処済み" }),
                "2026/08/10 (月) 09:00:00",
                messageCell({ text: "削除しました" }),
                "2026/08/10 (月) 12:00:00",
              ],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(result.openReports.length, 1);
  assert.equal(result.openReports[0].reportId, "r1");
  assert.equal(result.openReports[0].reason, "宣伝です");
  assert.equal(result.closedReports.length, 1);
  assert.equal(result.closedReports[0].responseMessage, "削除しました");
});

test("ページ送りのある未処理通報表は、読めた行を全部として返さない", () => {
  const rows = [{ key: "r1", cells: [messageCell({ text: "宣伝です" }), "2026/08/18 (火) 10:00:00", ""] }];
  const headers = ["報告メッセージ", "通報日時", ""];
  assert.equal(
    parseReportTables(
      detailDocument({ source: "本文", reportTables: [{ headers, rows, paginated: true }] }),
    ).openReportsTruncated,
    true,
  );
  assert.equal(
    parseReportTables(
      detailDocument({ source: "本文", reportTables: [{ headers, rows }] }),
    ).openReportsTruncated,
    false,
  );
});

test("読み切れていない通報表の総件数は件数表示からだけ読み、無ければ返さない", () => {
  const rows = [{ key: "r1", cells: [messageCell({ text: "宣伝です" }), "2026/08/18 (火) 10:00:00", ""] }];
  const headers = ["報告メッセージ", "通報日時", ""];
  assert.equal(
    parseReportTables(
      detailDocument({
        source: "本文",
        reportTables: [
          { headers, rows, summary: "25件中 1件から1件までを表示", paginated: true },
        ],
      }),
    ).openReportsTotalCount,
    25,
  );
  // 件数表示の無いページ送り、および読めた行より少ない件数表示は、残件を推測しない。
  assert.equal(
    parseReportTables(
      detailDocument({ source: "本文", reportTables: [{ headers, rows, paginated: true }] }),
    ).openReportsTotalCount,
    undefined,
  );
  assert.equal(
    parseReportTables(
      detailDocument({
        source: "本文",
        reportTables: [
          { headers, rows, summary: "0件中 0件から0件までを表示", paginated: true },
        ],
      }),
    ).openReportsTotalCount,
    undefined,
  );
  // 読み切れた表は読めた行数がそのまま総件数になる。
  assert.equal(
    parseReportTables(
      detailDocument({ source: "本文", reportTables: [{ headers, rows }] }),
    ).openReportsTotalCount,
    1,
  );
  assert.equal(parseReportTables(detailDocument({ source: "本文" })).openReportsTotalCount, 0);
  // 読めた行と同数の件数表示は、読み切れていない表の総件数として使えない。残りが0件という
  // 数になり、打ち切りの事実と噛み合わなくなる。
  assert.equal(
    parseReportTables(
      detailDocument({
        source: "本文",
        reportTables: [
          { headers, rows, summary: "1件中 1件から1件までを表示", paginated: true },
        ],
      }),
    ).openReportsTotalCount,
    undefined,
  );
});

test("件数表示が読めた行より多い通報表は、ページ送りを読めなくても打ち切りとして返す", () => {
  // 打ち切りの根拠をページ送りの描画だけに置くと、その描画が変わった画面で読めた行を
  // 全部として出す。件数表示と読めた行の食い違いも同じ事実を示す。
  const rows = [{ key: "r1", cells: [messageCell({ text: "宣伝です" }), "2026/08/18 (火) 10:00:00", ""] }];
  const headers = ["報告メッセージ", "通報日時", ""];
  const result = parseReportTables(
    detailDocument({
      source: "本文",
      reportTables: [{ headers, rows, summary: "25件中 1件から1件までを表示" }],
    }),
  );

  assert.equal(result.openReportsTruncated, true);
  assert.equal(result.openReportsTotalCount, 25);
});

test("手前の表にある通報者の文面を、通報表の件数表示と読み違えない", () => {
  // 件数表示のさかのぼりが手前の表を越えると、通報者が書いた文面から総件数を作ってしまう。
  const openTable = {
    headers: ["報告メッセージ", "通報日時", ""],
    rows: [{ key: "r1", cells: [messageCell({ text: "宣伝です" }), "2026/08/18 (火) 10:00:00", ""] }],
    paginated: true,
  };
  const closedTable = {
    headers: ["報告メッセージ", "通報日時", "対処メッセージ", "対処日時"],
    rows: [
      {
        key: "r0",
        cells: [messageCell({ text: "99件中 1件から99件までを表示" }), "2026/08/17 (月) 10:00:00", "対処しました", "2026/08/17 (月) 11:00:00"],
      },
    ],
  };
  const result = parseReportTables(
    detailDocument({ source: "本文", reportTables: [closedTable, openTable] }),
  );

  assert.equal(result.openReportsTruncated, true);
  assert.equal(result.openReportsTotalCount, undefined);
});

test("報告メッセージの通報者表示を理由本文へ混ぜず、別の項目として返す", () => {
  const result = parseReportTables(
    detailDocument({
      source: "本文",
      reportTables: [
        {
          headers: ["報告メッセージ", "通報日時", ""],
          rows: [
            {
              key: "r1",
              cells: [
                messageCell({
                  text: "個人情報が書かれています",
                  sender: { prefix: "送信者: ", name: "通報者A", trip: "◆abc123" },
                }),
                "2026/08/18 (火) 10:00:00",
                "",
              ],
            },
          ],
        },
      ],
    }),
  );
  const [report] = result.openReports;
  assert.equal(report.reason, "個人情報が書かれています");
  assert.equal(report.reporterName, "通報者A");
  assert.equal(report.reporterTrip, "◆abc123");
});

test("通報者の表示が無い報告メッセージは、欄全体を理由本文として読む", () => {
  const result = parseReportTables(
    detailDocument({
      source: "本文",
      reportTables: [
        {
          headers: ["報告メッセージ", "通報日時", ""],
          rows: [{ key: "r1", cells: ["理由だけの欄", "2026/08/18 (火) 10:00:00", ""] }],
        },
      ],
    }),
  );
  assert.equal(result.openReports[0].reason, "理由だけの欄");
  assert.equal(result.openReports[0].reporterName, undefined);
});

test("欄の末尾に区切りがあっても、差出人を理由本文へ混ぜない", () => {
  const nodes = [
    { tag: "", text: "理由本文", cls: "" },
    { tag: "BR", text: "", cls: "" },
    { tag: "STRONG", text: "通報者A", cls: "" },
    { tag: "BR", text: "", cls: "" },
  ];
  assert.deepEqual(splitReportMessage(nodes), {
    text: "理由本文",
    reporterName: "通報者A",
    reporterTrip: "",
  });
});

test("複数行の理由本文を差出人の手前まで残す", () => {
  const nodes = [
    { tag: "", text: "一行目", cls: "" },
    { tag: "BR", text: "", cls: "" },
    { tag: "", text: "二行目", cls: "" },
    { tag: "BR", text: "", cls: "" },
    { tag: "", text: "by", cls: "" },
    { tag: "STRONG", text: "通報者A", cls: "" },
  ];
  // 差出人の直前の区切りで切るため、`by`は理由本文に残らない。
  assert.equal(splitReportMessage(nodes).text, "一行目二行目");
});

test("対処メッセージと管理者表示の文字列区切りを本文へ混ぜない", () => {
  const nodes = [
    { tag: "", text: "確認のうえ維持しました。 -- ", cls: "" },
    { tag: "STRONG", text: "管理者", cls: "" },
  ];
  assert.equal(splitReportMessage(nodes).text, "確認のうえ維持しました。");
});

test("同じ通報者による回答済み投稿の再通報を示す", () => {
  const sender = { name: "通報者A", trip: "◆abc123" };
  const result = parseReportTables(
    detailDocument({
      source: "本文",
      reportTables: [
        {
          headers: ["報告メッセージ", "通報日時", ""],
          rows: [
            { key: "r1", cells: [messageCell({ text: "また出ています", sender }), "", ""] },
          ],
        },
        {
          headers: ["報告メッセージ", "通報日時", "対処メッセージ", "対処日時"],
          rows: [
            {
              key: "r0",
              cells: [
                messageCell({ text: "前回の通報", sender }),
                "",
                messageCell({ text: "対処済みです" }),
                "",
              ],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(result.openReports[0].repeatAfterResponse, true);
});

test("対処メッセージが無い処理済み通報は再通報の根拠にしない", () => {
  const sender = { name: "通報者A", trip: "◆abc123" };
  const result = parseReportTables(
    detailDocument({
      source: "本文",
      reportTables: [
        {
          headers: ["報告メッセージ", "通報日時", ""],
          rows: [{ key: "r1", cells: [messageCell({ text: "また出ています", sender }), "", ""] }],
        },
        {
          headers: ["報告メッセージ", "通報日時", "対処メッセージ", "対処日時"],
          rows: [{ key: "r0", cells: [messageCell({ text: "前回の通報", sender }), "", "", ""] }],
        },
      ],
    }),
  );
  assert.equal(result.openReports[0].repeatAfterResponse, false);
});

test("通報が無い表の「結果が得られませんでした。」を通報として数えない", () => {
  const result = parseReportTables(
    detailDocument({
      source: "本文",
      reportTables: [
        {
          headers: ["報告メッセージ", "通報日時", ""],
          rows: [{ cells: ["結果が得られませんでした。"] }],
        },
      ],
    }),
  );
  assert.deepEqual(result.openReports, []);
});

/**
 * 以下の3件は、閲覧者のブラウザと同じ木を組んで読むことでだけ正しく読める形。
 * 自前の正規表現で読んでいた頃は、いずれも黙って別の値を返していた。
 */
test("閉じタグを省略した欄でも、次の欄の値を理由本文へ混ぜない", () => {
  const html = documentOf(
    '<h1>コメント 669</h1><div class="panel comment-view"><textarea class="md-code-editor">本文</textarea></div>' +
      "<table><tr><th>報告メッセージ</th><th>通報日時</th></tr>" +
      '<tr data-key="r1"><td>宣伝です<td>2026/08/18 (火) 10:00:00</table>',
  );
  const [report] = parseReportTables(html).openReports;
  assert.equal(report.reason, "宣伝です");
  assert.equal(report.createdAt, "2026/08/18 (火) 10:00:00");
});

test("HTMLコメントの中の行を未処理通報として数えない", () => {
  const html = documentOf(
    '<h1>コメント 669</h1><div class="panel comment-view"><textarea class="md-code-editor">本文</textarea></div>' +
      "<table><tr><th>報告メッセージ</th><th>通報日時</th></tr>" +
      '<!-- <tr data-key="x"><td>下書きの通報</td><td></td></tr> -->' +
      '<tr data-key="r1"><td>宣伝です</td><td>10:00</td></tr></table>',
  );
  const { openReports } = parseReportTables(html);
  assert.deepEqual(
    openReports.map((report) => report.reportId),
    ["r1"],
  );
});

test("script内の閉じタグらしき文字列で本文を打ち切らない", () => {
  const body = parseCommentBody(
    documentOf(
      '<h1>コメント 669</h1><div class="panel comment-view"><div class="panel-body">' +
        '<script>var x = "</div>";</script><p>本当の本文</p></div></div>',
    ),
  );
  assert.equal(body, "本当の本文");
});

test("通報表が無く、通報の無い画面とも確認できなければpage_changedで止める", () => {
  assert.throws(
    () => parseReportTables(detailDocument({ source: "本文", reportTables: [] })),
    (error) => error.code === "page_changed",
  );
});

test("通報が一度も無いコメントの画面は0件として読む", () => {
  const result = parseReportTables(
    detailDocument({
      source: "本文",
      values: { 作成日時: "2026/08/18 12:00", 削除済み: "いいえ" },
      reportTables: [],
    }),
  );
  assert.deepEqual(result.openReports, []);
  assert.deepEqual(result.closedReports, []);
});

test("見出しの変わった通報表を、通報の無い画面と読み違えない", () => {
  assert.throws(
    () =>
      parseReportTables(
        detailDocument({
          source: "本文",
          values: { 作成日時: "2026/08/18 12:00" },
          reportTables: [{ headers: ["通報理由", "通報日時"], rows: [{ key: "r1", cells: ["宣伝", ""] }] }],
        }),
      ),
    (error) => error.code === "page_changed",
  );
});

test("未処理通報の表が複数ある画面はpage_changedになる", () => {
  const open = {
    headers: ["報告メッセージ", "通報日時", ""],
    rows: [{ key: "r1", cells: ["理由", "", ""] }],
  };
  assert.throws(
    () => parseReportTables(detailDocument({ source: "本文", reportTables: [open, open] })),
    (error) => error.code === "page_changed",
  );
});

test("通報表の失敗は本文の解決を巻き込まず、reportsErrorとして返る", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: { html: detailDocument({ source: "本文", reportTables: [] }) },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const comment = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(comment.body, "本文");
  assert.equal(comment.reportsError.code, "page_changed");
  assert.equal(comment.openReports, undefined);
});

test("通報が一度も無いコメントは、reportsErrorなしで0件として返る", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      html: detailDocument({
        source: "本文",
        values: { 作成日時: "2026/08/18 12:00", 親コメント: "トップレベル" },
        reportTables: [],
      }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const comment = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(comment.reportsError, undefined);
  assert.deepEqual(comment.openReports, []);
});

test("コネクタは差出人の実値を返さず、回答後の再通報という照合結果だけを返す", async () => {
  const sender = { name: "架空差出人", trip: "◆fixture-trip" };
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      html: detailDocument({
        source: "本文",
        values: { 作成日時: "2026/08/18 12:00" },
        reportTables: [
          {
            headers: ["報告メッセージ", "通報日時", ""],
            rows: [
              {
                key: "open-1",
                cells: [messageCell({ text: "再確認をお願いします", sender }), "", ""],
              },
            ],
          },
          {
            headers: ["報告メッセージ", "通報日時", "対処メッセージ", "対処日時"],
            rows: [
              {
                key: "closed-1",
                cells: [
                  messageCell({ text: "以前の連絡", sender }),
                  "",
                  messageCell({ text: "確認済みです" }),
                  "",
                ],
              },
            ],
          },
        ],
      }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const comment = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  const serialized = JSON.stringify(comment);
  assert.equal(comment.openReports[0].reason, "再確認をお願いします");
  assert.equal(comment.openReports[0].repeatAfterResponse, true);
  assert.equal(comment.openReports[0].reporterName, undefined);
  assert.equal(comment.openReports[0].reporterTrip, undefined);
  assert.equal(comment.closedReports, undefined);
  assert.ok(!serialized.includes(sender.name));
  assert.ok(!serialized.includes(sender.trip));
});

test("未処理通報の対象を表示文ではなく行のリンクから取る", async () => {
  const html = openReportsDocument({
    tables: [
      {
        headers: ["発生箇所", "報告メッセージ", "通報日時"],
        summary: "2件中 1件から2件までを表示",
        rows: [
          {
            key: "a1",
            cells: [
              '<a href="/m/g/comment/413/669">トピック413のコメント100</a>',
              messageCell({ text: "宣伝" }),
              "2026/08/18 (火) 10:00:00",
            ],
          },
          {
            key: "a2",
            cells: [
              '<a href="/m/g/comment/345/98644">別のコメント</a>',
              messageCell({ text: "暴言" }),
              "2026/08/18 (火) 11:00:00",
            ],
          },
        ],
      },
    ],
  });
  const request = fakeRequestContext({ "https://z.wikiwiki.jp/m/g/abuse/open": { html } });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getOpenReports({ groupKey: "g" });
  assert.deepEqual(
    result.reports.map((report) => `${report.topicNumber}/${report.commentNumber}`),
    ["413/669", "345/98644"],
  );
  // 対象は番号で指す。1行ごとのURLはモデルの文脈へ載せない。
  assert.equal(result.reports[0].adminUrl, undefined);
  assert.equal(result.reports[0].publicUrl, undefined);
  assert.equal(result.totalCountConfirmed, true);
  assert.equal(result.completeness, "complete");
  assert.equal(result.incompleteReason, undefined);
  assert.equal(result.truncated, false);
});

test("正規の空表示だけを未処理0件かつcompleteとして返す", () => {
  const html = openReportsDocument({
    tables: [
      {
        headers: ["発生箇所", "報告メッセージ", "通報日時"],
        rows: [{ cells: ["結果が得られませんでした。"] }],
      },
    ],
  });
  const result = parseOpenReportsPage(html, { groupKey: "g", limit: 50 });
  assert.deepEqual(result.reports, []);
  assert.equal(result.totalCount, 0);
  assert.equal(result.totalCountConfirmed, true);
  assert.equal(result.completeness, "complete");
  assert.equal(result.truncated, false);
});

test("件数0でも正規の空表示が無い一覧はcompleteにしない", () => {
  const html = openReportsDocument({
    tables: [
      {
        headers: ["発生箇所", "報告メッセージ", "通報日時"],
        summary: "0件中 0件を表示",
        rows: [],
      },
    ],
  });
  const result = parseOpenReportsPage(html, { groupKey: "g", limit: 50 });
  assert.deepEqual(result.reports, []);
  assert.equal(result.totalCount, 0);
  assert.equal(result.completeness, "unknown");
  assert.deepEqual(result.incompleteReason, {
    code: "canonical_empty_state_unconfirmed",
    returnedCount: 0,
    totalCount: 0,
  });
  assert.equal(result.truncated, true);
});

test("行も正規の空表示も件数も無い一覧はunknownになり、0件完了と主張しない", () => {
  const html = openReportsDocument({
    tables: [{ headers: ["発生箇所", "報告メッセージ", "通報日時"], rows: [] }],
  });
  const result = parseOpenReportsPage(html, { groupKey: "g", limit: 50 });
  assert.deepEqual(result.reports, []);
  assert.equal(result.totalCount, undefined);
  assert.equal(result.completeness, "unknown");
  assert.deepEqual(result.incompleteReason, {
    code: "total_count_unconfirmed",
    returnedCount: 0,
  });
  assert.equal(result.truncated, true);
});

test("発生箇所のリンクが想定形でない画面はpage_changedになる", () => {
  const html = openReportsDocument({
    tables: [
      {
        headers: ["発生箇所", "報告メッセージ", "通報日時"],
        rows: [{ key: "a1", cells: ['<a href="/m/g/topic/413">トピック</a>', "理由", ""] }],
      },
    ],
  });
  assert.throws(
    () => parseOpenReportsPage(html, { groupKey: "g", limit: 50 }),
    (error) => error.code === "page_changed",
  );
});

test("ページ送りが無い一覧は、件数表示が無くても読んだ行を全件として返す", () => {
  const html = openReportsDocument({
    tables: [
      {
        headers: ["発生箇所", "報告メッセージ", "通報日時"],
        rows: [{ key: "a1", cells: ['<a href="/m/g/comment/413/669">x</a>', "理由", ""] }],
      },
    ],
  });
  const result = parseOpenReportsPage(html, { groupKey: "g", limit: 50 });
  assert.equal(result.totalCount, 1);
  assert.equal(result.totalCountConfirmed, true);
  assert.equal(result.completeness, "complete");
  assert.equal(result.incompleteReason, undefined);
  assert.equal(result.truncated, false);
});

test("ページ送りがあるのに件数表示が無い一覧はpage_changedになる", () => {
  const html = openReportsDocument({
    tables: [
      {
        headers: ["発生箇所", "報告メッセージ", "通報日時"],
        paginated: true,
        rows: [{ key: "a1", cells: ['<a href="/m/g/comment/413/669">x</a>', "理由", ""] }],
      },
    ],
  });
  assert.throws(
    () => parseOpenReportsPage(html, { groupKey: "g", limit: 50 }),
    (error) => error.code === "page_changed",
  );
});

test("件数表示より少なく読んだ場合は打ち切りとして返す", () => {
  const html = openReportsDocument({
    tables: [
      {
        headers: ["発生箇所", "報告メッセージ", "通報日時"],
        summary: "12件中 1件から1件までを表示",
        paginated: true,
        rows: [{ key: "a1", cells: ['<a href="/m/g/comment/413/669">x</a>', "理由", ""] }],
      },
    ],
  });
  const result = parseOpenReportsPage(html, { groupKey: "g", limit: 1 });
  assert.equal(result.totalCount, 12);
  assert.equal(result.completeness, "partial");
  assert.deepEqual(result.incompleteReason, {
    code: "more_reports_available",
    returnedCount: 1,
    totalCount: 12,
  });
  assert.equal(result.truncated, true);
});

test("発生箇所列を確認できない画面の0件を未処理なしの根拠にしない", () => {
  const html = openReportsDocument({
    tables: [{ headers: ["報告メッセージ", "通報日時"], rows: [] }],
  });
  assert.throws(
    () => parseOpenReportsPage(html, { groupKey: "g", limit: 50 }),
    (error) => error.code === "page_changed",
  );
});

test("未処理通報タブが無い画面はreauth_requiredになる", () => {
  const html = openReportsDocument({ tabs: ["/m/other/abuse/open"], tables: [] });
  assert.throws(
    () => parseOpenReportsPage(html, { groupKey: "g", limit: 50 }),
    (error) => error.code === "reauth_required",
  );
});

/** 1ページの件数は管理画面が決めるので、`limit`を上げるだけでは2ページ目を読めない。 */
function pagedOpenReports({ summary, keys }) {
  return openReportsDocument({
    tables: [
      {
        headers: ["発生箇所", "報告メッセージ", "通報日時"],
        summary,
        paginated: true,
        rows: keys.map((key) => ({
          key,
          cells: [`<a href="/m/g/comment/413/${key.slice(1)}">x</a>`, "理由", ""],
        })),
      },
    ],
  });
}

test("未処理通報一覧はページ送りをたどり、全ページを読み切ってcompleteにする", async () => {
  const request = fakeRequestContext({
    "https://z.wikiwiki.jp/m/g/abuse/open": {
      html: pagedOpenReports({ summary: "3件中 1件から2件までを表示", keys: ["a1", "a2"] }),
    },
    "https://z.wikiwiki.jp/m/g/abuse/open?page=2": {
      html: pagedOpenReports({ summary: "3件中 3件から3件までを表示", keys: ["a3"] }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getOpenReports({ groupKey: "g" });
  assert.deepEqual(
    result.reports.map((report) => report.reportId),
    ["a1", "a2", "a3"],
  );
  assert.equal(result.totalCount, 3);
  assert.equal(result.completeness, "complete");
  assert.equal(result.truncated, false);
  assert.deepEqual(
    request.calls.map((call) => call.url),
    [
      "https://z.wikiwiki.jp/m/g/abuse/open",
      "https://z.wikiwiki.jp/m/g/abuse/open?page=2",
    ],
  );
});

test("取得件数の上限に達したら次のページを読まず、打ち切りとして返す", async () => {
  const request = fakeRequestContext({
    "https://z.wikiwiki.jp/m/g/abuse/open": {
      html: pagedOpenReports({ summary: "3件中 1件から2件までを表示", keys: ["a1", "a2"] }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getOpenReports({ groupKey: "g", limit: 1 });
  assert.deepEqual(
    result.reports.map((report) => report.reportId),
    ["a1"],
  );
  assert.equal(result.completeness, "partial");
  assert.deepEqual(result.incompleteReason, {
    code: "more_reports_available",
    returnedCount: 1,
    totalCount: 3,
  });
  assert.equal(request.calls.length, 1);
});

test("読み進める途中で件数が減った一覧は、読めた件数が釣り合ってもcompleteにしない", async () => {
  const request = fakeRequestContext({
    "https://z.wikiwiki.jp/m/g/abuse/open": {
      html: pagedOpenReports({ summary: "5件中 1件から2件までを表示", keys: ["a1", "a2"] }),
    },
    // 1ページ目を読んだ後に1件処理され、一覧が繰り上がった画面。3件目はページ1側へ
    // 移って読み飛ばされる。減った件数と読めた件数は釣り合うが、全件ではない。
    "https://z.wikiwiki.jp/m/g/abuse/open?page=2": {
      html: pagedOpenReports({ summary: "4件中 3件から4件までを表示", keys: ["a4", "a5"] }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getOpenReports({ groupKey: "g" });
  assert.deepEqual(
    result.reports.map((report) => report.reportId),
    ["a1", "a2", "a4", "a5"],
  );
  assert.equal(result.completeness, "partial");
  assert.deepEqual(result.incompleteReason, {
    code: "more_reports_available",
    returnedCount: 4,
    totalCount: 5,
  });
  assert.equal(request.calls.length, 2);
});

test("ページ数の上限に達したら読み進めるのをやめ、打ち切りとして返す", async () => {
  // 1ページの件数は管理画面が決めるため、`limit`だけでは往復を抑えられない。
  const request = fakeRequestContext((url) => {
    const page = Number(new URL(url).searchParams.get("page") || "1");
    return {
      html: pagedOpenReports({
        summary: `100件中 ${page}件から${page}件までを表示`,
        keys: [`a${page}`],
      }),
    };
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getOpenReports({ groupKey: "g", limit: 100 });
  assert.equal(request.calls.length, 10);
  assert.equal(result.reports.length, 10);
  assert.equal(result.totalCount, 100);
  assert.equal(result.completeness, "partial");
});

test("同じ行しか返らないページ送りは、同じ画面を読み続けず打ち切る", async () => {
  const page = pagedOpenReports({ summary: "3件中 1件から2件までを表示", keys: ["a1", "a2"] });
  const request = fakeRequestContext(() => ({ html: page }));
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getOpenReports({ groupKey: "g" });
  assert.deepEqual(
    result.reports.map((report) => report.reportId),
    ["a1", "a2"],
  );
  assert.equal(result.completeness, "partial");
  assert.equal(request.calls.length, 2);
});

test("未処理通報一覧の取得も自動アクセス拒否をblockedとして返す", async () => {
  const request = fakeRequestContext({
    "https://z.wikiwiki.jp/m/g/abuse/open": { status: 403, html: "" },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getOpenReports({ groupKey: "g" }),
    (error) => error.code === "blocked",
  );
});

test("共有上限1でも履歴の複数段階を止めず、対象リンクだけを読む", { timeout: 1000 }, async () => {
  const searchUrl = "https://z.wikiwiki.jp/m/g/comment?q=example.test";
  const routes = {
    [DETAIL_URL]: {
      html: detailDocument({
        source: "本文",
        values: {},
        metadataItems: [["ホスト", "example.test"]],
      }),
    },
    [searchUrl]: {
      html: searchDocument([
        "/m/g/comment/413/669",
        "/m/g/comment/413/669",
        "/m/g/comment/345/98644?q=example.test",
        "/m/g/comment/371/1205",
      ]),
    },
    "https://z.wikiwiki.jp/m/g/comment/371/1205": {
      html: detailDocument({
        heading: "コメント 1205",
        publicHrefs: ["/g/topic/371/1205"],
        source: "別の投稿",
      }),
    },
  };
  const request = fakeRequestContext(routes);
  const connector = createZawazawaConnector({
    browserType: fakeBrowserType(request),
    requestLimiter: createRequestLimiter(1),
  });
  const result = await connector.getAuthorHistory({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
    limit: 10,
  });
  // クエリ付きリンクは完全一致しないため履歴に入らない。対象自身も履歴へ重複させない。
  assert.deepEqual(
    result.history.map((entry) => entry.commentNumber),
    ["1205"],
  );
  assert.equal(result.targetComment.commentNumber, "669");
  assert.equal(result.targetComment.body, "本文");
  assert.equal(result.targetIncludedInHistory, true);
  assert.equal(request.calls.filter((call) => call.url === DETAIL_URL).length, 1);
  assert.ok(request.calls.some((call) => call.url === searchUrl));
});

test("対象が履歴上限外でもtargetCommentを独立して返し、履歴順序を変えない", async () => {
  const searchUrl = "https://z.wikiwiki.jp/m/g/comment?q=history.example";
  const targetHtml = detailDocument({
    source: "対象本文",
    values: { 削除済み: "いいえ", 無視: "いいえ", 作成日時: "2026/08/17 10:00" },
  }).replace(
    "<h1>コメント 669</h1>",
    "<h1>コメント 669</h1><ul><li>ホスト:&nbsp;history.example</li></ul>",
  );
  const routes = {
    [DETAIL_URL]: { html: targetHtml },
    [searchUrl]: {
      html: searchDocument(["/m/g/comment/413/701", "/m/g/comment/413/700"]),
    },
    "https://z.wikiwiki.jp/m/g/comment/413/701": {
      html: detailDocument({
        heading: "コメント 701",
        publicHrefs: ["/g/topic/413/701"],
        source: "新しい投稿1",
      }),
    },
    "https://z.wikiwiki.jp/m/g/comment/413/700": {
      html: detailDocument({
        heading: "コメント 700",
        publicHrefs: ["/g/topic/413/700"],
        source: "新しい投稿2",
      }),
    },
  };
  const request = fakeRequestContext(routes);
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getAuthorHistory({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
    limit: 2,
  });

  assert.equal(result.targetComment.commentNumber, "669");
  assert.equal(result.targetComment.body, "対象本文");
  assert.equal(result.targetComment.currentState, "公開中");
  assert.equal(result.targetIncludedInHistory, false);
  assert.deepEqual(
    result.history.map((entry) => entry.commentNumber),
    ["701", "700"],
  );
  assert.equal(request.calls.filter((call) => call.url === DETAIL_URL).length, 1);
});

test("対象が検索結果の中間にあっても履歴へ重複させず、対象ページを再取得しない", async () => {
  const searchUrl = "https://z.wikiwiki.jp/m/g/comment?q=middle.example";
  const routes = {
    [DETAIL_URL]: {
      html: detailDocument({ source: "対象本文" }).replace(
        "<h1>コメント 669</h1>",
        "<h1>コメント 669</h1><ul><li>ホスト:&nbsp;middle.example</li></ul>",
      ),
    },
    [searchUrl]: {
      html: searchDocument([
        "/m/g/comment/413/701",
        "/m/g/comment/413/669",
        "/m/g/comment/413/600",
      ]),
    },
    "https://z.wikiwiki.jp/m/g/comment/413/701": {
      html: detailDocument({
        heading: "コメント 701",
        publicHrefs: ["/g/topic/413/701"],
        source: "新しい投稿",
      }),
    },
    "https://z.wikiwiki.jp/m/g/comment/413/600": {
      html: detailDocument({
        heading: "コメント 600",
        publicHrefs: ["/g/topic/413/600"],
        source: "古い投稿",
      }),
    },
  };
  const request = fakeRequestContext(routes);
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getAuthorHistory({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
    limit: 10,
  });
  assert.deepEqual(
    result.history.map((entry) => entry.commentNumber),
    ["701", "600"],
  );
  assert.equal(result.targetIncludedInHistory, true);
  assert.equal(request.calls.filter((call) => call.url === DETAIL_URL).length, 1);
});

test("対象詳細を読めない履歴要求は、別コメントをtargetCommentにせず失敗する", async () => {
  const targetWithHostButNoBody = detailDocument({ source: "" }).replace(
    "<h1>コメント 669</h1>",
    "<h1>コメント 669</h1><ul><li>ホスト:&nbsp;history.example</li></ul>",
  );
  const request = fakeRequestContext({ [DETAIL_URL]: { html: targetWithHostButNoBody } });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getAuthorHistory({ groupKey: "g", topicNumber: "413", commentNumber: "669", limit: 10 }),
    (error) => error.code === "page_changed" && error.message.includes("669"),
  );
  assert.equal(request.calls.length, 1);
});

test("接続元情報を読めない場合はpage_changedになる", async () => {
  const request = fakeRequestContext({
    [DETAIL_URL]: { html: detailDocument({ source: "本文" }) },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  await assert.rejects(
    connector.getAuthorHistory({ groupKey: "g", topicNumber: "413", commentNumber: "669", limit: 10 }),
    (error) => error.code === "page_changed" && error.message.includes("接続元"),
  );
});

test("検索欄が見つからない場合はpage_changedになる", () => {
  assert.throws(
    () => parseSearchReferences(documentOf("<table></table>"), { groupKey: "g", limit: 5 }),
    (error) => error.code === "page_changed",
  );
});

test("履歴検索は最終URLのorigin・path・単一のqが内部検索値と一致するときだけ採用する", async () => {
  const hostValue = "history-filter.example";
  const searchUrl = `https://z.wikiwiki.jp/m/g/comment?q=${encodeURIComponent(hostValue)}`;
  const html = searchDocument(["/m/g/comment/413/700"]);
  const invalidFinalUrls = [
    "https://z.wikiwiki.jp/m/g/comment",
    "https://z.wikiwiki.jp/m/g/comment?q=other.example",
    `https://other.example/m/g/comment?q=${encodeURIComponent(hostValue)}`,
    `${searchUrl}&q=${encodeURIComponent(hostValue)}`,
  ];

  for (const finalUrl of invalidFinalUrls) {
    const reader = createAdminReader({
      requestContext: fakeRequestContext({
        [searchUrl]: { html, finalUrl },
      }),
    });
    await assert.rejects(
      reader.searchCommentReferences({ groupKey: "g", hostValue, limit: 5 }),
      (error) =>
        error.code === "page_changed" &&
        !error.message.includes(hostValue) &&
        !error.message.includes(encodeURIComponent(hostValue)),
    );
  }
});

test("履歴検索の取得例外へ含まれた内部検索値とURLを外へ返さない", async () => {
  const hostValue = "sensitive-host.example:8443";
  const encodedHostValue = encodeURIComponent(hostValue);
  const searchUrl = `https://z.wikiwiki.jp/m/g/comment?q=${encodedHostValue}`;
  const targetHtml = detailDocument({ source: "対象本文" }).replace(
    "<h1>コメント 669</h1>",
    `<h1>コメント 669</h1><ul><li>ホスト:&nbsp;${hostValue}</li></ul>`,
  );
  const request = fakeRequestContext({
    [DETAIL_URL]: { html: targetHtml },
    [searchUrl]: {
      throws: new Error(
        `request failed for ${hostValue}; encoded=${encodedHostValue}; url=${searchUrl}`,
      ),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });

  await assert.rejects(
    connector.getAuthorHistory({ groupKey: "g", topicNumber: "413", commentNumber: "669", limit: 10 }),
    (error) => {
      assert.equal(error.code, "unknown");
      const output = `${error.message} ${JSON.stringify(error)}`;
      assert.ok(!output.includes(hostValue));
      assert.ok(!output.includes(encodedHostValue));
      assert.ok(!output.includes(searchUrl));
      return true;
    },
  );
});

test("複数参照を並列に読み、順序を保つ", async () => {
  const references = ["1", "2", "3", "4", "5"].map((commentNumber) => ({
    groupKey: "g",
    topicNumber: "413",
    commentNumber,
  }));
  let active = 0;
  let peak = 0;
  const adminReader = {
    async readCommentDetail(reference) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 1));
      active -= 1;
      return { commentNumber: reference.commentNumber };
    },
  };
  const details = await readCommentDetails(adminReader, references);
  assert.deepEqual(
    details.map((detail) => detail.commentNumber),
    ["1", "2", "3", "4", "5"],
  );
  assert.ok(peak <= 3, `並行数が上限を超えた: ${peak}`);
});

test("管理画面と公開ページの異なる読み取りが同じ通信上限を共有する", async () => {
  const requestLimiter = createRequestLimiter(3);
  let active = 0;
  let peak = 0;
  let releaseBodies;
  const bodyGate = new Promise((resolve) => {
    releaseBodies = resolve;
  });
  function started() {
    active += 1;
    peak = Math.max(peak, active);
  }
  async function body(value) {
    await bodyGate;
    active -= 1;
    return value;
  }

  const requestContext = {
    async get(url) {
      started();
      const commentNumber = new URL(url).pathname.split("/").at(-1);
      return {
        status: () => 200,
        url: () => url,
        headers: () => ({}),
        text: () =>
          body(
            detailDocument({
              heading: `コメント ${commentNumber}`,
              publicHrefs: [`/g/topic/413/${commentNumber}`],
              source: `本文${commentNumber}`,
            }),
          ),
      };
    },
  };
  const connector = createZawazawaConnector({
    browserType: fakeBrowserType(requestContext),
    requestLimiter,
  });
  const publicReader = createPublicReader({
    requestLimiter,
    fetchImpl: async () => {
      started();
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => body("<rss><channel></channel></rss>"),
      };
    },
  });
  const references = ["1", "2", "3"].map((commentNumber) => ({
    groupKey: "g",
    topicNumber: "413",
    commentNumber,
  }));

  const pending = Promise.all([
    connector.getComments(references),
    publicReader.readTopicFeed({ groupKey: "g", topicNumber: "413" }),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 3);
  assert.equal(peak, 3);
  releaseBodies();

  const [comments] = await pending;
  assert.deepEqual(
    comments.map((comment) => comment.commentNumber),
    ["1", "2", "3"],
  );
  assert.equal(peak, 3);
});

test("同じ参照は一度だけ読む", async () => {
  const request = fakeRequestContext({ [DETAIL_URL]: { html: detailDocument({ source: "本文" }) } });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const reference = { groupKey: "g", topicNumber: "413", commentNumber: "669" };
  const comments = await connector.getComments([reference, reference]);
  assert.equal(comments.length, 2);
  assert.equal(request.calls.length, 1);
});

test("通報表が要らない参照は通報表を読まず、混在した重複は要る方に合わせる", async () => {
  // 通報表の無い画面。通報表を読む経路だけがreportsErrorを出す。
  const html = detailDocument({ source: "本文", reportTables: [] });
  const reference = { groupKey: "g", topicNumber: "413", commentNumber: "669" };

  const light = fakeRequestContext({ [DETAIL_URL]: { html } });
  const [skipped] = await createZawazawaConnector({
    browserType: fakeBrowserType(light),
  }).getComments([{ ...reference, includeReports: false }]);
  // 参照の解決に要る項目は軽い経路でも同じ許可項目で返る。
  assert.equal(skipped.body, "本文");
  assert.equal(skipped.publicUrl, "https://z.wikiwiki.jp/g/topic/413/669");
  assert.equal(skipped.openReports, undefined);
  assert.equal(skipped.reportsError, undefined);

  const mixed = fakeRequestContext({ [DETAIL_URL]: { html } });
  const [merged] = await createZawazawaConnector({
    browserType: fakeBrowserType(mixed),
  }).getComments([{ ...reference, includeReports: false }, reference]);
  assert.equal(mixed.calls.length, 1);
  assert.equal(merged.reportsError.code, "page_changed");
});

test("ホスト欄は実体参照を復号してから照合する", async () => {
  const reader = createAdminReader({
    requestContext: fakeRequestContext({
      [DETAIL_URL]: {
        html: detailDocument({ source: "本文", metadataItems: [["ホスト", "example.test"]] }),
      },
    }),
  });
  const host = await reader.readHostValue({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(host, "example.test");
});

test("コメント本文内のホスト風リストを内部検索キーと取り違えない", async () => {
  const html = detailDocument({
    rendered: "<ul><li>ホスト: untrusted-body.example</li></ul><p>本文</p>",
    metadataItems: [["ホスト", "metadata.example"]],
  });
  const reader = createAdminReader({
    requestContext: fakeRequestContext({ [DETAIL_URL]: { html } }),
  });
  const host = await reader.readHostValue({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(host, "metadata.example");
});

test("管理メタデータ列のホスト欄が複数ある場合は値を推測しない", async () => {
  const reader = createAdminReader({
    requestContext: fakeRequestContext({
      [DETAIL_URL]: {
        html: detailDocument({
          source: "本文",
          metadataItems: [
            ["ホスト", "first.example"],
            ["ホスト", "second.example"],
          ],
        }),
      },
    }),
  });
  const host = await reader.readHostValue({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  assert.equal(host, undefined);
});

test("コメント詳細の近傍にある接続元欄を許可済みの出力へ混ぜない", async () => {
  const forbiddenValues = [
    "192.0.2.123",
    "nearby-host.example",
    "65535",
    "SyntheticBrowser/9",
    "synthetic-session-token",
  ];
  const request = fakeRequestContext({
    [DETAIL_URL]: {
      html: detailDocument({
        source: "本文",
        values: {
          削除済み: "いいえ",
          無視: "はい",
          作成日時: "2026/08/18 12:00",
          IPアドレス: forbiddenValues[0],
          ホスト: forbiddenValues[1],
          ポート: forbiddenValues[2],
          "User-Agent": forbiddenValues[3],
          セッション: forbiddenValues[4],
        },
      }),
    },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getComment({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
  });
  const serialized = JSON.stringify(result);
  assert.equal(result.currentState, "投稿時に自動無視");
  for (const forbidden of forbiddenValues) assert.ok(!serialized.includes(forbidden));
});

test("未処理一覧の隣接列・別表にある禁止値をコネクタ出力へ混ぜない", async () => {
  const forbiddenValues = [
    "192.0.2.124",
    "report-host.example",
    "SyntheticBrowser/10",
    "report-session-token",
    "架空差出人B",
    "◆fixture-open-report",
  ];
  const html = openReportsDocument({
    tables: [
      {
        headers: ["発生箇所", "報告メッセージ", "通報日時", "接続元", "User-Agent"],
        summary: "1件中 1件から1件までを表示",
        rows: [
          {
            key: "a1",
            cells: [
              '<a href="/m/g/comment/413/669">対象</a>',
              messageCell({
                text: "理由",
                sender: { name: forbiddenValues[4], trip: forbiddenValues[5] },
              }),
              "2026/08/18 12:00",
              `${forbiddenValues[0]} ${forbiddenValues[1]}`,
              forbiddenValues[2],
            ],
          },
        ],
      },
      {
        headers: ["セッション"],
        rows: [{ key: "nearby", cells: [forbiddenValues[3]] }],
      },
    ],
  });
  const request = fakeRequestContext({ "https://z.wikiwiki.jp/m/g/abuse/open": { html } });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getOpenReports({ groupKey: "g" });
  const serialized = JSON.stringify(result);
  assert.equal(result.completeness, "complete");
  assert.equal(result.reports[0].reportId, "a1");
  for (const forbidden of forbiddenValues) assert.ok(!serialized.includes(forbidden));
});

test("投稿履歴は内部検索用ホストと近傍の禁止欄を返さず、対象を許可項目だけにする", async () => {
  const searchUrl = "https://z.wikiwiki.jp/m/g/comment?q=internal-only.example";
  const forbiddenValues = [
    "internal-only.example",
    "192.0.2.125",
    "SyntheticBrowser/11",
    "history-session-token",
  ];
  const targetHtml = detailDocument({
    source: "対象本文",
    values: {
      削除済み: "いいえ",
      無視: "いいえ",
      ホスト: forbiddenValues[0],
      IPアドレス: forbiddenValues[1],
      "User-Agent": forbiddenValues[2],
      セッション: forbiddenValues[3],
    },
  }).replace(
    "<h1>コメント 669</h1>",
    `<h1>コメント 669</h1><ul><li>ホスト:&nbsp;${forbiddenValues[0]}</li>` +
      `<li>IPアドレス: ${forbiddenValues[1]}</li><li>User-Agent: ${forbiddenValues[2]}</li>` +
      `<li>セッション: ${forbiddenValues[3]}</li></ul>`,
  );
  const request = fakeRequestContext({
    [DETAIL_URL]: { html: targetHtml },
    [searchUrl]: { html: searchDocument([]) },
  });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const result = await connector.getAuthorHistory({
    groupKey: "g",
    topicNumber: "413",
    commentNumber: "669",
    limit: 10,
  });
  const serialized = JSON.stringify(result);
  // 投稿履歴は判断材料だけを返す。公開URLは通常の判断に要らないので含めない。
  assert.deepEqual(Object.keys(result.targetComment).sort(), [
    "body",
    "commentNumber",
    "currentState",
    "topicNumber",
  ]);
  for (const forbidden of forbiddenValues) assert.ok(!serialized.includes(forbidden));
});

/** MCPへ返す構造に最初から含まれてはならない項目名。値ではなく形で押さえる。 */
const FORBIDDEN_FIELD_NAMES = [
  "reporterName",
  "reporterTrip",
  "reporterKey",
  "hostValue",
  "host",
  "port",
  "ipAddress",
  "remoteAddr",
  "userAgent",
  "cookie",
  "session",
  "sessionId",
  "csrfToken",
  "_csrf",
];

function fieldNamesOf(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) fieldNamesOf(entry, names);
    return names;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      names.add(key);
      fieldNamesOf(entry, names);
    }
  }
  return names;
}

test("読み切れていない通報表の打ち切りと総件数を、通報行と同じ経路で返す", async () => {
  const detailHtml = detailDocument({
    source: "本文",
    reportTables: [
      {
        headers: ["報告メッセージ", "通報日時", ""],
        rows: [{ key: "r1", cells: [messageCell({ text: "宣伝です" }), "2026/08/18 (火) 10:00:00", ""] }],
        summary: "25件中 1件から1件までを表示",
        paginated: true,
      },
    ],
  });
  const request = fakeRequestContext({ [DETAIL_URL]: { html: detailHtml } });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const [comment] = await connector.getComments([
    { groupKey: "g", topicNumber: "413", commentNumber: "669" },
  ]);

  assert.equal(comment.openReports.length, 1);
  assert.equal(comment.openReportsTruncated, true);
  assert.equal(comment.openReportsTotalCount, 25);
});

test("MCPへ返す読み取り結果は項目許可リストだけで構築される", async () => {
  const detailHtml = detailDocument({
    source: "本文",
    metadataItems: [["ホスト", "internal-only.example"]],
    reportTables: [
      {
        headers: ["報告メッセージ", "通報日時", ""],
        rows: [
          {
            key: "r1",
            cells: [
              messageCell({
                text: "宣伝です",
                sender: { prefix: "送信者: ", name: "通報者A", trip: "◆abc123" },
              }),
              "2026/08/18 (火) 10:00:00",
              "",
            ],
          },
        ],
      },
    ],
  });
  const request = fakeRequestContext({ [DETAIL_URL]: { html: detailHtml } });
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const [comment] = await connector.getComments([
    { groupKey: "g", topicNumber: "413", commentNumber: "669" },
  ]);

  // 通報者名やトリップは低レベルのparserが内部判定のために読んでよいが、
  // MCPへ返す構造の項目にはならない。
  const names = fieldNamesOf(comment);
  for (const forbidden of FORBIDDEN_FIELD_NAMES) {
    assert.ok(!names.has(forbidden), `${forbidden}が読み取り結果に含まれています`);
  }
  const allowed = new Set([
    ...AUTHOR_COMMENT_FIELDS,
    "openReports",
    "openReportsTruncated",
    "openReportsTotalCount",
    ...OPEN_REPORT_FIELDS,
    "reportsError",
    "code",
    "message",
  ]);
  for (const name of names) {
    assert.ok(allowed.has(name), `許可リストにない項目です: ${name}`);
  }
  assert.deepEqual(
    Object.keys(comment.openReports[0]).filter((name) => !OPEN_REPORT_FIELDS.includes(name)),
    [],
  );
  assert.ok(OPEN_REPORT_LIST_FIELDS.every((name) => !FORBIDDEN_FIELD_NAMES.includes(name)));
});

test("照合専用入口は送信準備もPOSTもせず、管理画面の削除証拠だけを読む", async () => {
  const html = detailDocument({ source: "本文", values: { 削除済み: "はい", 無視: "いいえ" } });
  const request = fakeRequestContext({ [DETAIL_URL]: { html } });
  let posts = 0;
  request.post = async () => { posts += 1; throw new Error("送信禁止"); };
  const connector = createZawazawaConnector({ browserType: fakeBrowserType(request) });
  const input = { groupKey: "g", topicNumber: "413", commentNumber: "669" };
  const result = await connector.reconcileApprovedOperation({ ...input, operationType: "comment_delete" });
  assert.equal(result.effect, true);
  assert.equal((await connector.reconcileApprovedOperation({ ...input, operationType: "report_complete" })).effect, undefined);
  assert.equal(posts, 0);
  await connector.close();
});
