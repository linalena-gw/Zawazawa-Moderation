import { writeFileSync } from "node:fs";
import { gotoChecked, launchAuthContext } from "../server/zawazawa-connector.mjs";
import { GROUP_KEY } from "../server/identifiers.mjs";

const groupKey = process.argv[2];
if (!groupKey) {
  throw new Error("グループキーが必要です。npm run auth:zawazawa -- <グループキー> の形で指定してください。");
}
if (!GROUP_KEY.test(groupKey)) {
  throw new Error("グループキーの形式が不正です。");
}

let context;
try {
  context = await launchAuthContext();
} catch (error) {
  // 何をすれば始められるかは文言が持つ。起動できないまま先へ進めないため、理由だけを
  // 伝えて終わる。出力先がパイプでも書き終える前に終わらないよう、ここは同期で書く。
  writeFileSync(1, `${error.message}\n`);
  process.exit(1);
}
const pages = context.pages();
const page = pages[0] || (await context.newPage());
try {
  await gotoChecked(page, `https://z.wikiwiki.jp/m/${groupKey}/comment`);
} catch (error) {
  // 拒否画面はログイン失敗と見分けが付かないため、理由を明示してから操作を委ねる。
  process.stdout.write(`${error.message}\n`);
}

process.stdout.write(
  "専用ブラウザでZAWAZAWAへログインし、グループのコメント管理画面が表示されたらブラウザを閉じてください。認証情報は専用プロファイル内だけに保存されます。\n",
);

await new Promise((resolveClose) => context.once("close", resolveClose));
