import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(resolve(pluginRoot, "skills/zawazawa-moderation/SKILL.md"), "utf8");
const policyReview = readFileSync(
  resolve(pluginRoot, "skills/zawazawa-moderation/references/policy-update.md"),
  "utf8",
);
const setupFlow = readFileSync(
  resolve(pluginRoot, "skills/zawazawa-setup/references/setup-flow.md"),
  "utf8",
);

test("通常処理は運用基準だけを読み、差分がある基準レビューで補助文書を読む", () => {
  const normalStart = skill.indexOf("2. 実行先リポジトリ");
  const reviewStart = skill.indexOf("6. 最終判断");
  assert.ok(normalStart >= 0 && reviewStart > normalStart);
  const normalFlow = skill.slice(normalStart, reviewStart);
  assert.match(normalFlow, /`運用基準\.md`を全文読む/u);
  assert.doesNotMatch(normalFlow, /根拠資料\.md|判断事例\.md/u);
  assert.match(
    skill.slice(reviewStart),
    /`changedItemIds`が空なら\[policy-update\.md\]\(references\/policy-update\.md\)を読まず/u,
  );
  assert.match(policyReview, /`運用基準\.md`、`根拠資料\.md`、`判断事例\.md`を全文読み/u);
  assert.match(policyReview, /明示的な承認/u);
});

test("初回設定の再開でもdry-runを省略せず未管理項目を拒否する", () => {
  assert.match(setupFlow, /再開時も`--dry-run`を省略しない/u);
  assert.match(setupFlow, /未管理の項目.*一つでもある場合は.*止める/u);
  assert.match(
    setupFlow,
    /編集済みの`運用基準\.md`はスクリプトから`preserve`として報告/u,
  );
  assert.match(setupFlow, /これは承認済みの差分を意味しない/u);
  assert.match(setupFlow, /統一テンプレート/u);
  assert.doesNotMatch(setupFlow, /generic|genshin-wiki/u);
  assert.doesNotMatch(setupFlow, /--profile/u);
});
