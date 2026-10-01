/**
 * MCP Apps（SEP-1865）のApp側SDKを、一覧UIのHTMLへ直接埋め込む。
 *
 * ホストは`ui://`資源を1つの自己完結HTMLとして受け取り、外部読み込みを禁じたCSPの
 * iframeで描画する。バンドラを持ち込まず、公式SDKの依存込みビルドをそのまま差し込む。
 * ハンドシェイクとメッセージ検証を自前で持たないための経路なので、
 * 差し込めない場合は黙って自前実装へ戻さず、起動時に止める。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// 埋め込み位置。ここより後ろで一覧UIの本体スクリプトが`window.McpApps`を読む。
const RUNTIME_ANCHOR = "<!-- mcp-app-runtime -->";

/** ESMの`export{...}`を、素のscriptから読めるグローバルへ付け替える。 */
function toGlobalScript(source) {
  const match = /export\s*\{([^}]*)\}\s*;?\s*$/u.exec(source);
  if (!match) {
    throw new Error(
      "MCP Apps SDK（@modelcontextprotocol/ext-apps/app-with-deps）の書き出しを解釈できません。SDKの更新でバンドル形式が変わった可能性があります。",
    );
  }
  const properties = match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [local, exported] = entry.split(/\s+as\s+/u).map((part) => part.trim());
      return `${JSON.stringify(exported || local)}:${local}`;
    });
  return `${source.slice(0, match.index)}\nglobalThis.McpApps={${properties.join(",")}};\n`;
}

let cached = null;

/** 埋め込むスクリプト本体。プロセス内で一度だけ読み、以降は使い回す。 */
export function mcpAppRuntimeScript() {
  if (cached) return cached;
  const source = readFileSync(
    require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"),
    "utf8",
  );
  // script要素の中へ入れるので、閉じタグとコメント開始に見える並びだけ無害化する。
  cached = toGlobalScript(source)
    .replace(/<\/script/giu, "<\\/script")
    .replace(/<!--/gu, "<\\!--");
  return cached;
}

/**
 * 一覧UIのHTMLへApp側SDKを差し込む。差し込み位置が無いHTMLは、
 * ハンドシェイクのできない画面をホストへ配ることになるため受け付けない。
 */
export function buildReviewHtml(uiHtml) {
  const anchorAt = uiHtml.indexOf(RUNTIME_ANCHOR);
  if (anchorAt === -1) {
    throw new Error(`一覧UIに${RUNTIME_ANCHOR}がありません。MCP Apps SDKを差し込めません。`);
  }
  return (
    uiHtml.slice(0, anchorAt) +
    `<script>${mcpAppRuntimeScript()}</script>` +
    uiHtml.slice(anchorAt + RUNTIME_ANCHOR.length)
  );
}
