import { z } from "zod/v3";
import { errorCodesForFamily } from "./error-codes.mjs";

export const GROUP_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
// コメントURLの`/topic/<トピック番号>/<コメント番号>`が示すとおり、トピック番号と
// コメント番号は同じ表現領域の値で、対象はこの二つの組で一意に決まる。入力の正規化、
// 承認済みtarget、実行ジャーナルの対象番号は、この一つの定義だけを使う。層ごとに
// 写しを置くと、入力で受けた番号を送信境界の内側で拒むずれが起こりうる。
export const NUMBER = /^[1-9][0-9]{0,19}$/u;

export const zNumber = z.string().regex(NUMBER, "番号の形式が不正です。");

// ZAWAZAWAへ名乗るUser-Agent。公開ページ取得と管理画面取得で同じ一つを使う。素性を隠さず、
// ブラウザの綴りを騙らない。ZAWAZAWAは`HeadlessChrome`を含むUser-Agentだけを403で拒むため、
// ヘッドレス起動はこの値を名乗ることで拒否を受けずに済む（偽装ではなく、
// 実際の呼び出し元を書いた結果としてそうなる）。
export const ZAWAZAWA_USER_AGENT =
  "ZawazawaModerationReview/0.1 (ZAWAZAWA group moderation assistant; operated by the group administrator)";

// 管理画面が示すコメントの現在状態のうち、削除済みを表す値。承認時状態、実行直前照合、
// 送信結果の判定が同じ一つの綴りを使う。
export const DELETED_COMMENT_STATE = "削除済み";

const CONNECTOR_ERROR_CODES = errorCodesForFamily("connector");

export class ZawazawaConnectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ZawazawaConnectorError";
    this.code = CONNECTOR_ERROR_CODES.includes(code) ? code : "unknown";
  }
}

export function connectorErrorCode(error) {
  return error instanceof ZawazawaConnectorError ? error.code : "unknown";
}
