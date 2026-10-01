/**
 * 入力テキストの正規化と表示禁止情報の検査。
 *
 * 呼び出し側の入力を扱うモジュールが共通で使う最下層で、レビュー、完全案、承認記録の
 * どの構造も知らず、識別子の形式定義以外を参照しない。ここを通した値だけを判断材料と
 * 送信本文に使う。
 */
import { isIP } from "node:net";

import { NUMBER } from "./identifiers.mjs";

// 呼び出し側の入力が原因で断る場合に使う。内部の失敗（保存先が読めない等）と
// 区別できないと、ローカルUIがディスク障害を管理者の入力ミスとして見せてしまう。
export class ReviewInputError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ReviewInputError";
  }
}

const FORBIDDEN_TEXT_PATTERNS = [
  /\buser-agent\s*[:：=＝][^\r\n]*/iu,
  /(?:セッション(?:ID|トークン)?|session(?:[_ -]?(?:id|token))?)\s*[:：=＝][^\r\n]*/iu,
  /(?:通報者(?:識別子|ID|表示名|名前|trip|トリップ)?|\breporter(?:[_ -]?(?:id|(?:display[_ -]?)?name|trip))?\b)\s*[:：=＝][^\r\n]*/iu,
  /(?:\b(?:ip(?:[_ -]?address)?|remote[_ -]?addr(?:ess)?)\b|IPアドレス|接続元)\s*[:：=＝][^\r\n]*/iu,
  /(?:\bhost\b|ホスト)\s*[:：=＝][^\r\n]*/iu,
  /(?:\bport\b|ポート)\s*[:：=＝][^\r\n]*/iu,
];

// IP候補は前後を区切りで挟まれた並びだけを見る。区切りを見ないと、語の途中にある
// `std::cout`の`d::c`のような並びが短縮IPv6として成立してしまい、判定対象の本文を
// 表示禁止情報と誤認して、管理者が書いた対処メッセージの承認まで止めてしまう。
const IP_CANDIDATE = /(?<![0-9a-z:.])[0-9a-f:.]+(?![0-9a-z:.])/giu;
export const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

function trimDots(value) {
  return value.replace(/^\.+|\.+$/gu, "");
}

function containsIPAddress(value) {
  IP_CANDIDATE.lastIndex = 0;
  const candidates = value.match(IP_CANDIDATE) || [];
  return candidates.some((candidate) => isIP(trimDots(candidate)) !== 0);
}

/**
 * モデルと管理者が書いた自由文に表示禁止情報が混ざっていないかを確かめる。承認記録、
 * 完全案、ZAWAZAWAへ送る本文はどれもここを通った値だけで作る。コネクタ由来の値は
 * 出力境界の項目許可リストで守られるので、この判定へは通さない。判断材料の本文を
 * 値だけを理由に落とさないためである。
 */
export function assertNoSensitiveData(value, path = "input") {
  if (typeof value === "string") {
    const containsForbiddenText = FORBIDDEN_TEXT_PATTERNS.some((pattern) =>
      pattern.test(value),
    );
    if (containsIPAddress(value) || containsForbiddenText) {
      throw new ReviewInputError(`${path}に表示禁止情報の可能性がある文字列が含まれています。`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveData(entry, `${path}[${index}]`));
    return;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, entry]) =>
      assertNoSensitiveData(entry, `${path}.${key}`),
    );
  }
}

export function cleanText(value) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "").trim();
}

export function cleanCommentNumber(value, label) {
  if (typeof value !== "string") {
    throw new ReviewInputError(`${label}は文字列で指定してください。`);
  }
  const normalized = cleanText(value);
  if (!NUMBER.test(normalized)) {
    throw new ReviewInputError(`${label}は1〜20桁の数字で指定してください。`);
  }
  return normalized;
}

export function cleanReportId(value, label) {
  if (typeof value !== "string") {
    throw new ReviewInputError(`${label}は文字列で指定してください。`);
  }
  const normalized = cleanText(value);
  if (!REPORT_ID_PATTERN.test(normalized)) {
    throw new ReviewInputError(`${label}の形式が正しくありません。`);
  }
  return normalized;
}

export function cleanTextArray(values = []) {
  return values.map(cleanText).filter(Boolean);
}

export function inputText(value, label, { optional = false, max = 4000 } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") {
    throw new ReviewInputError(`${label}は文字列で指定してください。`);
  }
  const normalized = cleanText(value);
  if (!normalized && !optional) throw new ReviewInputError(`${label}を指定してください。`);
  if (normalized.length > max) {
    throw new ReviewInputError(`${label}が長すぎます。`);
  }
  return normalized || undefined;
}

export function inputArray(value, label, { min = 0, max = 100 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new ReviewInputError(`${label}は${min}件以上${max}件以下で指定してください。`);
  }
  return value;
}
