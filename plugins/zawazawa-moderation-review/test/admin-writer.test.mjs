import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdminWriter,
  evaluateOperationEffect,
  parseOperationSubmission,
  writableOperationSpec,
} from "../server/admin-writer.mjs";
import { ZawazawaConnectorError } from "../server/identifiers.mjs";

const GROUP = "g";
const TOPIC = "413";
const COMMENT = "669";
const DETAIL_URL = `https://z.wikiwiki.jp/m/${GROUP}/comment/${TOPIC}/${COMMENT}`;
const BASE_PATH = `/m/${GROUP}/comment/${TOPIC}/${COMMENT}`;
const CSRF = "csrf-token-value-0123456789";

const REFERENCE = {
  groupKey: GROUP,
  topicNumber: TOPIC,
  commentNumber: COMMENT,
  finalUrl: DETAIL_URL,
};

/**
 * 実画面と同じ形で書く。操作は`data-method="post"`のリンク、通報行は`data-key`、
 * 対処メッセージはモーダル内のフォームにあり、本文は`.panel-body`に描画される。
 */
function detailDocument({
  operations = [
    { href: `${BASE_PATH}/delete`, text: "この投稿を削除する" },
    { href: `${BASE_PATH}/ignore-user`, text: "このユーザーアカウントの投稿を自動的に無視" },
  ],
  reportRows = [],
  closedRows = [],
  body = "対象の本文",
  values = { 削除済み: "いいえ", 無視: "いいえ", 作成日時: "2026/08/22 10:00" },
  csrf = CSRF,
  messageForms = ["AbuseCloseForm[message]", "AllCommentAbuseCloseForm[message]"],
  // 実画面では通報が1件以上あるとき、通報欄の見出しに「すべて完了」リンクが出る。
  // このリンクは`data-method`を持たず、`.close-all-abuse`クラスのモーダルトリガ。
  closeAllAbuse = true,
  // 実画面の通報表はページ送りを表の直後に描く。1ページに収まる表では描かれない。
  reportsPaginated = false,
} = {}) {
  const operationLinks = operations
    .map(
      (operation) =>
        `<a href="${operation.href}" data-method="post" data-confirm="本当によろしいですか">${operation.text}</a>`,
    )
    .join("");
  const closeAllLink =
    closeAllAbuse && reportRows.length
      ? `<div class="pull-right"><a class="close-all-abuse btn btn-success btn-sm" href="${BASE_PATH}/close-all-abuse">すべて完了</a></div>`
      : "";
  const reportTable = reportRows.length
    ? `${closeAllLink}<table><tr><th>報告メッセージ</th><th>通報日時</th><th></th></tr>${reportRows
        .map(
          (row) =>
            `<tr data-key="${row.reportId}"><td>${row.reason || "通報理由"}</td><td>2026/08/22 11:00</td>` +
            `<td><a href="${BASE_PATH}/close-abuse?id=${row.linkId ?? row.reportId}" data-method="post">完了</a>` +
            `<a href="${BASE_PATH}/ignore-abuse?id=${row.linkId ?? row.reportId}" data-method="post" data-confirm="本当によろしいですか">無視</a></td></tr>`,
        )
        .join("")}</table>${
        reportsPaginated ? `<ul class="pagination"><li><a href="?page=2">2</a></li></ul>` : ""
      }`
    : "";
  const closedTable = closedRows.length
    ? `<table><tr><th>報告メッセージ</th><th>通報日時</th><th>対処メッセージ</th><th>対処日時</th></tr>${closedRows
        .map(
          (row) =>
            `<tr data-key="${row.reportId}"><td>${row.reason || "通報理由"}</td><td>2026/08/22 11:00</td>` +
            `<td>${row.responseMessage ?? ""}</td><td>2026/08/22 12:00</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const detailRows = Object.entries(values)
    .map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`)
    .join("");
  const forms = messageForms
    .map(
      (name) =>
        `<form action="${BASE_PATH}" method="post"><input type="hidden" name="_csrf" value="${csrf}">` +
        `<textarea name="${name}"></textarea><button type="submit">完了</button></form>`,
    )
    .join("");
  return (
    `<!doctype html><html><head><meta name="csrf-token" content="${csrf}"></head><body><main>` +
    `<div class="panel comment-view">` +
    `<div class="forum-management-header"><a href="/${GROUP}/topic/${TOPIC}/${COMMENT}">公開URL</a></div>` +
    `<div class="row moderator-operations">${operationLinks}</div>` +
    `<div class="row"><div class="col-md-7"><div class="panel-body">${body}</div></div></div>` +
    `</div>` +
    `<table>${detailRows}</table>${reportTable}${closedTable}${forms}` +
    `</main></body></html>`
  );
}

test("送信できる操作と通報件数の組み合わせだけが仕様を持つ", () => {
  assert.equal(writableOperationSpec("comment_delete", []).pathSegment, "delete");
  assert.equal(writableOperationSpec("author_auto_ignore", []).pathSegment, "ignore-user");
  assert.equal(writableOperationSpec("report_complete", ["r1"]).pathSegment, "close-abuse");
  // 同じコメントの複数通報の完了は一括操作へ寄せ、途中まで成功した状態を作らない。
  assert.equal(
    writableOperationSpec("report_complete", ["r1", "r2"]).pathSegment,
    "close-all-abuse",
  );
  // 通報表を読み切れていない完了は、1件しか見えていなくても一括操作で閉じる。
  assert.equal(
    writableOperationSpec("report_complete", ["r1"], true).pathSegment,
    "close-all-abuse",
  );
  // 無視には一括操作が無いため、複数通報はMCPから送信しない。
  assert.equal(writableOperationSpec("report_ignore", ["r1", "r2"]), null);
  assert.equal(writableOperationSpec("comment_restore", []), null);
  assert.equal(writableOperationSpec("source_block", []), null);
  assert.equal(writableOperationSpec("public_notice", []), null);
});

test("送信先は画面の操作リンクから取り、URLを組み立てない", () => {
  const submission = parseOperationSubmission(detailDocument(), {
    ...REFERENCE,
    operationType: "comment_delete",
  });
  assert.equal(submission.url, `https://z.wikiwiki.jp${BASE_PATH}/delete`);
  assert.deepEqual(submission.form, { _csrf: CSRF });
});

test("画面に無い操作は送信先を作らない", () => {
  assert.throws(
    () =>
      parseOperationSubmission(detailDocument({ operations: [] }), {
        ...REFERENCE,
        operationType: "comment_delete",
      }),
    (error) => error instanceof ZawazawaConnectorError && error.code === "page_changed",
  );
});

test("本文に書かれた操作リンクを送信先の候補にしない", () => {
  const forged = `<a href="${BASE_PATH}/delete" data-method="post">削除</a>`;
  const submission = parseOperationSubmission(detailDocument({ body: forged }), {
    ...REFERENCE,
    operationType: "comment_delete",
  });
  assert.equal(submission.url, `https://z.wikiwiki.jp${BASE_PATH}/delete`);

  // 管理UI側のリンクが無ければ、本文のリンクだけでは送信しない。
  assert.throws(
    () =>
      parseOperationSubmission(detailDocument({ operations: [], body: forged }), {
        ...REFERENCE,
        operationType: "comment_delete",
      }),
    (error) => error.code === "page_changed",
  );
});

test("操作リンクを一意に同定できない画面では送信しない", () => {
  const document = detailDocument({
    operations: [
      { href: `${BASE_PATH}/delete`, text: "削除" },
      { href: `${BASE_PATH}/delete`, text: "削除（別表示）" },
    ],
  });
  assert.throws(
    () => parseOperationSubmission(document, { ...REFERENCE, operationType: "comment_delete" }),
    (error) => error.code === "page_changed",
  );
});

test("認証情報の付いた操作リンクは同定の対象にしない", () => {
  // `origin`は`user:pass@`を無視するので、それだけでは弾けない。認証情報を含む
  // hrefをそのまま送信先にすると、画面のリンクを根拠にしたまま送信先が変わる。
  const document = detailDocument().replace(
    `href="${BASE_PATH}/delete"`,
    `href="https://someone:secret@z.wikiwiki.jp${BASE_PATH}/delete"`,
  );
  assert.throws(
    () => parseOperationSubmission(document, { ...REFERENCE, operationType: "comment_delete" }),
    (error) => error.code === "page_changed",
  );
});

test("CSRFトークンが無いか一意でない画面では送信しない", () => {
  const missing = detailDocument().replace(
    /<meta name="csrf-token"[^>]*>|<input type="hidden" name="_csrf"[^>]*>/gu,
    "",
  );
  assert.throws(
    () => parseOperationSubmission(missing, { ...REFERENCE, operationType: "comment_delete" }),
    (error) => error.code === "page_changed",
  );

  const conflicting = detailDocument().replace(
    `<meta name="csrf-token" content="${CSRF}">`,
    '<meta name="csrf-token" content="another-token-value-0123">',
  );
  assert.throws(
    () => parseOperationSubmission(conflicting, { ...REFERENCE, operationType: "comment_delete" }),
    (error) => error.code === "page_changed",
  );
});

test("通報操作はリンクのidと通報行の識別子が承認済み通報と一致した場合だけ送信する", () => {
  const document = detailDocument({
    reportRows: [{ reportId: "5001" }, { reportId: "5002" }],
  });
  const submission = parseOperationSubmission(document, {
    ...REFERENCE,
    operationType: "report_ignore",
    reportIds: ["5002"],
  });
  assert.equal(submission.url, `https://z.wikiwiki.jp${BASE_PATH}/ignore-abuse?id=5002`);

  assert.throws(
    () =>
      parseOperationSubmission(document, {
        ...REFERENCE,
        operationType: "report_ignore",
        reportIds: ["5003"],
      }),
    (error) => error.code === "page_changed",
  );

  // 行の識別子と送信先のidが食い違う画面は、対象を取り違えるので送信しない。
  const mismatched = detailDocument({
    reportRows: [{ reportId: "5001", linkId: "5002" }],
  });
  assert.throws(
    () =>
      parseOperationSubmission(mismatched, {
        ...REFERENCE,
        operationType: "report_ignore",
        reportIds: ["5001"],
      }),
    (error) => error.code === "page_changed",
  );
});

test("対処メッセージは入力欄を確認できた場合だけ載せる", () => {
  const document = detailDocument({ reportRows: [{ reportId: "5001" }] });
  const submission = parseOperationSubmission(document, {
    ...REFERENCE,
    operationType: "report_complete",
    reportIds: ["5001"],
    message: "確認のうえ削除しました。",
  });
  assert.equal(submission.form["AbuseCloseForm[message]"], "確認のうえ削除しました。");

  const withoutForm = detailDocument({ reportRows: [{ reportId: "5001" }], messageForms: [] });
  assert.throws(
    () =>
      parseOperationSubmission(withoutForm, {
        ...REFERENCE,
        operationType: "report_complete",
        reportIds: ["5001"],
        message: "確認のうえ削除しました。",
      }),
    (error) => error.code === "page_changed",
  );

  // 本文を送れない操作へ本文は付けない。
  assert.throws(
    () =>
      parseOperationSubmission(document, {
        ...REFERENCE,
        operationType: "report_ignore",
        reportIds: ["5001"],
        message: "本文",
      }),
    (error) => error.code === "invalid_input",
  );
});

test("複数通報の一括完了は`.close-all-abuse`リンクへ本文付きでPOSTする", () => {
  const document = detailDocument({
    reportRows: [{ reportId: "5001" }, { reportId: "5002" }],
  });
  const submission = parseOperationSubmission(document, {
    ...REFERENCE,
    operationType: "report_complete",
    reportIds: ["5001", "5002"],
    message: "対象は先に削除済みでした。",
  });
  assert.equal(submission.url, `https://z.wikiwiki.jp${BASE_PATH}/close-all-abuse`);
  assert.equal(submission.form._csrf, CSRF);
  assert.equal(submission.form["AllCommentAbuseCloseForm[message]"], "対象は先に削除済みでした。");
  assert.equal(submission.form["AbuseCloseForm[message]"], undefined);
});

test("一括完了リンクが無い画面では送信しない", () => {
  const document = detailDocument({
    reportRows: [{ reportId: "5001" }, { reportId: "5002" }],
    closeAllAbuse: false,
  });
  assert.throws(
    () =>
      parseOperationSubmission(document, {
        ...REFERENCE,
        operationType: "report_complete",
        reportIds: ["5001", "5002"],
      }),
    (error) => error instanceof ZawazawaConnectorError && error.code === "page_changed",
  );
});

test("一括完了の本文入力欄が無い画面では本文なしで閉じない", () => {
  const document = detailDocument({
    reportRows: [{ reportId: "5001" }, { reportId: "5002" }],
    messageForms: ["AbuseCloseForm[message]"],
  });
  assert.throws(
    () =>
      parseOperationSubmission(document, {
        ...REFERENCE,
        operationType: "report_complete",
        reportIds: ["5001", "5002"],
        message: "対処メッセージ",
      }),
    (error) => error.code === "page_changed",
  );
});

test("一括完了リンクが一意でない画面では送信しない", () => {
  const document = detailDocument({
    reportRows: [{ reportId: "5001" }, { reportId: "5002" }],
  }).replace(
    "すべて完了</a></div>",
    `すべて完了</a></div><div><a class="close-all-abuse" href="${BASE_PATH}/close-all-abuse">再掲</a></div>`,
  );
  assert.throws(
    () =>
      parseOperationSubmission(document, {
        ...REFERENCE,
        operationType: "report_complete",
        reportIds: ["5001", "5002"],
      }),
    (error) => error.code === "page_changed",
  );
});

test("通報理由セルに置かれた一括完了リンクは送信先の候補にしない", () => {
  const document = detailDocument({
    reportRows: [
      {
        reportId: "5001",
        reason: `通報理由<a class="close-all-abuse" href="${BASE_PATH}/close-all-abuse">すべて完了</a>`,
      },
      { reportId: "5002" },
    ],
    closeAllAbuse: false,
  });
  assert.throws(
    () =>
      parseOperationSubmission(document, {
        ...REFERENCE,
        operationType: "report_complete",
        reportIds: ["5001", "5002"],
      }),
    (error) => error.code === "page_changed",
  );
});

test("本文に書かれた一括完了リンクは送信先の候補にしない", () => {
  const forged = `<a class="close-all-abuse" href="${BASE_PATH}/close-all-abuse">すべて完了</a>`;
  const document = detailDocument({
    reportRows: [{ reportId: "5001" }, { reportId: "5002" }],
    closeAllAbuse: false,
    body: forged,
  });
  assert.throws(
    () =>
      parseOperationSubmission(document, {
        ...REFERENCE,
        operationType: "report_complete",
        reportIds: ["5001", "5002"],
      }),
    (error) => error.code === "page_changed",
  );
});

test("閉じる通報が単一に減った完了は、一括リンクのある画面でも単一の送信先へ戻る", () => {
  // 実行直前照合で承認済み通報の片方が他の管理者に閉じられていた場合、実際に閉じる
  // 通報は1件になる。画面には一括完了リンクが出たままなので、送信先の選び直しが
  // 通報件数だけで決まることを確かめる。
  const document = detailDocument({
    reportRows: [{ reportId: "5001" }, { reportId: "5002" }],
  });
  const submission = parseOperationSubmission(document, {
    ...REFERENCE,
    operationType: "report_complete",
    reportIds: ["5001"],
    message: "確認のうえ削除しました。",
  });
  assert.equal(submission.url, `https://z.wikiwiki.jp${BASE_PATH}/close-abuse?id=5001`);
  assert.equal(submission.form["AbuseCloseForm[message]"], "確認のうえ削除しました。");
  assert.equal(submission.form["AllCommentAbuseCloseForm[message]"], undefined);
});

test("送信先は承認済みではなく実際に閉じる通報の集合から選び直す", async () => {
  // 実行経路は`prepare`で読んだ画面へ、実行直前照合で確定した通報の集合を束縛して
  // 送信先を確定する。承認済みが1件でも、増えた通報を含めて2件を閉じるなら一括へ移る。
  const page = detailDocument({ reportRows: [{ reportId: "5001" }, { reportId: "5002" }] });
  const context = fakeWriterContext({ postHtml: page });
  const reader = {
    async readCommentPage() {
      return { html: page, finalUrl: DETAIL_URL };
    },
  };
  const writer = createAdminWriter({ requestContext: context.requestContext, reader });
  const request = {
    ...REFERENCE,
    operationType: "report_complete",
    reportIds: ["5001"],
    message: "確認のうえ削除しました。",
  };
  const { resolveSubmission } = await writer.prepare(request);
  assert.equal(
    resolveSubmission(request).url,
    `https://z.wikiwiki.jp${BASE_PATH}/close-abuse?id=5001`,
  );
  const bulk = resolveSubmission({ ...request, reportIds: ["5001", "5002"] });
  assert.equal(bulk.url, `https://z.wikiwiki.jp${BASE_PATH}/close-all-abuse`);
  assert.equal(bulk.form["AllCommentAbuseCloseForm[message]"], "確認のうえ削除しました。");
});

test("削除の効果は管理画面の現在状態で判定する", () => {
  const deleted = detailDocument({
    values: { 削除済み: "はい", 無視: "いいえ", 作成日時: "2026/08/22 10:00" },
  });
  assert.equal(
    evaluateOperationEffect(deleted, { ...REFERENCE, operationType: "comment_delete" }),
    true,
  );
  assert.equal(
    evaluateOperationEffect(detailDocument(), { ...REFERENCE, operationType: "comment_delete" }),
    false,
  );
  // 状態欄を読めない画面は成功にも失敗にもしない。
  assert.equal(
    evaluateOperationEffect(detailDocument({ values: {} }), {
      ...REFERENCE,
      operationType: "comment_delete",
    }),
    undefined,
  );
  assert.equal(
    evaluateOperationEffect("<html><body></body></html>", {
      ...REFERENCE,
      operationType: "comment_delete",
    }),
    undefined,
  );
});

test("通報の完了は承認した本文が対処メッセージに残ったことまでを結果とする", () => {
  const message = "確認のうえ削除しました。";
  const closed = detailDocument({
    closedRows: [{ reportId: "5001", responseMessage: message }],
  });
  const request = {
    ...REFERENCE,
    operationType: "report_complete",
    reportIds: ["5001"],
    message,
  };
  assert.equal(evaluateOperationEffect(closed, request), true);

  // 実画面は対処メッセージの直後へ文字列区切りと管理者表示を連結する。
  const closedWithResponder = detailDocument({
    closedRows: [{ reportId: "5001", responseMessage: `${message} -- <strong>管理者</strong>` }],
  });
  assert.equal(evaluateOperationEffect(closedWithResponder, request), true);

  const otherMessage = detailDocument({
    closedRows: [{ reportId: "5001", responseMessage: "別の本文" }],
  });
  assert.equal(evaluateOperationEffect(otherMessage, request), false);

  const stillOpen = detailDocument({ reportRows: [{ reportId: "5001" }] });
  assert.equal(evaluateOperationEffect(stillOpen, request), false);

  // 複数通報の一括完了は、全件が承認した本文で閉じた場合だけ成功とする。
  const bulk = detailDocument({
    closedRows: [
      { reportId: "5001", responseMessage: message },
      { reportId: "5002", responseMessage: message },
    ],
  });
  assert.equal(
    evaluateOperationEffect(bulk, { ...request, reportIds: ["5001", "5002"] }),
    true,
  );
  const partial = detailDocument({
    reportRows: [{ reportId: "5002" }],
    closedRows: [{ reportId: "5001", responseMessage: message }],
  });
  assert.equal(
    evaluateOperationEffect(partial, { ...request, reportIds: ["5001", "5002"] }),
    false,
  );
});

test("通報の無視は対処メッセージなしで処理済みになったことを結果とする", () => {
  const request = { ...REFERENCE, operationType: "report_ignore", reportIds: ["5001"] };
  assert.equal(
    evaluateOperationEffect(detailDocument({ closedRows: [{ reportId: "5001" }] }), request),
    true,
  );
  assert.equal(
    evaluateOperationEffect(
      detailDocument({ closedRows: [{ reportId: "5001", responseMessage: "本文" }] }),
      request,
    ),
    false,
  );
});

test("自動無視は投稿時の無視欄ではなく提示された管理操作で判定する", () => {
  const request = { ...REFERENCE, operationType: "author_auto_ignore" };
  // 設定前は設定リンクだけがある。
  assert.equal(evaluateOperationEffect(detailDocument(), request), false);
  // 設定後は解除リンクへ入れ替わる。
  const released = detailDocument({
    operations: [
      { href: `${BASE_PATH}/delete`, text: "削除" },
      { href: `${BASE_PATH}/ignore-user-remove`, text: "自動無視を解除" },
    ],
  });
  assert.equal(evaluateOperationEffect(released, request), true);
  // どちらも読めない画面は未確認にする。投稿時の無視欄で代替しない。
  const ambiguous = detailDocument({
    operations: [],
    values: { 削除済み: "いいえ", 無視: "はい", 作成日時: "2026/08/22 10:00" },
  });
  assert.equal(evaluateOperationEffect(ambiguous, request), undefined);
});

/** 取得と送信の差し替え。ネットワークへは出ない。 */
function fakeWriterContext({ postStatus = 200, postHtml, postUrl = DETAIL_URL } = {}) {
  const posts = [];
  return {
    posts,
    requestContext: {
      async post(url, options) {
        posts.push({ url, form: options.form });
        return {
          status: () => postStatus,
          url: () => postUrl,
          text: async () => postHtml ?? "",
        };
      },
    },
  };
}

test("送信は画面から得た宛先と本文だけを送り、応答から効果を判定する", async () => {
  const page = detailDocument();
  const deleted = detailDocument({
    values: { 削除済み: "はい", 無視: "いいえ", 作成日時: "2026/08/22 10:00" },
  });
  const context = fakeWriterContext({ postHtml: deleted });
  const reader = {
    async readCommentPage() {
      return { html: page, finalUrl: DETAIL_URL };
    },
  };
  const writer = createAdminWriter({ requestContext: context.requestContext, reader });
  const request = { ...REFERENCE, operationType: "comment_delete", reportIds: [] };
  const { detail, resolveSubmission } = await writer.prepare(request);
  assert.equal(detail.currentState, "公開中");
  assert.equal(context.posts.length, 0);

  const result = await writer.dispatch(request, resolveSubmission(request));
  assert.equal(result.effect, true);
  assert.deepEqual(context.posts, [
    { url: `https://z.wikiwiki.jp${BASE_PATH}/delete`, form: { _csrf: CSRF } },
  ]);
});

test("4xxの応答は効果の判定を応答本文へ求めず、読み戻しへ回す", async () => {
  const page = detailDocument();
  const context = fakeWriterContext({ postStatus: 400 });
  const reader = {
    async readCommentPage() {
      return { html: page, finalUrl: DETAIL_URL };
    },
  };
  const writer = createAdminWriter({ requestContext: context.requestContext, reader });
  const request = { ...REFERENCE, operationType: "comment_delete", reportIds: [] };
  const { resolveSubmission } = await writer.prepare(request);
  const result = await writer.dispatch(request, resolveSubmission(request));
  assert.equal(result.effect, undefined);
  assert.equal(result.rejected, true);
  // 読み戻しは現在状態を確定できる。
  assert.equal((await writer.readback(request)).effect, false);
});

test("読み切れていない通報表の完了は、1件でも一括完了のリンクへ送る", () => {
  const html = detailDocument({
    reportRows: [{ reportId: "r1" }, { reportId: "r2" }],
    reportsPaginated: true,
  });
  const submission = parseOperationSubmission(html, {
    ...REFERENCE,
    operationType: "report_complete",
    reportIds: ["r1"],
    closeAllReports: true,
    message: "対処しました。",
  });
  assert.equal(submission.url, `https://z.wikiwiki.jp${BASE_PATH}/close-all-abuse`);
  assert.equal(submission.form["AllCommentAbuseCloseForm[message]"], "対処しました。");
});

test("未処理通報が残っていなければ、処理済み表に行が無い完了も成功と判定する", () => {
  // 通報表が1ページに収まらない画面では、閉じた通報が処理済み表の1ページ目に出ない。
  const closed = detailDocument({ reportRows: [], closedRows: [{ reportId: "other" }] });
  assert.equal(
    evaluateOperationEffect(closed, {
      ...REFERENCE,
      operationType: "report_complete",
      reportIds: ["r1", "r2"],
      message: "対処しました。",
    }),
    true,
  );
  // 未処理通報が残る画面では、承認済み通報の行を追えないまま成功にしない。
  const remaining = detailDocument({ reportRows: [{ reportId: "r9" }] });
  assert.equal(
    evaluateOperationEffect(remaining, {
      ...REFERENCE,
      operationType: "report_complete",
      reportIds: ["r1"],
      message: "対処しました。",
    }),
    undefined,
  );
  // 読み切れていない未処理表の0件は0件の証拠にならないので、無視では成功にしない。
  assert.equal(
    evaluateOperationEffect(closed, {
      ...REFERENCE,
      operationType: "report_ignore",
      reportIds: ["r1"],
    }),
    undefined,
  );
});

test("送信結果と読み戻しは、対象に残った未処理通報を同じ観測から返す", async () => {
  const page = detailDocument({ reportRows: [{ reportId: "r9" }] });
  const context = fakeWriterContext({ postHtml: page });
  const reader = {
    async readCommentPage() {
      return { html: page, finalUrl: DETAIL_URL };
    },
  };
  const writer = createAdminWriter({ requestContext: context.requestContext, reader });
  const request = {
    ...REFERENCE,
    operationType: "report_complete",
    reportIds: ["r1"],
    closeAllReports: true,
    message: "対処しました。",
  };
  const { resolveSubmission } = await writer.prepare(request);
  const result = await writer.dispatch(request, resolveSubmission(request));
  assert.deepEqual(result.openReportIds, ["r9"]);
  assert.deepEqual((await writer.readback(request)).openReportIds, ["r9"]);
});
