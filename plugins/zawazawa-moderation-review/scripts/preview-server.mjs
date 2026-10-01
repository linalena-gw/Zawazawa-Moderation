/**
 * 一覧UIの表示と送信を、ホストなしで確認するためのプレビュー。
 *
 * 完全案の解決・トークン・承認記録は`server/review-store.mjs`の承認ストアへそのまま任せる。
 * ここで解決規則を書き写すと、プレビューで確認できた挙動が本番と一致する保証を失う。
 * 保存先は起動ごとの一時ディレクトリで、実行先の承認ストアには触れない。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewHtml } from "../server/mcp-app-runtime.mjs";
import { ReviewInputError } from "../server/input-text.mjs";
import { normalizeReviewInput } from "../server/review-input.mjs";
import { createReviewStore } from "../server/review-store.mjs";

const portIndex = process.argv.indexOf("--port");
const port = portIndex >= 0 ? parsePort(process.argv[portIndex + 1]) : 4173;
export const MAX_BODY_BYTES = 1_000_000;

class RequestTooLargeError extends ReviewInputError {}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    process.stderr.write(`--port には0〜65535の整数を渡してください（受け取った値: ${value}）\n`);
    process.exit(1);
  }
  return parsed;
}

const template = await readFile(new URL("../ui/review.html", import.meta.url), "utf8");

/**
 * 一覧UIが扱う形をひととおり通すための合成フィクスチャ。実際の投稿内容は置かない。
 * 網羅する形は次のとおりで、どれかを落とすと画面のその経路を確認できなくなる。
 * ・ツリー削除と関連コメント（文脈整理対象）
 * ・コメント行で削除と保持を選べる列（推奨が削除でも保持でも、提案の無い行でも）
 * ・通報欄で保留・完了・無視を選べる列と、その場で書き換える通報完了メッセージ
 * ・投稿履歴の隣で なし・自動無視・ブロック を選べる列
 * ・送信必須の本文を持つ操作（送信しないを出さない行）
 * ・依存グループ
 * ・3件を超える通報（先頭3件だけを開き、残りは「もっと見る」）
 * ・1ページに収まらない通報表（総件数が分かる場合と分からない場合の見出し）
 * ・同一ツリー・別ツリー・別トピックが混じる文脈（区分けの見出しが出る単位と、
 * 　同一ツリーだけで見出しの出ない単位の両方）
 *
 * 列の措置はサーバーが補うため、ここでは提案（既定値）だけを並べる。
 */
function reviewInput() {
  const items = Array.from({ length: 20 }, (_, index) => {
    const id = String(96500 + index);
    const replyId = String(Number(id) + 100);
    // 削除する単位では、通報されていない返信も同じ処置へ含める。一覧で文脈整理対象として
    // 見えるかどうかは、この形の単位でしか確認できない。
    const deletesTree = index % 3 === 0;
    // 4件に1件は、一度に開くと一覧が縦に伸びる件数にする。「もっと見る」で畳めるかは
    // この形の単位でしか確認できない。件数は一箇所で決め、reportCountと本数をずらさない。
    const reportCount = index % 4 === 3 ? 22 : (index % 4) + 1;
    // 通報表が1ページに収まらない単位。読めた件数を全部として出さない見出しは、
    // この形の単位でしか確認できない。管理画面の件数表示から総件数を読めた場合と、
    // 読めなかった場合の両方を出す。
    const reportsTruncated = index % 4 === 3;
    const reportTotalCount = index % 8 === 3 ? reportCount + 5 : undefined;
    // 別の木や別の掲示板から拾った文脈を混ぜる単位。区分けの見出しが出る一覧と、
    // 同一ツリーだけで見出しの出ない一覧の両方は、この作り分けでしか確認できない。
    const mixedContext = index % 3 === 1;
    const topicNumber = "423";
    const topicName = "雑談/掲示板6";
    return {
      id,
      title: `雑談 #${id}`,
      reportCount,
      reportsTruncated,
      ...(reportTotalCount === undefined ? {} : { reportTotalCount }),
      reports: Array.from({ length: reportCount }, (_, reportIndex) => ({
        reportId: String(29500 + index * 100 + reportIndex),
        targetCommentNumber: id,
        reason: reportIndex === 0 ? "掲示板のルールに反する表現だと思います。" : "",
        repeatAfterResponse: reportIndex === 1,
        createdAt: `2026/08/16 20:${String(10 + reportIndex).padStart(2, "0")}`,
      })),
      comments: [
        {
          commentNumber: String(Number(id) - 1),
          topicNumber,
          topicName,
          body: "このゲーム要素について、みなさんはどう評価していますか？",
          displayName: "名無しの旅人",
          createdAt: "2026/08/16 19:58",
          currentState: "公開中",
          url: `https://example.com/topic/${Number(id) - 1}`,
        },
        {
          commentNumber: id,
          topicNumber,
          topicName,
          body: deletesTree
            ? "対象となったコメント本文をここに表示します。前後の流れと一緒に読めるため、判断内容をすぐ照合できます。"
            : "具体的な理由を挙げながらゲーム内容への意見を述べています。",
          displayName: "名無しの旅人",
          createdAt: "2026/08/16 20:03",
          currentState: "公開中",
          parentCommentNumber: String(Number(id) - 1),
          url: `https://example.com/topic/${id}`,
        },
        {
          commentNumber: replyId,
          topicNumber,
          topicName,
          body: "対象投稿への返信も同じツリー内に表示します。",
          displayName: "名無しの旅人",
          createdAt: "2026/08/16 20:08",
          currentState: "公開中",
          parentCommentNumber: id,
          url: `https://example.com/topic/${replyId}`,
        },
        ...(mixedContext
          ? [
              {
                commentNumber: String(Number(id) + 200),
                topicNumber,
                topicName,
                body: "同じ掲示板の別の木として拾った前後文脈です。",
                displayName: "名無しの旅人",
                createdAt: "2026/08/16 20:11",
                currentState: "公開中",
                url: `https://example.com/topic/${Number(id) + 200}`,
              },
              {
                commentNumber: String(Number(id) + 300),
                topicNumber: "2",
                topicName: "管理連絡掲示板",
                body: "別の掲示板から拾った文脈です。どの掲示板の投稿かが行に出ます。",
                displayName: "名無しの旅人",
                createdAt: "2026/08/14 21:58",
                currentState: "公開中",
                url: `https://example.com/topic/2/${Number(id) + 300}`,
              },
            ]
          : []),
      ],
      history: deletesTree
        ? [{
            commentNumber: String(Number(id) - 120),
            topicNumber: "354",
            topicName: "雑談/幽境の激戦",
            body: "投稿履歴として確認した過去コメントの本文です。",
            displayName: "名無しの旅人",
            createdAt: "2026/08/15 18:42",
            currentState: "公開中",
            url: `https://example.com/topic/${Number(id) - 120}`,
          }]
        : [],
      publicUrl: `https://example.com/topic/${id}`,
      adminUrl: `https://example.com/admin/${id}`,
      basis: ["運用基準の該当項目"],
      recommendation: {
        targets: deletesTree
          ? [
              { commentNumber: id, currentState: "公開中" },
              { commentNumber: replyId, currentState: "公開中" },
            ]
          : [{ commentNumber: id, currentState: "公開中" }],
        operations: deletesTree
          ? [
              {
                operationId: "operation-1",
                operationType: "comment_delete",
                targetCommentNumbers: [id, replyId],
                messageIds: [],
              },
              {
                operationId: "operation-2",
                operationType: "report_complete",
                targetCommentNumbers: [id],
                messageIds: ["message-1"],
              },
              // 送信必須の操作も一件だけ混ぜ、送信しないを出さない扱いを確認できるようにする。
              ...(index === 3
                ? [{
                    operationId: "operation-3",
                    operationType: "public_notice",
                    targetCommentNumbers: [id],
                    messageIds: ["message-2"],
                  }]
                : []),
              // 投稿規制の列に既定値が入る単位も一つ作る。
              ...(index === 9
                ? [{
                    operationId: "operation-4",
                    operationType: "author_auto_ignore",
                    targetCommentNumbers: [id],
                    messageIds: [],
                  }]
                : []),
            ]
          : [
              {
                operationId: "operation-1",
                operationType: "no_external_action",
                targetCommentNumbers: [id],
                messageIds: [],
              },
              {
                operationId: "operation-2",
                operationType: "report_complete",
                targetCommentNumbers: [id],
                messageIds: ["message-1"],
              },
            ],
        // 列の措置（削除・通報の完了と無視・自動無視・ブロック）はサーバーが補う。
        // ここへ書くのは、既定で選んでおきたい追加候補と、列に属さない操作だけとする。
        operationCandidates: [
          // 本文つきの追加候補。推奨案には入らず、この行を選んだときだけ本文を送る。
          ...(deletesTree && index === 6
            ? [{
                operationId: "candidate-public-notice",
                operationType: "public_notice",
                targetCommentNumbers: [id],
                messageIds: ["message-3"],
                highImpact: false,
              }]
            : []),
        ],
        messages: [
          {
            messageId: "message-1",
            label: "通報完了メッセージ",
            text: deletesTree
              ? "ご通報ありがとうございます。確認のうえ対処しました。"
              : "ご通報ありがとうございます。確認しましたが、対処は行いません。",
          },
          ...(deletesTree && index === 3
            ? [{
                messageId: "message-2",
                label: "公開案内の本文",
                text: "掲示板の運用基準に基づき、一部のコメントを削除しました。",
              }]
            : []),
          ...(deletesTree && index === 6
            ? [{
                messageId: "message-3",
                label: "公開案内の本文",
                text: "掲示板の運用基準に基づき、このやり取りを削除しました。",
              }]
            : []),
        ],
      },
      dependencyGroup: index === 1 || index === 2 ? "tree-96501" : undefined,
    };
  });
  return { batchTitle: "未処理通報 20件のレビュー", items };
}

// 承認ストアは本番と同じ実装を使い、保存先だけ一時ディレクトリへ隔離する。
const storeDirectory = mkdtempSync(join(tmpdir(), "zawazawa-review-preview-"));
const store = createReviewStore({ directory: storeDirectory });
process.on("exit", () => rmSync(storeDirectory, { recursive: true, force: true }));

/** 画面を開くたびに新しい一覧を作る。送信後に読み込み直しても続けて確認できる。 */
function createBatch() {
  return store.create(normalizeReviewInput(reviewInput()));
}

const TOOL_ENDPOINT = "/preview-tools";
const TOOL_HANDLERS = {
  get_moderation_review_snapshot: (args) => store.snapshot(args),
  preview_moderation_decision: (args) => store.preview(args),
  submit_moderation_decisions: (args) => store.submit(args),
};

function callTool(name, args) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) throw new ReviewInputError("未対応のツールです。");
  return handler(args);
}

/**
 * ホスト連携の差し込み。実サーバーのループバック経路と同じく`window.openai`を与え、
 * ツール呼び出しは同一オリジンのエンドポイントから本物の承認ストアへ渡す。
 */
function bootstrapFor(summary) {
  return `<script>
window.__zawazawaStandalone = true;
window.openai = {
  toolOutput: ${embedJson(summary)},
  setWidgetState() {},
  async callTool(name, args) {
    const response = await fetch(${embedJson(TOOL_ENDPOINT)} + "/" + name, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "送信に失敗しました。");
    return { structuredContent: payload };
  },
  async sendFollowUpMessage() {},
};
</script>`;
}

// scriptタグの中へJSONを埋めるので、タグを閉じられる文字と行終端を実体として出す。
function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

// 実サーバーのループバック経路と同じアンカーへ差し込む。差し込めないHTMLをそのまま
// 配ると、ホスト連携のない画面を「接続できていません」として見せるだけで原因が分からない。
const BOOTSTRAP_ANCHOR = "<!-- host-bootstrap -->";
if (!template.includes(BOOTSTRAP_ANCHOR)) {
  process.stderr.write(`ui/review.html に${BOOTSTRAP_ANCHOR}がありません。\n`);
  process.exit(1);
}

// MCP Appsホスト経路だけがApp側SDKを使う。`ui://`で配るものと同じ組み立てにする。
const appTemplate = buildReviewHtml(template);

/** srcdocへHTML本文をそのまま載せるための属性値エスケープ。 */
function escapeAttribute(value) {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
}

/** `window.openai`を持つホスト相当。 */
function standalonePage() {
  return template.replace(BOOTSTRAP_ANCHOR, bootstrapFor(createBatch()));
}

// MCP Appsホスト（Claudeデスクトップなど）を模し、ui/initializeから送信までを検証する。
function hostHarnessPage() {
  const summary = createBatch();
  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8" /><title>MCP App host harness</title>
<style>
  body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #101512; color: #eff5f1; }
  header { padding: 8px 12px; font-size: 13px; border-bottom: 1px solid #344139; }
  iframe { display: block; width: 100%; height: 78vh; border: 0; background: transparent; }
  #host-log { position: sticky; bottom: 0; height: 18vh; overflow: auto; margin: 0; padding: 8px 12px; background: #101512; font-family: ui-monospace, monospace; font-size: 12px; border-top: 1px solid #344139; }
</style></head>
<body>
  <header>MCP Appsホスト模擬 / iframe: srcdoc（/raw と同一HTML）</header>
  <!-- Claudeデスクトップ相当の制約を再現する。allow-modalsを与えないため、
       UI側のshowModal()は失敗し、show()フォールバック経路が実際に通る。
       実ホストはui://資源のHTML本文をiframeへ直接渡すので、ここでもsrcdocで渡す。
       srcは使わない。src経由だと不透明オリジンからの副リソース要求になり、
       これを止める組み込みブラウザでは白紙になる。 -->
  <iframe id="app" sandbox="allow-scripts allow-forms" srcdoc="${escapeAttribute(appTemplate)}"></iframe>
  <pre id="host-log"></pre>
  <script>
    const sample = ${embedJson(summary)};
    const toolEndpoint = ${embedJson(TOOL_ENDPOINT)};
    const frame = document.getElementById("app");
    const log = document.getElementById("host-log");
    const state = { initialized: false, submission: null, messages: [] };
    let hostRequestId = 1000;
    window.hostLog = state.messages;

    function record(line) {
      state.messages.push(line);
      log.textContent += line + "\\n";
      log.scrollTop = log.scrollHeight;
    }

    function post(payload) {
      frame.contentWindow.postMessage(payload, "*");
    }

    // ホストはApp側のtools/callをサーバーへ中継する。ここでも解決規則を書き写さず、
    // 同一オリジンのエンドポイント経由で本物の承認ストアへ渡す。
    async function callServerTool(name, args) {
      const response = await fetch(toolEndpoint + "/" + name, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "ツール呼び出しに失敗しました。");
      return payload;
    }

    window.addEventListener("message", async (event) => {
      if (event.source !== frame.contentWindow) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (!message.method) {
        record("response #" + message.id + (message.error ? " error=" + message.error.code + " " + message.error.message : " ok"));
      } else {
        record(message.method + " " + (message.id === undefined ? "(notification)" : "#" + message.id) + (message.method === "ui/notifications/size-changed" ? " " + JSON.stringify(message.params) : ""));
      }

      // 実ホストと同じく、Appの申告した高さへiframeを合わせる。内側にスクロールを作らないので、
      // 一覧の末尾まで外側のスクロールだけで辿れる。sandboxされたiframeの内側へは
      // 合成入力のホイールが届かないため、この形でないと自動操作で下まで確認できない。
      if (message.method === "ui/notifications/size-changed") {
        const height = Number(message.params?.height);
        if (Number.isFinite(height) && height > 0) frame.style.height = height + "px";
        return;
      }
      if (message.method === "ui/initialize") {
        post({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2026-01-26",
            hostCapabilities: { serverTools: {} },
            hostInfo: { name: "preview-harness", version: "0.1.0" },
            hostContext: { theme: "dark", displayMode: "inline", locale: "ja-JP" },
          },
        });
        return;
      }
      if (message.method === "ui/notifications/initialized") {
        state.initialized = true;
        // 未対応メソッドへの応答（-32601であるべき）を確認する。
        post({ jsonrpc: "2.0", id: hostRequestId++, method: "ui/host-probe/unsupported", params: {} });
        post({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            content: [{ type: "text", text: sample.itemCount + "件の対処案を一覧表示しました。" }],
            structuredContent: sample,
          },
        });
        return;
      }
      if (message.method === "tools/call") {
        const name = message.params?.name;
        const args = message.params?.arguments || {};
        const decisions = args.decisions || [];
        record("tools/call " + name + (name === "submit_moderation_decisions" ? " decisions=" + decisions.length : ""));
        let structuredContent;
        try {
          structuredContent = await callServerTool(name, args);
        } catch (cause) {
          // 実ホストはツール失敗もisErrorの結果として返す。UI側の見せ方を確認する。
          post({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              isError: true,
              structuredContent: { errorCode: "review_input_invalid", message: cause.message },
              content: [{ type: "text", text: cause.message }],
            },
          });
          return;
        }
        if (name === "submit_moderation_decisions") state.submission = { decisions };
        post({ jsonrpc: "2.0", id: message.id, result: { structuredContent } });
        return;
      }
      if (message.id !== undefined && message.method) {
        // 未対応メソッドにUIがどう応答するかを確かめるための投げ込み口。
        post({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
    });
  <\/script>
</body>
</html>`;
}

const PAGES = new Map([
  ["/", standalonePage],
  ["/index.html", standalonePage],
  ["/raw", () => appTemplate],
  ["/mcp-app", hostHarnessPage],
]);

function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const rejectTooLarge = () => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      request.pause();
      reject(new RequestTooLargeError("送信内容が大きすぎます。"));
    };
    const declaredLength = Number(request.headers?.["content-length"]);
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    });
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      rejectTooLarge();
      return;
    }
    request.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        rejectTooLarge();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks).toString("utf8");
      chunks.length = 0;
      resolve(body);
    });
  });
}

function sendJson(response, status, value) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  // Oversized requests are paused before their body is drained.  Close that
  // connection after writing 413 so unread bytes cannot be parsed as a later
  // keep-alive request.
  if (status === 413) headers.connection = "close";
  response.writeHead(status, headers);
  response.end(JSON.stringify(value));
}

async function handleTool(request, response, name) {
  let result;
  try {
    result = callTool(name, JSON.parse(await readBody(request)));
  } catch (error) {
    // 入力起因の拒否だけを400にする。本番のループバック経路と同じ分け方にする。
    const status = error instanceof RequestTooLargeError
      ? 413
      : error instanceof ReviewInputError
        ? 400
        : 500;
    sendJson(response, status, {
      error: error.message,
    });
    return;
  }
  sendJson(response, 200, result);
}

export const previewServer = createServer((request, response) => {
  const path = (request.url || "/").split("?")[0];
  if (path === "/favicon.ico") {
    response.writeHead(204, { "cache-control": "no-store" }).end();
    return;
  }
  if (path.startsWith(`${TOOL_ENDPOINT}/`) && request.method === "POST") {
    handleTool(request, response, path.slice(TOOL_ENDPOINT.length + 1)).catch((error) => {
      sendJson(response, 500, { error: error.message });
    });
    return;
  }
  const page = PAGES.get(path);
  if (!page) {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(page());
});

if (process.env.ZAWAZAWA_PREVIEW_NO_LISTEN !== "1") {
  previewServer.listen(port, "localhost", () => {
    process.stdout.write(`Preview (openai host): http://localhost:${port}/\n`);
    process.stdout.write(`Preview (MCP Apps host): http://localhost:${port}/mcp-app\n`);
  });
}
