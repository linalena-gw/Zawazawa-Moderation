/**
 * 実サイトとの同値確認。`npm test`には含めない任意実行の検証で、認証プロファイルが要る。
 * HTTP取得＋HTML解析（`admin-reader.mjs`）と、描画済みページからの読み取りを突き合わせる。
 * 読み取りだけを行い、状態を変える操作はしない。
 * 機微情報は出力しない（一致の真偽と件数だけを出す）。
 * 突き合わせるのは解析経路の差だけである。両側とも本番と同じコンテキストから取るため、
 * 名乗るUser-Agentも起動形態も同じで、ZAWAZAWAが名乗りによって内容を変えるかどうかは
 * この検証では分からない。
 *
 *   node scripts/verify-admin-reader.mjs <groupKey> [件数]
 */
import { chromium } from "playwright-core";
import {
  defaultProfileDirectory,
  persistentContextOptions,
} from "../server/zawazawa-connector.mjs";
import { createAdminReader, parseSearchReferences } from "../server/admin-reader.mjs";
import { GROUP_KEY } from "../server/identifiers.mjs";
import { cleanText } from "../server/input-text.mjs";

const groupKey = process.argv[2];
const wanted = Number(process.argv[3] || 20);
if (!GROUP_KEY.test(groupKey || "")) {
  throw new Error("使い方: node scripts/verify-admin-reader.mjs <groupKey> [件数]");
}

const BASE = "https://z.wikiwiki.jp";

/** 比較の相手側。描画済みページから同じ項目を読む（置き換え前の経路と同じ取り方）。 */
async function readViaPage(page, { groupKey: g, topicNumber, commentNumber }) {
  await page.goto(`${BASE}/m/${g}/comment/${topicNumber}/${commentNumber}`, {
    waitUntil: "domcontentloaded",
  });
  const view = page.locator(".comment-view");
  const source = view.locator("textarea.md-code-editor").first();
  const body = (await source.count())
    ? cleanText(await source.inputValue())
    : cleanText(await view.locator(".panel-body").first().innerText());
  const values = await page.locator("main tr").evaluateAll((rows, labels) => {
    const found = {};
    for (const row of rows) {
      const header = row.querySelector("th")?.textContent?.trim();
      if (!header || !labels.includes(header) || header in found) continue;
      found[header] = row.querySelector("td")?.textContent?.trim();
    }
    return found;
  }, ["削除済み", "無視", "作成日時", "親コメント"]);
  const parent = values["親コメント"];
  return {
    body,
    createdAt: values["作成日時"] ? cleanText(values["作成日時"]) : undefined,
    currentState:
      values["削除済み"] === "はい"
        ? "削除済み"
        : values["無視"] === "はい"
          ? "投稿時に自動無視"
          : "公開中",
    parentCommentNumber: parent && parent !== "トップレベル" ? cleanText(parent) : undefined,
  };
}

const context = await chromium.launchPersistentContext(
  defaultProfileDirectory(),
  persistentContextOptions(),
);
try {
  const reader = createAdminReader({ requestContext: context.request });
  const page = await context.newPage();

  const listResponse = await context.request.get(`${BASE}/m/${groupKey}/comment`);
  if (listResponse.status() !== 200) {
    throw new Error(`コメント一覧がHTTP ${listResponse.status()}を返しました。`);
  }
  const references = parseSearchReferences(await listResponse.text(), {
    groupKey,
    limit: wanted,
  }).map((reference) => ({ groupKey, ...reference }));
  process.stdout.write(`対象: ${references.length}件\n`);

  let matched = 0;
  const mismatches = [];
  let httpMs = 0;
  let pageMs = 0;
  for (const reference of references) {
    let start = Date.now();
    const viaHttp = await reader.readCommentDetail(reference);
    httpMs += Date.now() - start;

    start = Date.now();
    const viaPage = await readViaPage(page, reference);
    pageMs += Date.now() - start;

    const differing = ["body", "createdAt", "currentState", "parentCommentNumber"].filter(
      (field) => viaHttp[field] !== viaPage[field],
    );
    if (differing.length) mismatches.push({ reference: `${reference.topicNumber}/${reference.commentNumber}`, differing });
    else matched += 1;
  }

  process.stdout.write(`一致: ${matched}/${references.length}\n`);
  for (const mismatch of mismatches) {
    process.stdout.write(`不一致 ${mismatch.reference}: ${mismatch.differing.join(", ")}\n`);
  }
  if (references.length) {
    process.stdout.write(
      `1件あたり HTTP ${Math.round(httpMs / references.length)}ms / 描画 ${Math.round(pageMs / references.length)}ms\n`,
    );
  }

  const openReports = await reader.readOpenReports({ groupKey, limit: 50 });
  process.stdout.write(
    `未処理通報: ${openReports.reports.length}件 総件数確認 ${openReports.totalCountConfirmed} 打ち切り ${openReports.truncated}\n`,
  );

  process.exitCode = mismatches.length ? 1 : 0;
} finally {
  await context.close().catch(() => {});
}
