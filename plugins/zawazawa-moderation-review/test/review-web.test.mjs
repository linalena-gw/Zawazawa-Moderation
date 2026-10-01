import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createReviewStore } from "../server/review-store.mjs";
import { createReviewWebServer } from "../server/review-web.mjs";

const uiHtml = `<!doctype html><body>\n  <!-- host-bootstrap -->\n  <script>\n    (() => {})();\n  </script>\n</body>`;

function reviewFixture() {
  return {
    batchTitle: "未処理通報レビュー",
    maskedPaths: [],
    items: [
      {
        id: "96517",
        title: "投稿96517",
        reportCount: 1,
        reports: [{ reportId: "report-1", targetCommentNumber: "96517", reason: "荒らし投稿" }],
        comments: [{ commentNumber: "96517", body: "対象コメント本文" }],
        history: [],
        basis: ["運用基準の該当項目"],
        recommendation: {
          targets: [{ commentNumber: "96517", currentState: "公開中" }],
          operations: [
            {
              operationId: "operation-1",
              operationType: "no_external_action",
              targetCommentNumbers: ["96000"],
              messageIds: [],
            },
          ],
          operationIds: ["delete"],
          operationCandidates: [
            {
              operationId: "delete",
              operationType: "comment_delete",
              operationTypeLabel: "コメント削除",
              targetCommentNumbers: ["96517"],
              messageIds: [],
              highImpact: false,
              selectedByDefault: true,
            },
            {
              operationId: "keep",
              operationType: "no_external_action",
              operationTypeLabel: "外部操作なし",
              targetCommentNumbers: ["96517"],
              messageIds: [],
              highImpact: false,
              selectedByDefault: false,
            },
            {
              operationId: "block",
              operationType: "author_auto_ignore",
              operationTypeLabel: "投稿者の自動無視",
              targetCommentNumbers: ["96517"],
              messageIds: [],
              highImpact: true,
              selectedByDefault: false,
            },
          ],
          messages: [],
        },
      },
    ],
  };
}

function approvalFor(store, batch, itemId = "96517") {
  const snapshot = store.snapshot({
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
  });
  const item = snapshot.items.find((entry) => entry.id === itemId);
  return {
    itemId,
    choice: "approve",
    resolvedPlanToken: item.recommendedResolvedPlanToken,
  };
}

function withServer(context, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "zawazawa-review-web-"));
  const store = createReviewStore({ directory, ...options.store });
  const web = createReviewWebServer({ store, uiHtml: options.uiHtml ?? uiHtml });
  context.after(() => {
    web.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, web };
}

// fetchはHostヘッダを差し替えられないので、生のHTTPで送る。
function requestWithHost(url, hostHeader) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { host: hostHeader },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    call.on("error", reject);
    call.end();
  });
}

function decisionsRequest(url, body) {
  return toolRequest(url, "decisions", body);
}

function toolRequest(url, route, body) {
  const target = new URL(url);
  return fetch(
    `${target.origin}/r/${target.pathname.split("/")[2]}/${route}?k=${target.searchParams.get("k")}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

test("ループバックURLが一覧を配り、送信を保存先へ記録する", async (context) => {
  const { store, web } = withServer(context);
  const batch = store.create(reviewFixture());
  const url = await web.urlFor(batch.batchId);

  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /window\.__zawazawaStandalone = true/u);
  assert.doesNotMatch(html, /対象コメント本文|荒らし投稿/u);
  // 会話への通知経路がないホスト向けなので、三つの同一ドメイン処理だけを公開する。
  assert.match(html, /\/snapshot\?k=/u);
  assert.match(html, /\/preview\?k=/u);
  assert.match(html, /\/decisions\?k=/u);

  const snapshot = await toolRequest(url, "snapshot", {
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
  });
  assert.equal(snapshot.status, 200);
  const snapshotPayload = await snapshot.json();
  assert.equal(snapshotPayload.items[0].comments[0].body, "対象コメント本文");

  const key = new URL(url).searchParams.get("k");
  const missingToken = await fetch(
    `${new URL(url).origin}/r/${batch.batchId}/decisions?k=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batchId: batch.batchId,
        snapshotToken: batch.snapshotToken,
        decisions: [{ itemId: "96517", choice: "approve" }],
      }),
    },
  );
  assert.equal(missingToken.status, 400);
  assert.match((await missingToken.json()).error, /推奨完全案トークン/u);

  const submitted = await fetch(`${new URL(url).origin}/r/${batch.batchId}/decisions?k=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      batchId: batch.batchId,
      snapshotToken: batch.snapshotToken,
      decisions: [{
        itemId: "96517",
        choice: "approve",
        resolvedPlanToken: snapshotPayload.items[0].recommendedResolvedPlanToken,
      }],
    }),
  });
  assert.equal(submitted.status, 200);
  const payload = await submitted.json();
  assert.equal(payload.submission.executableAuthorizedCount, 1);
  assert.equal(payload.items, undefined);
  assert.deepEqual(
    store.get(batch.batchId, { scope: "execution" }).submission.executableAuthorizedItemIds,
    ["96517"],
  );
});

test("ローカルURLも同じ構造化変更をプレビューしトークン不一致を拒む", async (context) => {
  const { store, web } = withServer(context);
  const batch = store.create(reviewFixture());
  const url = await web.urlFor(batch.batchId);
  const changes = {
    selectedTargetCommentNumbers: ["96517"],
    selectedOperationIds: ["keep"],
    messageChanges: [],
  };
  const previewResponse = await toolRequest(url, "preview", {
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    itemId: "96517",
    changes,
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.deepEqual(preview.resolvedPlan.reportIds, ["report-1"]);
  assert.equal(preview.resolvedPlan.targets[0].currentState, "公開中");
  assert.equal(store.get(batch.batchId).submission, null);

  const stale = await decisionsRequest(url, {
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [
      {
        itemId: "96517",
        choice: "alternative",
        changes: { ...changes, selectedOperationIds: ["delete", "keep"] },
        resolvedPlanToken: preview.resolvedPlanToken,
      },
    ],
  });
  assert.equal(stale.status, 400);
  assert.match((await stale.json()).error, /プレビュー後に変わりました/u);

  const submitted = await decisionsRequest(url, {
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [
      {
        itemId: "96517",
        choice: "alternative",
        changes,
        resolvedPlanToken: preview.resolvedPlanToken,
      },
    ],
  });
  assert.equal(submitted.status, 200);
  const execution = store.get(batch.batchId, { scope: "execution" });
  assert.equal(
    execution.submission.authorizedPlans[0].resolvedPlan.operations[0].operationTypeLabel,
    "外部操作なし",
  );
});

test("鍵のないURLと別バッチへの送信を拒む", async (context) => {
  const { store, web } = withServer(context);
  const batch = store.create(reviewFixture());
  const url = new URL(await web.urlFor(batch.batchId));

  assert.equal((await fetch(`${url.origin}/r/${batch.batchId}`)).status, 404);
  assert.equal((await fetch(`${url.origin}/r/${batch.batchId}?k=00`)).status, 404);

  const key = url.searchParams.get("k");
  const other = await fetch(`${url.origin}/r/${batch.batchId}/decisions?k=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      batchId: "00000000-0000-4000-8000-000000000001",
      snapshotToken: batch.snapshotToken,
      decisions: [{ itemId: "96517", choice: "approve" }],
    }),
  });
  assert.equal(other.status, 400);
  assert.equal(store.get(batch.batchId).submission, null);
});

test("スナップショット不一致と二重送信を拒む", async (context) => {
  const { store, web } = withServer(context);
  const batch = store.create(reviewFixture());
  const url = new URL(await web.urlFor(batch.batchId));
  const endpoint = `${url.origin}/r/${batch.batchId}/decisions?k=${url.searchParams.get("k")}`;
  const approval = approvalFor(store, batch);
  const send = (snapshotToken) =>
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batchId: batch.batchId,
        snapshotToken,
        decisions: [approval],
      }),
    });

  const mismatch = await send("f".repeat(64));
  assert.equal(mismatch.status, 400);
  assert.match((await mismatch.json()).error, /スナップショット/u);
  // 不一致で断った時点では鍵を残す。やり直せないと再表示しかなくなる。
  assert.equal((await send(batch.snapshotToken)).status, 200);
  // 送信が通った時点で鍵を失効させるので、以降は開き直せない。
  assert.equal((await send(batch.snapshotToken)).status, 404);
  assert.equal((await fetch(url.href)).status, 404);
});

test("送信済みと期限切れの一覧は開かせず、URLも配らない", async (context) => {
  const submitted = withServer(context);
  const batch = submitted.store.create(reviewFixture());
  const url = await submitted.web.urlFor(batch.batchId);
  const approval = approvalFor(submitted.store, batch);
  assert.equal(
    (
      await decisionsRequest(url, {
        batchId: batch.batchId,
        snapshotToken: batch.snapshotToken,
        decisions: [approval],
      })
    ).status,
    200,
  );
  await assert.rejects(() => submitted.web.urlFor(batch.batchId), /送信済み/u);

  // 期限切れは鍵が生きているうちでも410で断る。
  let clock = Date.parse("2026-08-20T00:00:00Z");
  const expiring = withServer(context, {
    store: { ttlMs: 60_000, now: () => clock },
  });
  const old = expiring.store.create(reviewFixture());
  const expiringUrl = await expiring.web.urlFor(old.batchId);
  assert.equal((await fetch(expiringUrl)).status, 200);
  clock += 90_000;
  assert.equal((await fetch(expiringUrl)).status, 410);
  await assert.rejects(() => expiring.web.urlFor(old.batchId), /有効期限/u);
});

test("保存先から消えた一覧の鍵だけを落とし、期限切れの案内は残す", async (context) => {
  let clock = Date.parse("2026-08-20T00:00:00Z");
  const { store, web } = withServer(context, { store: { ttlMs: 60_000, now: () => clock } });
  const batch = store.create(reviewFixture());
  const url = await web.urlFor(batch.batchId);
  clock += 90_000;

  // 記録が残っている間は、期限切れの理由を返せるよう鍵を残す。
  const next = store.create(reviewFixture());
  await web.urlFor(next.batchId);
  assert.equal((await fetch(url)).status, 410);

  // 記録が掃除された後は鍵も残さない。開けないURLの鍵を持ち続けない。
  clock += 60_000 * 3;
  const later = store.create(reviewFixture());
  await web.urlFor(later.batchId);
  assert.equal((await fetch(url)).status, 404);
});

test("ループバック以外のHostと未対応メソッドを拒む", async (context) => {
  const { store, web } = withServer(context);
  const batch = store.create(reviewFixture());
  const url = new URL(await web.urlFor(batch.batchId));

  // DNSリバインディングで別名からこのポートへ来た場合を弾く。
  assert.equal(await requestWithHost(url.href, "attacker.example"), 403);
  assert.equal(await requestWithHost(url.href, `127.0.0.1:${url.port}`), 200);

  assert.equal((await fetch(url.href, { method: "POST" })).status, 405);
  assert.equal(
    (await decisionsRequest(url.href, { batchId: batch.batchId }).then((r) => r.status)),
    400,
  );
});

test("差し込み位置の無いHTMLは壊れた画面を配らず失敗する", async (context) => {
  const { store, web } = withServer(context, { uiHtml: "<!doctype html><body></body>" });
  const batch = store.create(reviewFixture());
  const response = await fetch(await web.urlFor(batch.batchId));
  assert.equal(response.status, 500);
  assert.match(await response.text(), /差し込め/u);
});

test("大きすぎる送信は413で断り、保存しない", async (context) => {
  const { store, web } = withServer(context);
  const batch = store.create(reviewFixture());
  const url = await web.urlFor(batch.batchId);
  const response = await decisionsRequest(url, {
    batchId: batch.batchId,
    snapshotToken: batch.snapshotToken,
    decisions: [{ itemId: "96517", choice: "alternative", alternative: "あ".repeat(400_000) }],
  });
  // 上限超過は入力起因の他の拒否と区別する。接続を切らずに理由を書けるようにしてある。
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /大きすぎます/u);
  assert.equal(store.get(batch.batchId).submission, null);
});
