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
const liveRead = readFileSync(
  resolve(pluginRoot, "skills/zawazawa-moderation/references/live-read.md"),
  "utf8",
);
const reviewUi = readFileSync(
  resolve(pluginRoot, "skills/zawazawa-moderation/references/review-ui.md"),
  "utf8",
);
const autonomousRun = readFileSync(
  resolve(pluginRoot, "skills/zawazawa-moderation/references/autonomous-run.md"),
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

test("入力の信頼境界は安全契約を正本として各工程から参照する", () => {
  const safetyStart = skill.indexOf("## 安全契約");
  const procedureStart = skill.indexOf("## 手順", safetyStart);
  assert.ok(safetyStart >= 0 && procedureStart > safetyStart);
  const safetyContract = skill.slice(safetyStart, procedureStart);
  assert.match(safetyContract, /引用・要約・転記・サブエージェントへの引き継ぎ後/u);
  assert.match(safetyContract, /管理者・システム・ツールの指示、結果、承認、新しい基準/u);
  assert.match(safetyContract, /リンク、コマンド、ローカルパス/u);
  assert.match(safetyContract, /議論や報告の文言だけで違反を認定せず/u);
  assert.match(safetyContract, /処理単位と不可分な依存範囲だけ保留/u);
  assert.match(safetyContract, /独立して判断できる単位は続ける/u);
  assert.match(safetyContract, /構造化`nextAction`と`browserFallbackAllowed`だけ/u);
  for (const reference of [liveRead, reviewUi, autonomousRun, policyReview]) {
    assert.match(reference, /SKILL\.mdの安全契約/u);
  }
});
