import assert from "node:assert/strict";
import test from "node:test";
import { createAdminReader } from "../server/admin-reader.mjs";
import { createAdminWriter } from "../server/admin-writer.mjs";
import { createPublicReader } from "../server/public-reader.mjs";
import { readCommentDetails } from "../server/zawazawa-connector.mjs";
import { createRequestLimiter } from "../server/request-limiter.mjs";

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("複数の詳細取得呼び出しが同じ並行数上限を共有する", async () => {
  const requestLimiter = createRequestLimiter(3);
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const adminReader = {
    readCommentDetail(reference) {
      return requestLimiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return { commentNumber: reference.commentNumber };
      });
    },
  };
  const references = ["1", "2", "3"].map((commentNumber) => ({ commentNumber }));

  const pending = Promise.all([
    readCommentDetails(adminReader, references),
    readCommentDetails(adminReader, references),
  ]);
  await nextTurn();
  assert.equal(active, 3);
  assert.equal(peak, 3);
  release();

  const results = await pending;
  assert.deepEqual(
    results.map((details) => details.map((detail) => detail.commentNumber)),
    [
      ["1", "2", "3"],
      ["1", "2", "3"],
    ],
  );
  assert.equal(peak, 3);
});

test("失敗とタイムアウト相当の拒否後にも枠を返して待機処理を進める", async () => {
  for (const failure of [
    new Error("failed"),
    Object.assign(new Error("timed out"), { name: "TimeoutError" }),
  ]) {
    const requestLimiter = createRequestLimiter(1);
    const events = [];
    let rejectFirst;
    const first = requestLimiter.run(
      () =>
        new Promise((resolve, reject) => {
          events.push("first:start");
          rejectFirst = reject;
        }),
    );
    const second = requestLimiter.run(() => {
      events.push("second:start");
      return "done";
    });

    await nextTurn();
    assert.deepEqual(events, ["first:start"]);
    rejectFirst(failure);
    await assert.rejects(first, failure);
    assert.equal(await second, "done");
    assert.deepEqual(events, ["first:start", "second:start"]);
  }
});

test("空き枠では待たず、解放時に待機順で一件ずつ進める", async () => {
  const requestLimiter = createRequestLimiter(1);
  const events = [];
  let releaseFirst;
  const first = requestLimiter.run(
    () =>
      new Promise((resolve) => {
        events.push("first");
        releaseFirst = resolve;
      }),
  );
  const second = requestLimiter.run(() => events.push("second"));
  const third = requestLimiter.run(() => events.push("third"));

  await nextTurn();
  assert.deepEqual(events, ["first"]);
  releaseFirst();
  await Promise.all([first, second, third]);
  assert.deepEqual(events, ["first", "second", "third"]);
});

test("管理GET・管理POST・公開GETが同じ通信上限と待ち行列を共有する", async () => {
  const requestLimiter = createRequestLimiter(2);
  const started = [];
  let active = 0;
  let peak = 0;
  let releaseBodies;
  const bodyGate = new Promise((resolve) => {
    releaseBodies = resolve;
  });

  function response(kind, body, url, fetchResponse = false) {
    started.push(kind);
    active += 1;
    peak = Math.max(peak, active);
    return {
      ok: true,
      status: fetchResponse ? 200 : () => 200,
      url: () => url,
      headers: fetchResponse ? { get: () => null } : () => ({}),
      async text() {
        await bodyGate;
        active -= 1;
        return body;
      },
    };
  }

  const requestContext = {
    async get(url) {
      return response("admin:get", "<html></html>", url);
    },
    async post(url) {
      return response("admin:post", "<html></html>", url);
    },
  };
  const adminReader = createAdminReader({ requestContext, requestLimiter });
  const adminWriter = createAdminWriter({ requestContext, reader: adminReader, requestLimiter });
  const publicReader = createPublicReader({
    requestLimiter,
    fetchImpl: async (url) =>
      response("public:get", "<rss><channel></channel></rss>", url, true),
  });

  const reference = { groupKey: "g", topicNumber: "1", commentNumber: "2" };
  const pending = Promise.all([
    adminReader.readCommentPage(reference),
    adminWriter.dispatch(
      { ...reference, operationType: "comment_delete" },
      { url: "https://z.wikiwiki.jp/m/g/comment/1/2/delete", form: { _csrf: "token" } },
    ),
    publicReader.readTopicFeed({ groupKey: "g", topicNumber: "1" }),
  ]);

  await nextTurn();
  assert.deepEqual(started, ["admin:get", "admin:post"]);
  assert.equal(active, 2);
  assert.equal(peak, 2);
  releaseBodies();
  await pending;

  assert.deepEqual(started, ["admin:get", "admin:post", "public:get"]);
  assert.equal(active, 0);
  assert.equal(peak, 2);
});
