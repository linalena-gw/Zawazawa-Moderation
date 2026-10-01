/**
 * 一覧HTMLへの値の差し込み。
 *
 * ホスト連携（ループバック経路）と結果報告（保存するHTML）は、どちらも同じ一覧HTMLの
 * 決まった位置へ`<script>`を一つ差し込む。差し込み位置と埋め込み値の逃がし方だけを
 * ここに置き、差し込む中身は呼び出し側が持つ。
 */

// 一覧UIの本体スクリプトより前でなければならない。`<script>`のような一般的な並びを
// 目印にすると、HTMLの整形や要素の追加で差し込み位置が黙って動くため、専用の
// アンカーを置く。
export const BOOTSTRAP_ANCHOR = "<!-- host-bootstrap -->";

/** scriptタグの中へJSONを埋めるので、タグを閉じられる文字と行終端を実体として出す。 */
export function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

/**
 * アンカー位置へスクリプトを差し込む。アンカーが無いHTMLは、そのまま配ると
 * 連携のない壊れた画面になるため、差し込めなかったことを`null`で返す。
 */
export function injectBootstrap(uiHtml, script) {
  const anchorAt = uiHtml.indexOf(BOOTSTRAP_ANCHOR);
  if (anchorAt === -1) return null;
  return (
    uiHtml.slice(0, anchorAt) + script + uiHtml.slice(anchorAt + BOOTSTRAP_ANCHOR.length)
  );
}
