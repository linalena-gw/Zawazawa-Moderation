import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublicReader,
  htmlToText,
  MAX_RESPONSE_BYTES,
  parseTopicFeed,
  parseTopicPage,
} from "../server/public-reader.mjs";

/** 実ページと同じ構造の合成フィクスチャ。実際の投稿内容はリポジトリへ置かない。 */
function commentBlock({ number, name, timestamp, body, parent }) {
  const parentLink = parent
    ? `<a class="comment-parent-link comment-parent-link-muted" href="/testgroup/topic/413/${parent}">&gt;&gt; ${parent}</a>`
    : "";
  return `<div class="comment css-customizable-for-comment" id="comment-${number}"><div class="content clearfix"><div class="comment-icon-container"><div class="comment-number">${number}</div></div><div class="comment-header-body-container"><div class="header"><span class="posted-user"><strong><span class="text-muted">${name}</span></strong></span><small class="comment-timestamp"><a href="/testgroup/topic/413/${number}">${timestamp}</a></small><small class="hashed-track-info" data-hashed-tracking-cookie="0123456789abcdef0123">ID:0123abcd</small>${parentLink}</div><div class="body">${body}</div></div></div>`;
}

function titleBlock(topicName) {
  return `<div class="title-block"><h1 class="forum-title">テストWiki</h1><h2 class="page-title">${topicName}</h2></div>`;
}

function topicPage({ blocks, maxComment = "570", pagerPages = [2], topicName = "雑談/オデット" }) {
  return `<!DOCTYPE html><html><body>${
    topicName ? titleBlock(topicName) : ""
  }<div id="comment-list-pjax" data-max-comment-number="${maxComment}">${blocks.join(
    "",
  )}</div>${
    pagerPages.length
      ? `<ul class="pagination">${pagerPages
          .map((page) => `<li><a href="/testgroup/topic/413?page=${page}">${page}</a></li>`)
          .join("")}</ul>`
      : ""
  }</body></html>`;
}

const SAMPLE = topicPage({
  blocks: [
    commentBlock({
      number: "566",
      name: "名無しの旅人",
      timestamp: "2026/08/17 (月) 22:20:11",
      body: "<p>一つ目の段落</p><p>二つ目の段落</p>",
    }),
    commentBlock({
      number: "567",
      name: "名無しの旅人",
      timestamp: "2026/08/17 (月) 22:25:40",
      body: "<p>返信本文<br>改行あり</p>",
      parent: "566",
    }),
  ],
});

test("公開トピックページからコメント番号・本文・投稿者・日時・親を読む", () => {
  const { comments, maxCommentNumber, pageNumbers } = parseTopicPage(SAMPLE);
  assert.equal(comments.length, 2);
  assert.deepEqual(comments[0], {
    commentNumber: "566",
    body: "一つ目の段落\n\n二つ目の段落",
    displayName: "名無しの旅人",
    createdAt: "2026/08/17 (月) 22:20:11",
    parentCommentNumber: undefined,
  });
  assert.equal(comments[1].parentCommentNumber, "566");
  assert.equal(comments[1].body, "返信本文\n改行あり");
  assert.equal(maxCommentNumber, "570");
  assert.deepEqual(pageNumbers, [2]);
});

test("本文クラスをheader-body-containerと取り違えない", () => {
  const { comments } = parseTopicPage(SAMPLE);
  assert.ok(!comments[0].body.includes("名無しの旅人"));
  assert.ok(!comments[0].body.includes("2026/08/17"));
});

test("接続元の追跡ハッシュを結果へ出さない", () => {
  const serialized = JSON.stringify(parseTopicPage(SAMPLE));
  assert.ok(!serialized.includes("0123456789abcdef0123"));
  assert.ok(!serialized.includes("ID:0123abcd"));
});

test("枝が入れ子でも親の本文を取り違えない", () => {
  const nested = `<!DOCTYPE html><html><body>${commentBlock({
    number: "600",
    name: "親",
    timestamp: "2026/08/18 (火) 10:00:00",
    body: "<p>親の本文</p>",
  })}<div class="child-comments">${commentBlock({
    number: "601",
    name: "枝",
    timestamp: "2026/08/18 (火) 10:05:00",
    body: "<p>枝の本文</p>",
    parent: "600",
  })}</div></div></body></html>`;
  const { comments } = parseTopicPage(nested);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].body, "親の本文");
  assert.equal(comments[1].body, "枝の本文");
});

test("描画済み本文を可視テキストへ落とす", () => {
  assert.equal(htmlToText("<p>a &amp; b</p><p>c&#39;d</p>"), "a & b\n\nc'd");
  assert.equal(htmlToText('<img src="x.png" alt="添付">'), "添付");
  assert.equal(htmlToText('<a href="https://example.com">example.com</a>'), "example.com");
  assert.equal(htmlToText("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"), "<script>alert(1)</script>");
  // altの引用符は描画側の都合で揺れる。取りこぼすと添付の存在ごと文脈から消える。
  assert.equal(htmlToText("<img src='x.png' alt='添付'>"), "添付");
  assert.equal(htmlToText("<img src=x.png alt=添付>"), "添付");
});

test("Unicodeの範囲外を指す数値文字参照でページの読み取りを落とさない", () => {
  // 投稿者が本文へ書ける文字列で解析を落とせる。HTMLの規定どおり置換文字へ倒し、
  // その1件でトピック全体の読み取りを失わないようにする。閲覧者のブラウザも同じ字を出す。
  assert.equal(htmlToText("<p>a&#99999999;b</p>"), "a\uFFFDb");
  assert.equal(htmlToText("<p>a&#xFFFFFFF;b</p>"), "a\uFFFDb");
  assert.equal(htmlToText("<p>a&#x1F600;b</p>"), "a\u{1F600}b");
});

test("引用の入れ子が深い本文でページの読み取りを落とさない", () => {
  // 投稿者は`>`を並べるだけで引用を好きな深さまで入れ子にできる。木の深さで
  // 呼び出し段数が増える走査だと、その1件でトピック全体の読み取りが落ちる。
  // 旧実装は5000あたりで呼び出し段数の上限に当たった。上限の有無を見る値であって、
  // 上限そのものを測る値ではないので、実行時間が要る値まで上げない。
  const depth = 8000;
  const deep = "<blockquote>".repeat(depth) + "深い引用" + "</blockquote>".repeat(depth);
  assert.equal(htmlToText(deep), "深い引用");

  const { comments } = parseTopicPage(
    topicPage({
      blocks: [
        commentBlock({
          number: "700",
          name: "名無しの旅人",
          timestamp: "2026/08/18 (火) 12:00:00",
          body: deep,
        }),
      ],
    }),
  );
  assert.equal(comments[0].body, "深い引用");
});

test("リンク以外に出るページ送りも拾い、読み残しを読み残しとして返せるようにする", () => {
  // ページ送りの取りこぼしは「これ以上ページが無い」という主張になる。
  const html = `<!DOCTYPE html><html><body><div id="comment-list-pjax" data-max-comment-number="570"></div>` +
    `<div class="pager" data-next-url="/testgroup/topic/413?page=3"></div>` +
    `<a href="/testgroup/topic/413?sort=old&amp;page=2">2</a></body></html>`;
  assert.deepEqual(parseTopicPage(html).pageNumbers, [2, 3]);
});

test("ページ送りが無いページを、余分な番号なしで最終ページとして読む", () => {
  const html = topicPage({
    blocks: [
      commentBlock({
        number: "566",
        name: "名無しの旅人",
        timestamp: "2026/08/17 (月) 22:20:11",
        body: "<p>本文</p>",
      }),
    ],
    pagerPages: [],
  });
  assert.deepEqual(parseTopicPage(html).pageNumbers, []);
});

test("RSSを番号・投稿者・日時の索引として読む", () => {
  const feed = parseTopicFeed(`<rss><channel><title>topic</title>
    <link>https://z.wikiwiki.jp/testgroup/topic/413</link>
    <item><title>t</title><link>https://z.wikiwiki.jp/testgroup/topic/413/669</link>
      <description>途中で切れた本文...</description><dc:creator>名無しの旅人</dc:creator>
      <dc:date>2026-08-20T18:13:56+09:00</dc:date></item>
    </channel></rss>`);
  assert.deepEqual(feed, [
    {
      topicNumber: "413",
      commentNumber: "669",
      displayName: "名無しの旅人",
      createdAt: "2026-08-20T18:13:56+09:00",
      preview: "途中で切れた本文...",
    },
  ]);
});

test("RSSのプレビューは、CDATAでも実体参照でも同じ可視テキストになる", () => {
  const feed = (description) =>
    parseTopicFeed(
      `<rss><channel><item><link>https://z.wikiwiki.jp/testgroup/topic/413/669</link>` +
        `<description>${description}</description></item></channel></rss>`,
    )[0].preview;
  assert.equal(feed("<![CDATA[<p>本文 &amp; ほか</p>]]>"), "本文 & ほか");
  assert.equal(feed("&lt;p&gt;本文 &amp;amp; ほか&lt;/p&gt;"), "本文 & ほか");
});

function stubFetch(routes) {
  const calls = [];
  const bodyReads = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const route = routes[new URL(url).pathname + new URL(url).search] ?? routes[url];
    const headers = { get: (name) => route?.headers?.[name.toLowerCase()] ?? null };
    if (!route) return { ok: false, status: 404, headers, text: async () => "" };
    return {
      ok: route.status < 400,
      status: route.status,
      headers,
      text: async () => {
        bodyReads.push(url);
        return route.body || "";
      },
    };
  };
  return { fetchImpl, calls, bodyReads };
}

test("申告された本文長が上限を超える公開ページは本文を読まずに止める", async () => {
  const { fetchImpl, bodyReads } = stubFetch({
    "/testgroup/topic/413": {
      status: 200,
      body: "<html></html>",
      headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
    },
  });
  const reader = createPublicReader({ fetchImpl });
  await assert.rejects(
    () => reader.readTopicPage({ groupKey: "testgroup", topicNumber: "413" }),
    (error) => error.code === "page_changed",
  );
  // 本文を読む前に断る。読み切ってから数えるだけでは上限の目的を果たさない。
  assert.deepEqual(bodyReads, []);
});

test("文字数が上限内でもUTF-8のバイト数が上限を超える応答は止める", async () => {
  // 3バイト文字300万字は文字数では上限内だが、バイト数では上限を超える。
  const body = "あ".repeat(3_000_000);
  assert.ok(body.length < MAX_RESPONSE_BYTES);
  assert.ok(Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES);
  const { fetchImpl } = stubFetch({ "/testgroup/topic/413": { status: 200, body } });
  const reader = createPublicReader({ fetchImpl });
  await assert.rejects(
    () => reader.readTopicPage({ groupKey: "testgroup", topicNumber: "413" }),
    (error) => error.code === "page_changed",
  );
});

test("見出し帯からトピック名を読む", () => {
  assert.equal(parseTopicPage(SAMPLE).topicName, "雑談/オデット");
});

test("見出し帯が無いページはトピック名を推測しない", () => {
  const page = topicPage({ blocks: [], topicName: null });
  assert.equal(parseTopicPage(page).topicName, undefined);
});

test("見出し帯を一意に特定できないページはトピック名を読まない", () => {
  // 投稿者が本文へ見出し帯そのものを書いた場合。どちらが画面の見出しかを決めない。
  const page = topicPage({
    blocks: [
      commentBlock({
        number: "566",
        name: "名無しの旅人",
        timestamp: "2026/08/17 (月) 22:20:11",
        body: '<div class="title-block"><h2 class="page-title">別トピック</h2></div>',
      }),
    ],
  });
  assert.equal(parseTopicPage(page).topicName, undefined);
});

test("トピック名の取得は1ページ目のキャッシュを使い、読めない場合は名前なしを返す", async () => {
  const { fetchImpl, calls } = stubFetch({
    "/testgroup/topic/413": { status: 200, body: SAMPLE },
  });
  const reader = createPublicReader({ fetchImpl });

  await reader.collectComments({ groupKey: "testgroup", topicNumber: "413" }, ["567"]);
  assert.equal(
    await reader.readTopicName({ groupKey: "testgroup", topicNumber: "413" }),
    "雑談/オデット",
  );
  // 文脈取得で読んだ1ページ目を使い回し、表題のために往復を増やさない。
  assert.equal(calls.length, 1);

  // 読めないトピックは表題を落とすだけで、例外にしない。
  assert.equal(
    await reader.readTopicName({ groupKey: "testgroup", topicNumber: "999" }),
    undefined,
  );
});

test("求めるコメントが古いページにある場合だけ遡る", async () => {
  const older = topicPage({
    blocks: [
      commentBlock({
        number: "400",
        name: "名無しの旅人",
        timestamp: "2026/08/10 (月) 09:00:00",
        body: "<p>古い投稿</p>",
      }),
    ],
    pagerPages: [],
  });
  const { fetchImpl, calls } = stubFetch({
    "/testgroup/topic/413": { status: 200, body: SAMPLE },
    "/testgroup/topic/413?page=2": { status: 200, body: older },
  });
  const reader = createPublicReader({ fetchImpl });

  const near = await reader.collectComments({ groupKey: "testgroup", topicNumber: "413" }, ["567"]);
  assert.deepEqual(near.pagesRead, [1]);
  assert.deepEqual(near.missing, []);

  const far = await reader.collectComments({ groupKey: "testgroup", topicNumber: "413" }, ["400"]);
  assert.deepEqual(far.pagesRead, [1, 2]);
  assert.deepEqual(far.missing, []);
  assert.equal(far.comments.get("400").body, "古い投稿");
  // 直前に読んだ同じトピックの1ページ目は、短いサーバー側キャッシュから再利用する。
  assert.equal(calls.length, 2);
});

test("target_treesは取得ページ全体と返却する対象木を分離する", async () => {
  const page = topicPage({
    blocks: [
      commentBlock({ number: "90", name: "別枝", timestamp: "09:00", body: "<p>別枝</p>" }),
      commentBlock({ number: "100", name: "親", timestamp: "10:00", body: "<p>親</p>" }),
      commentBlock({ number: "101", name: "子", timestamp: "10:01", body: "<p>子</p>", parent: "100" }),
      commentBlock({ number: "102", name: "対象", timestamp: "10:02", body: "<p>対象</p>", parent: "101" }),
      commentBlock({ number: "103", name: "兄弟枝", timestamp: "10:03", body: "<p>兄弟枝</p>", parent: "100" }),
      commentBlock({ number: "104", name: "孫", timestamp: "10:04", body: "<p>孫</p>", parent: "102" }),
    ],
    maxComment: "104",
    pagerPages: [],
  });
  const { fetchImpl } = stubFetch({ "/testgroup/topic/413": { status: 200, body: page } });
  const reader = createPublicReader({ fetchImpl, now: () => Date.parse("2026-08-22T01:02:03Z") });
  const result = await reader.collectComments(
    { groupKey: "testgroup", topicNumber: "413" },
    ["102"],
    { mode: "target_trees" },
  );

  assert.equal(result.mode, "target_trees");
  assert.deepEqual([...result.comments.keys()], ["100", "101", "102", "104"]);
  // 木は番号だけを持ち、本文は`comments`に1回だけ載る。
  assert.deepEqual(result.targetTrees[0].ancestorCommentNumbers, ["101", "100"]);
  assert.deepEqual(result.targetTrees[0].descendantCommentNumbers, ["104"]);
  assert.equal(result.targetTrees[0].targetAvailable, true);
  assert.equal(JSON.stringify(result.targetTrees).includes("対象"), false);
  assert.deepEqual(result.omittedCommentNumbers, ["90", "103"]);
  assert.equal(result.omittedCommentCount, 2);
  assert.equal(result.fetchedCommentCount, 6);
  assert.equal(result.returnedCommentCount, 4);
  assert.equal(result.checkedAt, "2026-08-22T01:02:03.000Z");
  assert.deepEqual(result.pagesRead, [1]);
  assert.equal(result.maxCommentNumber, "104");
});

test("target_treesの前後・兄弟は明示した予算内だけ返す", async () => {
  const page = topicPage({
    blocks: [
      commentBlock({ number: "100", name: "前", timestamp: "10:00", body: "<p>前</p>" }),
      commentBlock({ number: "101", name: "対象", timestamp: "10:01", body: "<p>対象</p>" }),
      commentBlock({ number: "102", name: "後", timestamp: "10:02", body: "<p>後</p>" }),
      commentBlock({ number: "103", name: "遠い後", timestamp: "10:03", body: "<p>遠い後</p>" }),
    ],
    pagerPages: [],
  });
  const { fetchImpl } = stubFetch({ "/testgroup/topic/413": { status: 200, body: page } });
  const reader = createPublicReader({ fetchImpl });
  const result = await reader.collectComments(
    { groupKey: "testgroup", topicNumber: "413" },
    ["101"],
    { mode: "target_trees", before: 1, after: 1, siblingRadius: 0 },
  );
  assert.deepEqual([...result.comments.keys()], ["100", "101", "102"]);
  assert.deepEqual(result.omittedCommentNumbers, ["103"]);
});

test("複数対象のbefore予算がページを跨ぐとき、充足まで追加取得しTTL内で再利用する", async () => {
  const newest = topicPage({
    blocks: [
      commentBlock({ number: "104", name: "前1", timestamp: "10:04", body: "<p>前1</p>" }),
      commentBlock({ number: "105", name: "対象A", timestamp: "10:05", body: "<p>A</p>" }),
      commentBlock({ number: "106", name: "対象B", timestamp: "10:06", body: "<p>B</p>" }),
    ],
    maxComment: "106",
    pagerPages: [2],
  });
  const older = topicPage({
    blocks: [
      commentBlock({ number: "102", name: "前3", timestamp: "10:02", body: "<p>前3</p>" }),
      commentBlock({ number: "103", name: "前2", timestamp: "10:03", body: "<p>前2</p>" }),
    ],
    maxComment: "106",
    pagerPages: [],
  });
  const { fetchImpl, calls } = stubFetch({
    "/testgroup/topic/413": { status: 200, body: newest },
    "/testgroup/topic/413?page=2": { status: 200, body: older },
  });
  const reader = createPublicReader({ fetchImpl, pageCacheTtlMs: 10_000 });
  const reference = { groupKey: "testgroup", topicNumber: "413" };
  const read = () =>
    // 先頭の106はpage 1だけで充足するが、2件目の105はpage 2が要る。
    reader.collectComments(reference, ["106", "105"], {
      mode: "target_trees",
      before: 2,
    });

  const result = await read();
  assert.deepEqual(result.pagesRead, [1, 2]);
  assert.deepEqual(
    result.targetTrees.map((tree) => tree.beforeCommentNumbers),
    [
      ["104", "105"],
      ["103", "104"],
    ],
  );
  assert.deepEqual(result.contextBudgetShortfalls, []);

  const cached = await read();
  assert.deepEqual(cached.pagesRead, [1, 2]);
  assert.equal(calls.length, 2);
});

test("siblingRadiusの古い側が次ページにあるとき、兄弟予算を満たすまで読む", async () => {
  const newest = topicPage({
    blocks: [
      commentBlock({ number: "105", name: "対象", timestamp: "10:05", body: "<p>対象</p>" }),
      commentBlock({ number: "106", name: "後の兄弟", timestamp: "10:06", body: "<p>後</p>" }),
    ],
    pagerPages: [2],
  });
  const older = topicPage({
    blocks: [
      commentBlock({ number: "104", name: "前の兄弟", timestamp: "10:04", body: "<p>前</p>" }),
    ],
    pagerPages: [],
  });
  const { fetchImpl } = stubFetch({
    "/testgroup/topic/413": { status: 200, body: newest },
    "/testgroup/topic/413?page=2": { status: 200, body: older },
  });
  const result = await createPublicReader({ fetchImpl }).collectComments(
    { groupKey: "testgroup", topicNumber: "413" },
    ["105"],
    { mode: "target_trees", siblingRadius: 1 },
  );

  assert.deepEqual(result.pagesRead, [1, 2]);
  assert.deepEqual(result.targetTrees[0].siblingCommentNumbers, ["104", "106"]);
  assert.deepEqual(result.contextBudgetShortfalls, []);
});

test("ページ上限で古い側の予算を満たせないとき、対象の不在と分けて不足を返す", async () => {
  const newest = topicPage({
    blocks: [
      commentBlock({ number: "104", name: "前1", timestamp: "10:04", body: "<p>前1</p>" }),
      commentBlock({ number: "105", name: "対象", timestamp: "10:05", body: "<p>対象</p>" }),
      commentBlock({ number: "106", name: "後1", timestamp: "10:06", body: "<p>後1</p>" }),
      commentBlock({ number: "107", name: "後2", timestamp: "10:07", body: "<p>後2</p>" }),
    ],
    pagerPages: [2],
  });
  const { fetchImpl, calls } = stubFetch({
    "/testgroup/topic/413": { status: 200, body: newest },
  });
  const result = await createPublicReader({ fetchImpl, maxPages: 1 }).collectComments(
    { groupKey: "testgroup", topicNumber: "413" },
    ["105"],
    { mode: "target_trees", before: 2, siblingRadius: 2 },
  );

  assert.deepEqual(result.pagesRead, [1]);
  assert.equal(calls.length, 1);
  assert.deepEqual(result.unavailableCommentNumbers, []);
  assert.deepEqual(result.missingCommentNumbers, []);
  assert.deepEqual(result.contextBudgetShortfalls, [
    {
      targetCommentNumber: "105",
      budget: "before",
      requestedCount: 2,
      returnedCount: 1,
      shortfallCount: 1,
      reason: "page_limit",
    },
    {
      targetCommentNumber: "105",
      budget: "siblingBefore",
      requestedCount: 2,
      returnedCount: 1,
      shortfallCount: 1,
      reason: "page_limit",
    },
  ]);
  assert.equal(result.truncated, true);
});

test("トピック境界まで読んでも予算に届かない方向を構造化して返す", async () => {
  const onlyPage = topicPage({
    blocks: [
      commentBlock({ number: "104", name: "前1", timestamp: "10:04", body: "<p>前1</p>" }),
      commentBlock({ number: "105", name: "対象", timestamp: "10:05", body: "<p>対象</p>" }),
    ],
    pagerPages: [],
  });
  const { fetchImpl } = stubFetch({
    "/testgroup/topic/413": { status: 200, body: onlyPage },
  });
  const result = await createPublicReader({ fetchImpl }).collectComments(
    { groupKey: "testgroup", topicNumber: "413" },
    ["105"],
    { mode: "target_trees", before: 2, after: 1 },
  );

  assert.deepEqual(result.contextBudgetShortfalls, [
    {
      targetCommentNumber: "105",
      budget: "before",
      requestedCount: 2,
      returnedCount: 1,
      shortfallCount: 1,
      reason: "topic_boundary",
    },
    {
      targetCommentNumber: "105",
      budget: "after",
      requestedCount: 1,
      returnedCount: 0,
      shortfallCount: 1,
      reason: "topic_boundary",
    },
  ]);
  assert.equal(result.truncated, false);
});

test("射影の省略、取得上限による未取得、最終ページでの不在を別々に返す", async () => {
  const unresolvedParent = topicPage({
    blocks: [
      commentBlock({ number: "200", name: "対象", timestamp: "10:00", body: "<p>対象</p>", parent: "50" }),
      commentBlock({ number: "201", name: "省略", timestamp: "10:01", body: "<p>省略</p>" }),
    ],
    pagerPages: [2],
  });
  const { fetchImpl } = stubFetch({
    "/testgroup/topic/413": { status: 200, body: unresolvedParent },
  });
  const limited = createPublicReader({ fetchImpl, maxPages: 1 });
  const unavailable = await limited.collectComments(
    { groupKey: "testgroup", topicNumber: "413" },
    ["200"],
    { mode: "target_trees" },
  );
  assert.deepEqual(unavailable.omittedCommentNumbers, ["201"]);
  assert.deepEqual(unavailable.unavailableCommentNumbers, ["50"]);
  assert.deepEqual(unavailable.missingCommentNumbers, []);
  assert.equal(unavailable.truncated, true);

  const finalPage = unresolvedParent.replace(/<ul class="pagination">[\s\S]*?<\/ul>/u, "");
  const finalFetch = stubFetch({
    "/testgroup/topic/413": { status: 200, body: finalPage },
  }).fetchImpl;
  const exhausted = await createPublicReader({ fetchImpl: finalFetch }).collectComments(
    { groupKey: "testgroup", topicNumber: "413" },
    ["200"],
    { mode: "target_trees" },
  );
  assert.deepEqual(exhausted.unavailableCommentNumbers, []);
  assert.deepEqual(exhausted.missingCommentNumbers, ["50"]);
  assert.equal(exhausted.truncated, false);
});

test("対象が不在でも親リンクから判明する取得済み子孫を返す", async () => {
  const pageWithKnownDescendants = ({ pagerPages }) =>
    topicPage({
      blocks: [
        commentBlock({
          number: "201",
          name: "子",
          timestamp: "10:01",
          body: "<p>子</p>",
          parent: "200",
        }),
        commentBlock({
          number: "202",
          name: "孫",
          timestamp: "10:02",
          body: "<p>孫</p>",
          parent: "201",
        }),
        commentBlock({ number: "203", name: "別枝", timestamp: "10:03", body: "<p>別枝</p>" }),
      ],
      pagerPages,
    });

  const finalFetch = stubFetch({
    "/testgroup/topic/413": { status: 200, body: pageWithKnownDescendants({ pagerPages: [] }) },
  }).fetchImpl;
  const missingTarget = await createPublicReader({ fetchImpl: finalFetch }).collectComments(
    { groupKey: "testgroup", topicNumber: "413" },
    ["200"],
    { mode: "target_trees" },
  );
  assert.equal(missingTarget.targetTrees[0].targetAvailable, false);
  assert.deepEqual(missingTarget.targetTrees[0].descendantCommentNumbers, ["201", "202"]);
  assert.deepEqual([...missingTarget.comments.keys()], ["201", "202"]);
  assert.deepEqual(missingTarget.omittedCommentNumbers, ["203"]);
  assert.deepEqual(missingTarget.missingCommentNumbers, ["200"]);
  assert.deepEqual(missingTarget.unavailableCommentNumbers, []);

  const limitedFetch = stubFetch({
    "/testgroup/topic/413": {
      status: 200,
      body: pageWithKnownDescendants({ pagerPages: [2] }),
    },
  }).fetchImpl;
  const unavailableTarget = await createPublicReader({
    fetchImpl: limitedFetch,
    maxPages: 1,
  }).collectComments(
    { groupKey: "testgroup", topicNumber: "413" },
    ["200"],
    { mode: "target_trees" },
  );
  assert.equal(unavailableTarget.targetTrees[0].targetAvailable, false);
  assert.deepEqual(unavailableTarget.targetTrees[0].descendantCommentNumbers, ["201", "202"]);
  assert.deepEqual([...unavailableTarget.comments.keys()], ["201", "202"]);
  assert.deepEqual(unavailableTarget.omittedCommentNumbers, ["203"]);
  assert.deepEqual(unavailableTarget.unavailableCommentNumbers, ["200"]);
  assert.deepEqual(unavailableTarget.missingCommentNumbers, []);
});

test("20桁番号のページ境界でも前後・兄弟・不足数を精度落ちなく判定する", async () => {
  const olderNumber = "18446744073709551614";
  const targetNumber = "18446744073709551615";
  const newerNumber = "18446744073709551616";
  const newest = topicPage({
    blocks: [
      commentBlock({ number: targetNumber, name: "対象", timestamp: "10:01", body: "<p>対象</p>" }),
      commentBlock({ number: newerNumber, name: "後", timestamp: "10:02", body: "<p>後</p>" }),
    ],
    maxComment: newerNumber,
    pagerPages: [2],
  });
  const older = topicPage({
    blocks: [
      commentBlock({ number: olderNumber, name: "前", timestamp: "10:00", body: "<p>前</p>" }),
    ],
    maxComment: newerNumber,
    pagerPages: [],
  });
  const { fetchImpl } = stubFetch({
    "/testgroup/topic/413": { status: 200, body: newest },
    "/testgroup/topic/413?page=2": { status: 200, body: older },
  });

  const result = await createPublicReader({ fetchImpl }).collectComments(
    { groupKey: "testgroup", topicNumber: "413" },
    [targetNumber],
    { mode: "target_trees", before: 1, siblingRadius: 2 },
  );
  assert.deepEqual(result.pagesRead, [1, 2]);
  assert.deepEqual(result.targetTrees[0].beforeCommentNumbers, [olderNumber]);
  assert.deepEqual(result.targetTrees[0].siblingCommentNumbers, [olderNumber, newerNumber]);
  assert.deepEqual(result.contextBudgetShortfalls, [
    {
      targetCommentNumber: targetNumber,
      budget: "siblingBefore",
      requestedCount: 2,
      returnedCount: 1,
      shortfallCount: 1,
      reason: "topic_boundary",
    },
    {
      targetCommentNumber: targetNumber,
      budget: "siblingAfter",
      requestedCount: 2,
      returnedCount: 1,
      shortfallCount: 1,
      reason: "topic_boundary",
    },
  ]);
});

test("同じトピック・ページをTTL内で共有し、期限後は取得時刻ごと更新する", async () => {
  let currentTime = Date.parse("2026-08-22T02:00:00Z");
  const { fetchImpl, calls } = stubFetch({
    "/testgroup/topic/413": { status: 200, body: SAMPLE },
  });
  const reader = createPublicReader({
    fetchImpl,
    pageCacheTtlMs: 1_000,
    now: () => currentTime,
  });
  const reference = { groupKey: "testgroup", topicNumber: "413" };

  const first = await reader.collectComments(reference, ["567"]);
  currentTime += 999;
  const cached = await reader.collectComments(reference, ["567"]);
  assert.equal(calls.length, 1);
  assert.equal(cached.checkedAt, first.checkedAt);

  currentTime += 1;
  const refreshed = await reader.collectComments(reference, ["567"]);
  assert.equal(calls.length, 2);
  assert.equal(refreshed.checkedAt, "2026-08-22T02:00:01.000Z");
  assert.deepEqual(refreshed.pagesRead, [1]);
  assert.equal(refreshed.maxCommentNumber, "570");
});

test("ページキャッシュはグループ・トピック・ページをすべてキーに含める", async () => {
  const { fetchImpl, calls } = stubFetch({
    "/testgroup/topic/413": { status: 200, body: SAMPLE },
    "/testgroup/topic/413?page=2": { status: 200, body: SAMPLE },
    "/testgroup/topic/414": { status: 200, body: SAMPLE },
    "/othergroup/topic/413": { status: 200, body: SAMPLE },
  });
  const reader = createPublicReader({ fetchImpl, pageCacheTtlMs: 10_000 });
  await reader.readTopicPage({ groupKey: "testgroup", topicNumber: "413" }, 1);
  await reader.readTopicPage({ groupKey: "testgroup", topicNumber: "413" }, 2);
  await reader.readTopicPage({ groupKey: "testgroup", topicNumber: "414" }, 1);
  await reader.readTopicPage({ groupKey: "othergroup", topicNumber: "413" }, 1);
  await reader.readTopicPage({ groupKey: "testgroup", topicNumber: "413" }, 1);
  assert.equal(calls.length, 4);
});

test("遡り切れない場合は不足分を明示し、勝手に打ち切らない", async () => {
  const deep = topicPage({
    blocks: [
      commentBlock({
        number: "566",
        name: "名無しの旅人",
        timestamp: "2026/08/17 (月) 22:20:11",
        body: "<p>本文</p>",
      }),
    ],
    pagerPages: [2, 3, 4, 5],
  });
  const { fetchImpl } = stubFetch({
    "/testgroup/topic/413": { status: 200, body: deep },
    "/testgroup/topic/413?page=2": { status: 200, body: deep },
    "/testgroup/topic/413?page=3": { status: 200, body: deep },
  });
  const reader = createPublicReader({ fetchImpl, maxPages: 3 });
  const result = await reader.collectComments(
    { groupKey: "testgroup", topicNumber: "413" },
    ["1"],
  );
  assert.deepEqual(result.pagesRead, [1, 2, 3]);
  assert.deepEqual(result.missing, ["1"]);
  assert.equal(result.truncated, true);
});

test("削除済みコメントは公開ページから消えたと判定する", async () => {
  const { fetchImpl } = stubFetch({
    "/testgroup/topic/413/566": { status: 200, body: SAMPLE },
    "/testgroup/topic/413/999": { status: 404, body: "" },
  });
  const reader = createPublicReader({ fetchImpl });
  assert.equal(
    await reader.isPubliclyVisible({ groupKey: "testgroup", topicNumber: "413", commentNumber: "566" }),
    true,
  );
  assert.equal(
    await reader.isPubliclyVisible({ groupKey: "testgroup", topicNumber: "413", commentNumber: "999" }),
    false,
  );
});

test("HTTP状態を復旧手段の違うerrorCodeへ写す", async () => {
  const cases = [
    [403, "blocked"],
    [429, "rate_limited"],
    [503, "rate_limited"],
    [500, "unknown"],
  ];
  for (const [status, code] of cases) {
    const { fetchImpl } = stubFetch({ "/testgroup/topic/413": { status, body: "" } });
    const reader = createPublicReader({ fetchImpl });
    await assert.rejects(
      () => reader.readTopicPage({ groupKey: "testgroup", topicNumber: "413" }),
      (error) => error.code === code,
      `status ${status} は ${code} になる`,
    );
  }
});

test("応答が返らない場合はtimed_outとして返し、待ち続けない", async () => {
  const reader = createPublicReader({
    timeoutMs: 20,
    // Nodeのfetchは既定で待ち続ける。signalを渡していなければこの取得は終わらない。
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
        );
      }),
  });

  await assert.rejects(
    reader.readTopicPage({ groupKey: "testgroup", topicNumber: "413" }),
    (error) => error.code === "timed_out" && /再試行/u.test(error.message),
  );
});

test("公開ページの取得に素性を隠さないUser-Agentを送る", async () => {
  let headers;
  const reader = createPublicReader({
    fetchImpl: async (url, init) => {
      headers = init.headers;
      return { ok: true, status: 200, text: async () => "" };
    },
  });
  await reader.readTopicPage({ groupKey: "testgroup", topicNumber: "413" });
  assert.match(headers["user-agent"], /^ZawazawaModerationReview\//u);
  assert.ok(!/Mozilla|Chrome|Safari/u.test(headers["user-agent"]));
});

test("接続失敗を入力エラーと混同しない", async () => {
  const reader = createPublicReader({
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    },
  });
  await assert.rejects(
    () => reader.readTopicPage({ groupKey: "testgroup", topicNumber: "413" }),
    (error) => error.code === "unknown",
  );
  await assert.rejects(
    () => reader.readTopicPage({ groupKey: "BAD KEY", topicNumber: "413" }),
    (error) => error.code === "invalid_input",
  );
});

test("公開ページの取得例外へ含まれたIP・ポート・URLを外へ返さない", async () => {
  const forbiddenValues = [
    "192.0.2.210",
    "65432",
    "https://internal.example/path?token=synthetic",
  ];
  const reader = createPublicReader({
    fetchImpl: async () => {
      throw new Error(`connect ${forbiddenValues.join(" ")}`);
    },
  });

  await assert.rejects(
    reader.readTopicPage({ groupKey: "testgroup", topicNumber: "413" }),
    (error) => {
      assert.equal(error.code, "unknown");
      const output = `${error.message} ${JSON.stringify(error)}`;
      for (const forbidden of forbiddenValues) assert.ok(!output.includes(forbidden));
      return true;
    },
  );
});
