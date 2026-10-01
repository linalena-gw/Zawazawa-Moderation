import assert from "node:assert/strict";
import test from "node:test";
import { connectorErrorResult, resolveItemReferences } from "../server/references.mjs";
import { ZawazawaConnectorError } from "../server/identifiers.mjs";

// 対象グループはサーバーが対象コンテキストから解決した値で、itemには現れない。
function resolveReferences(items, connector, publicReader, groupKey = "genshinwiki") {
  return resolveItemReferences({ items, groupKey, connector, publicReader });
}

function fakeConnector(bodies, openReports = {}, reportFacts = {}) {
  const calls = [];
  return {
    calls,
    async getComments(requests) {
      calls.push(requests);
      return requests.map((request) => ({
        openReports: openReports[request.commentNumber] || [],
        openReportsTruncated: false,
        openReportsTotalCount: (openReports[request.commentNumber] || []).length,
        ...(reportFacts[request.commentNumber] || {}),
        commentNumber: request.commentNumber,
        topicNumber: request.topicNumber,
        body: bodies[request.commentNumber],
        createdAt: "2026-08-17 10:00",
        currentState: "公開中",
        parentCommentNumber: request.commentNumber === "96518" ? "96517" : undefined,
        publicUrl: `https://z.wikiwiki.jp/${request.groupKey}/topic/${request.topicNumber}/${request.commentNumber}`,
      }));
    },
  };
}

test("本文なしの参照を管理画面の本文で解決する", async () => {
  const connector = fakeConnector({ 96517: "取得元の本文", 96518: "枝の本文" });
  const items = [
    {
      id: "96517",
      comments: [
        { topicNumber: "345", commentNumber: "96517" },
        { topicNumber: "345", commentNumber: "96518" },
      ],
    },
  ];

  await resolveReferences(items, connector);

  assert.deepEqual(items[0].comments[0], {
    commentNumber: "96517",
    topicNumber: "345",
    body: "取得元の本文",
    createdAt: "2026-08-17 10:00",
    currentState: "公開中",
    url: "https://z.wikiwiki.jp/genshinwiki/topic/345/96517",
  });
  assert.equal(items[0].comments[1].body, "枝の本文");
  assert.equal(items[0].comments[1].parentCommentNumber, "96517");
  assert.equal(items[0].comments[0].groupKey, undefined);
});

test("手渡し本文が混じっても参照元の本文で置き換える", async () => {
  const connector = fakeConnector({ 96517: "取得元の本文" });
  const items = [
    {
      id: "96517",
      comments: [
        { topicNumber: "345", commentNumber: "96517", body: "手渡しの本文" },
      ],
    },
  ];

  await resolveReferences(items, connector);

  assert.equal(items[0].comments[0].body, "取得元の本文");
  assert.equal(connector.calls.length, 1);
});

test("同じ参照は一度だけ取得する", async () => {
  const connector = fakeConnector({ 96517: "本文" });
  const items = [
    {
      id: "96517",
      comments: [{ topicNumber: "345", commentNumber: "96517" }],
      history: [{ topicNumber: "345", commentNumber: "96517" }],
    },
  ];

  await resolveReferences(items, connector);

  assert.equal(connector.calls.length, 1);
  assert.equal(connector.calls[0].length, 1);
  assert.equal(items[0].comments[0].body, "本文");
  assert.equal(items[0].history[0].body, "本文");
});

test("対象グループが解決されていなければ取得前に止める", async () => {
  const connector = fakeConnector({});
  const items = [
    { id: "96517", comments: [{ topicNumber: "345", commentNumber: "96517" }] },
  ];

  await assert.rejects(
    resolveItemReferences({ items, connector }),
    (error) =>
      error instanceof ZawazawaConnectorError && error.code === "invalid_input",
  );
  assert.equal(connector.calls.length, 0);
});

test("コネクタの失敗をerrorCode付きの結果として返す", () => {
  const result = connectorErrorResult(
    new ZawazawaConnectorError("reauth_required", "再認証が必要です。"),
  );
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorCode, "reauth_required");
  assert.equal(result.structuredContent.nextAction, "reauth");
  assert.match(result.content[0].text, /\[reauth_required\]/u);
});

test("型のない失敗はunknownとして返す", () => {
  const unsafeCause = "request failed with private diagnostic value";
  const result = connectorErrorResult(new Error(unsafeCause));
  assert.equal(result.structuredContent.errorCode, "unknown");
  assert.equal(result.structuredContent.nextAction, "browser");
  assert.ok(!JSON.stringify(result).includes(unsafeCause));
});

function fakePublicReader(pages, topicNames = { "genshinwiki/345": "雑談/オデット" }) {
  const calls = [];
  const topicNameCalls = [];
  return {
    calls,
    topicNameCalls,
    async readTopicName({ groupKey, topicNumber }) {
      topicNameCalls.push(`${groupKey}/${topicNumber}`);
      return topicNames[`${groupKey}/${topicNumber}`];
    },
    async collectComments({ groupKey, topicNumber }, wanted) {
      calls.push({ groupKey, topicNumber, wanted });
      const page = pages[`${groupKey}/${topicNumber}`];
      if (page instanceof Error) throw page;
      const comments = new Map();
      for (const comment of page || []) comments.set(comment.commentNumber, comment);
      return {
        comments,
        pagesRead: [1],
        missing: (wanted || []).filter((number) => !comments.has(number)),
        truncated: false,
      };
    },
  };
}

function itemWithContext() {
  return {
    id: "96517",
    comments: [
      { topicNumber: "345", commentNumber: "96517" },
      { topicNumber: "345", commentNumber: "96518" },
    ],
    recommendation: { targets: [{ commentNumber: "96517" }] },
  };
}

test("処置対象は管理画面から、文脈コメントは公開ページから読む", async () => {
  const connector = fakeConnector({ 96517: "管理画面の原文" });
  const publicReader = fakePublicReader({
    "genshinwiki/345": [
      {
        commentNumber: "96518",
        body: "公開ページの本文",
        displayName: "名無しの旅人",
        createdAt: "2026/08/17 (月) 22:25:40",
        parentCommentNumber: "96517",
      },
    ],
  });

  const items = [itemWithContext()];
  await resolveReferences(items, connector, publicReader);

  assert.equal(items[0].comments[0].body, "管理画面の原文");
  assert.equal(items[0].comments[1].body, "公開ページの本文");
  assert.equal(items[0].comments[1].currentState, "公開中");
  assert.equal(items[0].comments[1].displayName, "名無しの旅人");
  assert.equal(
    items[0].comments[1].url,
    "https://z.wikiwiki.jp/genshinwiki/topic/345/96518",
  );
  // 管理画面は処置対象の1件しか開かない。
  assert.equal(connector.calls.length, 1);
  assert.deepEqual(
    connector.calls[0].map((request) => request.commentNumber),
    ["96517"],
  );
  assert.deepEqual(publicReader.calls[0].wanted, ["96518"]);
});

test("投稿履歴は現在状態が要るので公開ページへ回さない", async () => {
  const connector = fakeConnector({ 96400: "履歴の本文" });
  const publicReader = fakePublicReader({ "genshinwiki/345": [] });
  const items = [
    {
      id: "96517",
      comments: [{ topicNumber: "345", commentNumber: "96517" }],
      history: [{ topicNumber: "345", commentNumber: "96400" }],
      recommendation: { targets: [{ commentNumber: "96517" }] },
    },
  ];

  await resolveReferences(items, connector, publicReader);

  assert.equal(items[0].history[0].body, "履歴の本文");
  assert.equal(publicReader.calls.length, 0);
});

test("通報表を読むのは処置対象だけで、投稿履歴は軽い経路で解決する", async () => {
  const connector = fakeConnector({ 96517: "管理画面の原文", 96400: "履歴の本文" });
  const publicReader = fakePublicReader({ "genshinwiki/345": [] });
  const items = [itemWithContext()];
  items[0].history = [{ topicNumber: "345", commentNumber: "96400" }];

  await resolveReferences(items, connector, publicReader);

  // 並行枠を分けないため管理画面の取得は一度にまとめる。
  assert.equal(connector.calls.length, 1);
  assert.deepEqual(
    connector.calls[0].map((request) => [request.commentNumber, request.includeReports]),
    [
      ["96517", undefined],
      ["96400", false],
      ["96518", false],
    ],
  );
});

test("単位レベルのリンクは処置の実行順ではなくitem.idのコメントを指す", async () => {
  const connector = fakeConnector(
    { 96517: "管理画面の原文", 96518: "枝の本文" },
    { 96518: [{ reportId: "10004", reason: "煽り" }] },
  );
  const publicReader = fakePublicReader({ "genshinwiki/345": [] });

  const items = [itemWithContext()];
  // 通報されたのは96517だが、処置対象は枝の96518だけという単位。
  items[0].recommendation.targets = [{ commentNumber: "96518" }];

  await resolveReferences(items, connector, publicReader);

  assert.equal(items[0].publicUrl, "https://z.wikiwiki.jp/genshinwiki/topic/345/96517");
  assert.equal(
    items[0].adminUrl,
    "https://z.wikiwiki.jp/m/genshinwiki/comment/345/96517",
  );
});

test("表題はトピック名と処置対象のコメント番号だけで組み立てる", async () => {
  const connector = fakeConnector({ 96517: "管理画面の原文" });
  const publicReader = fakePublicReader({ "genshinwiki/345": [] });

  const items = [itemWithContext()];
  await resolveReferences(items, connector, publicReader);

  assert.equal(items[0].title, "雑談/オデット #96517");
});

test("処置対象が複数の表題は番号を並べ、多い分は件数へまとめる", async () => {
  const bodies = {};
  const comments = [];
  const targets = [];
  for (let index = 0; index < 4; index += 1) {
    const commentNumber = String(96517 + index);
    bodies[commentNumber] = "管理画面の原文";
    comments.push({ topicNumber: "345", commentNumber });
    targets.push({ commentNumber });
  }
  const connector = fakeConnector(bodies);
  const publicReader = fakePublicReader({ "genshinwiki/345": [] });

  const items = [{ id: "96517", comments, recommendation: { targets } }];
  await resolveReferences(items, connector, publicReader);

  assert.equal(items[0].title, "雑談/オデット #96517 #96518 #96519 ほか1件");
});

test("トピック名を読めない場合はトピック番号で代え、一覧を止めない", async () => {
  const connector = fakeConnector({ 96517: "管理画面の原文" });
  const publicReader = fakePublicReader({ "genshinwiki/345": [] }, {});

  const items = [itemWithContext()];
  await resolveReferences(items, connector, publicReader);

  assert.equal(items[0].title, "トピック345 #96517");
});

test("長すぎるトピック名は表題でも行の出所でも切り詰める", async () => {
  // トピック名は公開ページの描画から読むので長さの保証が無い。保存済み一覧と見出しが
  // 一件で膨らまないよう、見分けが付く長さで切る。行の出所は行の数だけ同じ名前を持つので、
  // 表題だけを切っても膨らみは止まらない。
  const longName = "あ".repeat(200);
  const connector = fakeConnector({ 96517: "管理画面の原文" });
  const publicReader = fakePublicReader({ "genshinwiki/345": [] }, { "genshinwiki/345": longName });

  const items = [itemWithContext()];
  await resolveReferences(items, connector, publicReader);

  assert.equal(items[0].title, `${"あ".repeat(60)}… #96517`);
  assert.equal(items[0].comments[0].topicName, `${"あ".repeat(60)}…`);
});

test("トピック名は管理画面の取得より先に読み、公開ページの取得をまとめる", async () => {
  // 管理画面の取得はブラウザ経由で長く、間に挟むと公開ページの取得キャッシュが切れる。
  const order = [];
  const connector = fakeConnector({ 96517: "管理画面の原文" });
  const publicReader = fakePublicReader({ "genshinwiki/345": [] });
  const { getComments } = connector;
  connector.getComments = (requests) => {
    order.push("admin");
    return getComments(requests);
  };
  const { readTopicName } = publicReader;
  publicReader.readTopicName = (reference) => {
    order.push("topicName");
    return readTopicName(reference);
  };

  await resolveReferences([itemWithContext()], connector, publicReader);

  assert.deepEqual(order, ["topicName", "admin"]);
});

test("公開ページのreaderが無くても表題を組み立てる", async () => {
  const connector = fakeConnector({ 96517: "管理画面の原文", 96518: "枝の本文" });

  const items = [itemWithContext()];
  await resolveReferences(items, connector);

  assert.equal(items[0].title, "トピック345 #96517");
});

test("別トピックから拾った文脈にも、その行のトピック名を付ける", async () => {
  // 表題のトピックだけ名前を読むと、別の掲示板から拾った行が番号だけで並び、どこから
  // 拾った文脈なのかを管理者が見分けられない。
  const connector = fakeConnector({ 96517: "管理画面の原文" });
  const publicReader = fakePublicReader(
    {
      "genshinwiki/345": [],
      "genshinwiki/2": [{ commentNumber: "2438", body: "別トピックの本文" }],
    },
    { "genshinwiki/345": "雑談/オデット", "genshinwiki/2": "管理連絡掲示板" },
  );

  const items = [
    {
      id: "96517",
      comments: [
        { topicNumber: "345", commentNumber: "96517" },
        { topicNumber: "2", commentNumber: "2438" },
      ],
      recommendation: { targets: [{ commentNumber: "96517" }] },
    },
  ];
  await resolveReferences(items, connector, publicReader);

  assert.equal(items[0].comments[0].topicName, "雑談/オデット");
  assert.equal(items[0].comments[1].topicNumber, "2");
  assert.equal(items[0].comments[1].topicName, "管理連絡掲示板");
});

test("同じ単位でコメント番号が別トピックと重なる参照は取得の前に止める", async () => {
  // 処置対象も役割もコメント行の対処案も、単位の中を番号だけで指す。番号が重なると
  // どの投稿への操作なのかが決まらない。
  const connector = fakeConnector({ 96517: "管理画面の原文" });

  await assert.rejects(
    resolveReferences(
      [
        {
          id: "96517",
          comments: [
            { topicNumber: "345", commentNumber: "96517" },
            { topicNumber: "2", commentNumber: "96517" },
          ],
          recommendation: { targets: [{ commentNumber: "96517" }] },
        },
      ],
      connector,
    ),
    (error) =>
      error instanceof ZawazawaConnectorError &&
      error.code === "invalid_input" &&
      error.message.includes("96517"),
  );
  assert.equal(connector.calls.length, 0);
});

test("同じトピックのトピック名は単位ごとに読み直さない", async () => {
  const connector = fakeConnector({ 96517: "管理画面の原文", 96520: "別単位の原文" });
  const publicReader = fakePublicReader({ "genshinwiki/345": [] });

  const items = [
    {
      id: "96517",
      comments: [{ topicNumber: "345", commentNumber: "96517" }],
      recommendation: { targets: [{ commentNumber: "96517" }] },
    },
    {
      id: "96520",
      comments: [{ topicNumber: "345", commentNumber: "96520" }],
      recommendation: { targets: [{ commentNumber: "96520" }] },
    },
  ];
  await resolveReferences(items, connector, publicReader);

  assert.deepEqual(publicReader.topicNameCalls, ["genshinwiki/345"]);
  assert.equal(items[1].title, "雑談/オデット #96520");
});

test("公開ページに無い文脈コメントは管理画面へ回す", async () => {
  const connector = fakeConnector({ 96517: "管理画面の原文", 96518: "削除済みの本文" });
  const publicReader = fakePublicReader({ "genshinwiki/345": [] });

  const items = [itemWithContext()];
  await resolveReferences(items, connector, publicReader);

  assert.equal(items[0].comments[1].body, "削除済みの本文");
  assert.deepEqual(
    connector.calls[0].map((request) => request.commentNumber),
    ["96517", "96518"],
  );
});

test("公開ページの読み取り失敗で一覧作成を止めず、管理画面へ落とす", async () => {
  const connector = fakeConnector({ 96517: "管理画面の原文", 96518: "管理画面の枝" });
  const publicReader = fakePublicReader({
    "genshinwiki/345": new ZawazawaConnectorError("rate_limited", "制限中"),
  });

  const items = [itemWithContext()];
  await resolveReferences(items, connector, publicReader);

  assert.equal(items[0].comments[1].body, "管理画面の枝");
  assert.equal(items[0].comments[1].currentState, "公開中");
});

test("公開ページ経由でもグループキーを残さず、行の出所は残す", async () => {
  const connector = fakeConnector({ 96517: "管理画面の原文" });
  const publicReader = fakePublicReader({
    "genshinwiki/345": [{ commentNumber: "96518", body: "公開ページの本文" }],
  });

  const items = [itemWithContext()];
  await resolveReferences(items, connector, publicReader);

  assert.equal(items[0].comments[1].groupKey, undefined);
  assert.equal(items[0].comments[1].topicNumber, "345");
  assert.equal(items[0].comments[1].topicName, "雑談/オデット");
});

test("処置対象の未処理通報を管理画面から読み、対象と識別子を付ける", async () => {
  const connector = fakeConnector(
    { 96517: "管理画面の原文" },
    {
      96517: [
        {
          reportId: "10001",
          reason: "煽り",
          createdAt: "2026/08/20 17:50:31",
          repeatAfterResponse: true,
        },
        { reportId: "10002", reason: "", createdAt: "2026/08/20 18:02:10" },
      ],
    },
  );
  const publicReader = fakePublicReader({
    "genshinwiki/345": [{ commentNumber: "96518", body: "公開ページの本文" }],
  });

  const items = [itemWithContext()];
  await resolveReferences(items, connector, publicReader);

  assert.deepEqual(items[0].reports, [
    {
      reportId: "10001",
      targetCommentNumber: "96517",
      reason: "煽り",
      createdAt: "2026/08/20 17:50:31",
      repeatAfterResponse: true,
    },
    {
      reportId: "10002",
      targetCommentNumber: "96517",
      reason: "",
      createdAt: "2026/08/20 18:02:10",
      repeatAfterResponse: false,
    },
  ]);
});

test("読み切れていない通報表を、打ち切りと総件数として処理単位へ残す", async () => {
  // 読めた行だけを渡すと、一覧は読めた件数を全部として出す。管理者が他にも通報が
  // あることを知らないまま判断しないよう、打ち切りの有無を通報行と同じ経路で持たせる。
  const connector = fakeConnector(
    { 96517: "管理画面の原文" },
    { 96517: [{ reportId: "10001", reason: "煽り", createdAt: "2026/08/20 17:50:31" }] },
    { 96517: { openReportsTruncated: true, openReportsTotalCount: 25 } },
  );

  const items = [itemWithContext()];
  await resolveReferences(items, connector, fakePublicReader({ "genshinwiki/345": [] }));

  assert.equal(items[0].reports.length, 1);
  assert.equal(items[0].reportsTruncated, true);
  assert.equal(items[0].reportTotalCount, 25);
});

test("総件数を読めない打ち切りでは、通報の総件数を持たせない", async () => {
  const connector = fakeConnector(
    { 96517: "管理画面の原文" },
    { 96517: [{ reportId: "10001", reason: "煽り" }] },
    { 96517: { openReportsTruncated: true, openReportsTotalCount: undefined } },
  );

  const items = [itemWithContext()];
  await resolveReferences(items, connector, fakePublicReader({ "genshinwiki/345": [] }));

  assert.equal(items[0].reportsTruncated, true);
  assert.equal(items[0].reportTotalCount, undefined);
});

test("読めた行と同数の総件数は、打ち切られた対象の総件数として受けない", async () => {
  // 読み切れていないのに残りが0件という数になる。一覧はこの単位を作れず止まるため、
  // 総件数を持たせずに読み切れていないことだけを残す。
  const connector = fakeConnector(
    { 96517: "管理画面の原文" },
    { 96517: [{ reportId: "10001", reason: "煽り" }] },
    { 96517: { openReportsTruncated: true, openReportsTotalCount: 1 } },
  );

  const items = [itemWithContext()];
  await resolveReferences(items, connector, fakePublicReader({ "genshinwiki/345": [] }));

  assert.equal(items[0].reportsTruncated, true);
  assert.equal(items[0].reportTotalCount, undefined);
});

test("処置対象が複数ある単位の総件数は、読み切れた対象の行数と合算する", async () => {
  const connector = fakeConnector(
    { 96517: "管理画面の原文", 96518: "枝の原文" },
    {
      96517: [{ reportId: "10001", reason: "煽り" }],
      96518: [{ reportId: "10002", reason: "宣伝" }],
    },
    { 96517: { openReportsTruncated: true, openReportsTotalCount: 25 } },
  );
  const items = [
    {
      id: "96517",
      comments: [
        { topicNumber: "345", commentNumber: "96517" },
        { topicNumber: "345", commentNumber: "96518" },
      ],
      recommendation: {
        targets: [{ commentNumber: "96517" }, { commentNumber: "96518" }],
      },
    },
  ];

  await resolveReferences(items, connector);

  assert.equal(items[0].reportsTruncated, true);
  assert.equal(items[0].reportTotalCount, 26);
});

test("読み切れた処置対象では打ち切りを立てない", async () => {
  const connector = fakeConnector(
    { 96517: "管理画面の原文" },
    { 96517: [{ reportId: "10001", reason: "煽り" }] },
  );

  const items = [itemWithContext()];
  await resolveReferences(items, connector, fakePublicReader({ "genshinwiki/345": [] }));

  assert.equal(items[0].reportsTruncated, false);
  assert.equal(items[0].reportTotalCount, undefined);
});

test("通報表を読めなかった処置対象を0件にせず止める", async () => {
  // 通報表の失敗は本文の解決を巻き込まないが、処置対象の未処理通報が未確認のまま
  // 判断へ進むのは通報の見落としになる。
  const connector = {
    async getComments(requests) {
      return requests.map((request) => ({
        commentNumber: request.commentNumber,
        topicNumber: request.topicNumber,
        body: "管理画面の原文",
        openReports: undefined,
        reportsError: { code: "page_changed", message: "通報表が見つかりません。" },
      }));
    },
  };

  await assert.rejects(
    resolveReferences([itemWithContext()], connector),
    (error) =>
      error instanceof ZawazawaConnectorError &&
      error.code === "page_changed" &&
      /96517/u.test(error.message) &&
      /0件として扱わないでください/u.test(error.message),
  );
});

test("通報が不要な参照は、通報表を読めなくても本文を解決する", async () => {
  const connector = {
    async getComments(requests) {
      return requests.map((request) => ({
        commentNumber: request.commentNumber,
        topicNumber: request.topicNumber,
        body: "投稿履歴の本文",
        currentState: "削除済み",
        openReports: undefined,
        reportsError: { code: "page_changed", message: "通報表が見つかりません。" },
      }));
    },
  };
  const items = [
    {
      id: "96517",
      comments: [{ topicNumber: "345", commentNumber: "96517" }],
      history: [{ topicNumber: "345", commentNumber: "96400" }],
    },
  ];

  await resolveReferences(items, connector);

  assert.equal(items[0].history[0].body, "投稿履歴の本文");
  assert.equal(items[0].history[0].currentState, "削除済み");
});

test("処置対象の通報を読むために管理画面を余分に開かない", async () => {
  const connector = fakeConnector({ 96517: "管理画面の原文" }, { 96517: [] });
  const publicReader = fakePublicReader({
    "genshinwiki/345": [{ commentNumber: "96518", body: "公開ページの本文" }],
  });

  const items = [itemWithContext()];
  await resolveReferences(items, connector, publicReader);

  assert.equal(connector.calls.length, 1);
  assert.deepEqual(
    connector.calls[0].map((request) => request.commentNumber),
    ["96517"],
  );
});

test("複数の処置対象に付いた通報を参照からすべて解決する", async () => {
  const connector = fakeConnector(
    { 96517: "管理画面の原文", 96518: "枝の本文" },
    {
      96517: [{ reportId: "10001", reason: "煽り" }],
      96518: [{ reportId: "10003", reason: "枝への通報" }],
    },
  );
  const publicReader = fakePublicReader({ "genshinwiki/345": [] });

  const items = [itemWithContext()];
  items[0].recommendation.targets.push({ commentNumber: "96518" });

  await resolveReferences(items, connector, publicReader);

  assert.deepEqual(
    items[0].reports.map((report) => [report.targetCommentNumber, report.reportId]),
    [["96517", "10001"], ["96518", "10003"]],
  );
  assert.deepEqual(
    items[0].recommendation.targets.map((target) => target.currentState),
    ["公開中", "公開中"],
  );
});

test("参照の無い処置対象は未確認として持ち回らず停止する", async () => {
  const connector = fakeConnector({ 96517: "管理画面の原文" }, { 96517: [] });
  const publicReader = fakePublicReader({ "genshinwiki/345": [] });

  const items = [itemWithContext()];
  items[0].recommendation.targets.push({ commentNumber: "99999" });
  await assert.rejects(
    resolveReferences(items, connector, publicReader),
    (error) => error.code === "invalid_input" && /99999/u.test(error.message),
  );
});

test("本文や通報を手渡ししても処置対象の参照が無ければ停止する", async () => {
  const connector = fakeConnector({});
  const items = [
    {
      id: "96517",
      comments: [{ commentNumber: "96517", body: "手渡しの本文" }],
      recommendation: { targets: [{ commentNumber: "96517" }] },
    },
  ];

  await assert.rejects(
    resolveReferences(items, connector),
    (error) => error.code === "invalid_input",
  );
});
