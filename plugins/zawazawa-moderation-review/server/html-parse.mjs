/**
 * HTMLを読むための共通部品。公開ページと管理画面の双方がここを使う。
 * 整形規則が経路ごとに分かれると、同じコメントの本文が読み取り経路によって変わり、
 * 違反判定の再現性が壊れるため、規則はこのモジュールだけが持つ。
 *
 * 解析そのものはcheerio（既定でparse5）に任せる。閉じタグの省略、入れ子の表、
 * 属性値に含まれる`>`、`textarea`の扱いは、いずれも自前の正規表現では
 * 静かに読み違える一方、閲覧者のブラウザは仕様どおりに読む。管理者が見る画面と
 * 同じ木を読むことが、本文の同一性を保つ前提になる。
 */

// 取得はこのモジュールの外（`requestContext`と`fetch`）で行う。ここは`load`しか使わず、
// `fromURL`のような取得の入口には触れない。
// `cheerio/slim`へは寄せられない。slimの既定の解析器はhtmlparser2で、`textarea`の
// 改行正規化も閉じタグ省略の補正も行わない。閲覧者のブラウザと同じ木を読むという
// 前提そのものが崩れる。
import * as cheerio from "cheerio";

/** 閉じ目で段落の区切りを入れる要素。可視テキストの改行はここだけで決める。 */
const BLOCK_ELEMENTS = new Set([
  "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre",
]);

/** ページ全体の文書として読む。閲覧者のブラウザと同じ木構造になる。 */
export function loadDocument(html) {
  return cheerio.load(html);
}

/** 断片として読む。`html`や`body`を補わない。 */
export function loadFragment(html) {
  return cheerio.load(html, null, false);
}

/** RSSはHTMLの整形規則を当てずに読む。 */
export function loadXml(xml) {
  return cheerio.load(xml, { xml: true });
}

/**
 * 可視テキストを組み立てる。走査は明示スタックで行い、木の深さで再帰しない。
 * 投稿者は引用の入れ子を好きなだけ深く書けるため、深さに比例して呼び出し段数が
 * 増える書き方だと、その1件でトピック全体の読み取りが落ちる。
 */
function renderNodes(nodes) {
  const parts = [];
  const stack = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) stack.push({ node: nodes[index] });

  while (stack.length) {
    const item = stack.pop();
    // 子を出し終えた閉じ目。段落の区切りはここだけで入れる。
    if (item.blockEnd) {
      parts.push("\n\n");
      continue;
    }
    const node = item.node;
    if (node.type === "text") {
      parts.push(node.data || "");
      continue;
    }
    if (!node.name) continue;
    const name = node.name.toLowerCase();
    // 画面に出ない要素の中身は可視テキストに含めない。
    if (name === "script" || name === "style") continue;
    if (name === "br") {
      parts.push("\n");
      continue;
    }
    // リンク先URLやalt以外の属性は取り出さない。判定対象の原文は管理画面から読む。
    if (name === "img") {
      parts.push(node.attribs?.alt || "");
      continue;
    }
    if (BLOCK_ELEMENTS.has(name)) stack.push({ blockEnd: true });
    const children = node.children || [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index] });
  }
  return parts.join("");
}

function nodesOf(input) {
  if (typeof input === "string") return loadFragment(input).root()[0].children || [];
  if (typeof input?.toArray === "function") return input.toArray();
  return Array.isArray(input) ? input : [input];
}

/**
 * 描画済みの本文を、閲覧者が見るのと同じ可視テキストへ落とす。
 * HTML文字列でも、読み込み済みの要素でも受け取れる。
 */
export function htmlToText(input) {
  return renderNodes(nodesOf(input))
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
