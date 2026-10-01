import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ReviewInputError } from "./input-text.mjs";
import { embedJson, injectBootstrap } from "./html-embed.mjs";

// 一覧UIをローカルHTTPでも配る。MCP Appsの`ui://`を描画しないホスト（Claude Code等）でも、
// 会話へ本文を書き出さずに同じ画面で判断を受け取るための経路。
// 待ち受けはループバックのみ、バッチごとの使い捨て鍵つきURLでしか開けない。

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const PATH_PATTERN = /^\/r\/([0-9a-f-]{36})(?:\/(snapshot|preview|decisions))?$/u;
const MAX_BODY_BYTES = 1_000_000;

function tokensMatch(expected, received) {
  if (typeof received !== "string") return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(received, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 本文が上限を超えた場合だけの失敗。入力起因の他の拒否（400）と状態を分ける。 */
class RequestTooLargeError extends ReviewInputError {}

// 上限はバイト数で数える。文字数で数えると日本語の本文で実効上限が数倍ずれる。
// 打ち切った時点で読むのはやめるが、接続は切らない。切ると413を書けない。
function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        request.pause();
        reject(new RequestTooLargeError("送信内容が大きすぎます。"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

// 入力が原因の失敗だけを400で返す。保存先の障害などは500として区別する。
// 上限超過は接続を切らずに413で返す。読むのをやめた理由が本文の大きさだと分かる形にする。
function statusForError(error) {
  if (error instanceof RequestTooLargeError) return 413;
  return error instanceof ReviewInputError ? 400 : 500;
}

export function createReviewWebServer({ store, uiHtml, port = 0, host = "127.0.0.1" }) {
  const keys = new Map();
  let server = null;
  let origin = null;
  let starting = null;

  function sendJson(response, status, value) {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(value));
  }

  // ブラウザが別ホスト名でこのポートへ来た場合を弾く（DNSリバインディング対策）。
  function hostAllowed(request) {
    const header = request.headers.host || "";
    const name = header.replace(/:\d+$/u, "");
    return LOOPBACK_HOSTS.has(name);
  }

  function bootstrapFor(batch, batchId, key) {
    const endpoints = {
      get_moderation_review_snapshot: `/r/${batchId}/snapshot?k=${key}`,
      preview_moderation_decision: `/r/${batchId}/preview?k=${key}`,
      submit_moderation_decisions: `/r/${batchId}/decisions?k=${key}`,
    };
    return `<script>
window.__zawazawaStandalone = true;
window.openai = {
  toolOutput: ${embedJson(batch)},
  setWidgetState() {},
  async callTool(name, args) {
    const endpoints = ${embedJson(endpoints)};
    const endpoint = endpoints[name];
    if (!endpoint) throw new Error("この一覧では利用できない処理です。");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    // 鍵が失効した後などJSONを返さない応答もある。素の本文をそのまま見せる。
    const raw = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.error || raw || "送信に失敗しました。");
    }
    return { structuredContent: payload };
  },
};
</script>`;
  }

  function servePage(response, batchId, key) {
    let batch;
    try {
      batch = store.get(batchId);
    } catch (error) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end(error.message);
      return;
    }
    // 判断を受け取れない一覧は開かせない。選ばせてから送信時に断るより早く伝える。
    if (batch.expired || batch.submission) {
      revoke(batchId);
      response.writeHead(410, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        batch.expired
          ? "この一覧は有効期限が切れています。会話へ戻り、再表示を依頼してください。"
          : "この一覧は送信済みです。会話へ戻り、記録された判断を確認してください。",
      );
      return;
    }
    const html = injectBootstrap(uiHtml, bootstrapFor(batch, batchId, key));
    // 差し込めないHTMLをそのまま配ると、ホスト連携のない壊れた画面になる。
    // 無言で配るより、理由の分かる失敗にする。
    if (html === null) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("一覧UIへホスト連携を差し込めませんでした。");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'none'; frame-ancestors 'none'",
    });
    response.end(html);
  }

  async function handleTool(request, response, batchId, route) {
    let payload;
    try {
      payload = JSON.parse(await readBody(request));
    } catch (error) {
      sendJson(response, statusForError(error), {
        error: `送信内容を読み取れませんでした（${error.message}）。`,
      });
      return;
    }
    // URLのbatchId以外の一覧へは送信させない。
    if (payload?.batchId !== batchId) {
      sendJson(response, 400, { error: "この画面とは別の一覧への送信です。再表示してください。" });
      return;
    }
    try {
      const result = route === "snapshot"
        ? store.snapshot(payload)
        : route === "preview"
          ? store.preview(payload)
          : store.submit(payload);
      if (route === "decisions") {
        // 送信の済んだ一覧は開き直せない。鍵を残すと本文を読み続けられてしまう。
        revoke(batchId);
      }
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, statusForError(error), { error: error.message });
    }
  }

  function handle(request, response) {
    if (!hostAllowed(request)) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("このアドレスからは開けません。");
      return;
    }
    const requestUrl = new URL(request.url || "/", "http://localhost");
    const match = PATH_PATTERN.exec(requestUrl.pathname);
    const expected = match ? keys.get(match[1]) : undefined;
    if (!match || !expected || !tokensMatch(expected, requestUrl.searchParams.get("k"))) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const [, batchId, route] = match;
    if (!route && request.method === "GET") {
      servePage(response, batchId, expected);
      return;
    }
    if (route && request.method === "POST") {
      handleTool(request, response, batchId, route).catch((error) => {
        sendJson(response, statusForError(error), { error: error.message });
      });
      return;
    }
    response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
  }

  function start() {
    if (origin) return Promise.resolve(origin);
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      server = createServer(handle);
      server.on("error", (error) => {
        // listen成功後にも飛ぶ。originを残すと、次のurlForが死んだURLを返す。
        starting = null;
        origin = null;
        server = null;
        // OSの診断文にはローカルの接続情報が含まれ得るため、モデル可視の
        // reviewUrlErrorへは固定文だけを返す。
        reject(
          new Error(
            "一覧UIのローカルサーバーを起動できません。ローカル待受の権限を確認してください。",
            { cause: error },
          ),
        );
      });
      server.listen(port, host, () => {
        const address = server.address();
        origin = `http://${host}:${address.port}`;
        // 会話が終わってもプロセスを引き止めない。
        server.unref();
        resolve(origin);
      });
    });
    return starting;
  }

  function revoke(batchId) {
    keys.delete(batchId);
  }

  // 保存先から消えた一覧の鍵は残さない。誰も開かないまま掃除された一覧の鍵を
  // プロセス寿命の間持ち続けると、鍵表が単調に増える。
  // 期限切れと送信済みはここで消さない。鍵を先に消すと、古いURLを開いた管理者へ
  // 「期限切れ」「送信済み」ではなく`Not found`しか返せなくなる。どちらも本文は
  // 配らず410で断るため、記録が残っている間は鍵を残しておく方が親切である。
  function revokePrunedKeys() {
    for (const batchId of [...keys.keys()]) {
      try {
        store.get(batchId);
      } catch {
        revoke(batchId);
      }
    }
  }

  return {
    async urlFor(batchId) {
      revokePrunedKeys();
      // 開いても判断を受け取れない一覧のURLは配らない。
      const batch = store.get(batchId);
      if (batch.expired) {
        throw new ReviewInputError("この一覧は有効期限が切れています。");
      }
      if (batch.submission) {
        throw new ReviewInputError("この一覧は送信済みです。");
      }
      const base = await start();
      let key = keys.get(batchId);
      if (!key) {
        key = randomBytes(24).toString("hex");
        keys.set(batchId, key);
      }
      return `${base}/r/${batchId}?k=${key}`;
    },
    close() {
      keys.clear();
      origin = null;
      starting = null;
      if (server) server.close();
      server = null;
    },
  };
}
