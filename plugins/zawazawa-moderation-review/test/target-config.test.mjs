import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  AUTONOMOUS_MODERATION_MODES,
  createTargetGuard,
  loadTargetConfig,
  MODERATION_MODES,
  TARGET_CONFIG_FILENAME,
} from "../server/target-config.mjs";
import {
  ADMINISTRATOR_AUTHORIZATION,
  AUTONOMOUS_AUTHORIZATIONS,
  LEGACY_AUTONOMOUS_AUTHORIZATIONS,
  REVIEW_AUTHORIZATION_SOURCES,
} from "../server/review-authorization.mjs";

// 自律承認を認めないモードは列挙値から導き、モードが増えても検査が漏れないようにする。
const SUPERVISED_MODES = MODERATION_MODES.filter(
  (mode) => !AUTONOMOUS_MODERATION_MODES.includes(mode),
);

test("運用モードの語彙と実行許可の出所の語彙が食い違わない", () => {
  assert.deepEqual([...MODERATION_MODES], ["restricted", "autonomous"]);
  // 実行時の照合は、承認記録へ焼き込んだ出所（review-authorization）と、束縛中の
  // モード（target-config）を突き合わせる。二つの列挙が離れると、片方だけに足した
  // モードでは承認を作れないか、作った承認を実行できないかのどちらかになる。
  assert.deepEqual([...AUTONOMOUS_AUTHORIZATIONS], [...AUTONOMOUS_MODERATION_MODES]);
  assert.deepEqual(
    [...REVIEW_AUTHORIZATION_SOURCES],
    [
      ADMINISTRATOR_AUTHORIZATION,
      ...AUTONOMOUS_MODERATION_MODES,
      ...LEGACY_AUTONOMOUS_AUTHORIZATIONS,
    ],
  );
  // 人間の承認は運用モード名と重ならない。記録の読み替えで出所が入れ替わらない。
  assert.equal(MODERATION_MODES.includes(ADMINISTRATOR_AUTHORIZATION), false);
});

function workspace(context, config) {
  const directory = mkdtempSync(join(tmpdir(), "zawazawa-target-config-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  if (config !== undefined) {
    writeFileSync(
      join(directory, TARGET_CONFIG_FILENAME),
      typeof config === "string" ? config : JSON.stringify(config),
    );
  }
  return directory;
}

function validConfig(overrides = {}) {
  return {
    version: 4,
    target: { groupKey: "genshinwiki", displayName: "原神Wiki" },
    moderation: { mode: "restricted" },
    ...overrides,
  };
}

test("設定は対象グループと運用モードを返す", (context) => {
  const directory = workspace(context, validConfig());
  const config = loadTargetConfig({ cwd: directory, env: {} });
  assert.equal(config.groupKey, "genshinwiki");
  assert.equal(config.displayName, "原神Wiki");
  assert.equal(config.moderationMode, "restricted");
  assert.equal(config.documents, undefined);
  assert.equal(config.configPath, join(directory, TARGET_CONFIG_FILENAME));
});

test("正本文書の名前はskillが固定するので設定では受け付けない", (context) => {
  const directory = workspace(context, validConfig({ documents: { policy: "docs/policy.md" } }));
  assert.throws(
    () => loadTargetConfig({ cwd: directory, env: {} }),
    (error) => error.code === "target_config_invalid",
  );
});

test("設定はリポジトリルートまで遡って探す", (context) => {
  const directory = workspace(context, validConfig());
  const nested = join(directory, "plugins", "zawazawa-moderation-review");
  mkdirSync(nested, { recursive: true });
  const config = loadTargetConfig({ cwd: nested, env: {} });
  assert.equal(config.groupKey, "genshinwiki");
});

test("環境変数の指定は探索より優先する", (context) => {
  const directory = workspace(context, validConfig());
  const other = workspace(context, undefined);
  const otherPath = join(other, TARGET_CONFIG_FILENAME);
  writeFileSync(
    otherPath,
    JSON.stringify({
      version: 4,
      target: { groupKey: "otherwiki", displayName: "別Wiki" },
      moderation: { mode: "restricted" },
    }),
  );
  const config = loadTargetConfig({
    cwd: directory,
    env: { ZAWAZAWA_TARGET_CONFIG: otherPath },
  });
  assert.equal(config.groupKey, "otherwiki");
});

test("設定が無い場合は既定値へ落ちず失敗する", (context) => {
  const directory = workspace(context, undefined);
  assert.throws(
    () =>
      loadTargetConfig({
        cwd: join(directory, "空"),
        env: { ZAWAZAWA_TARGET_CONFIG: join(directory, "無い", TARGET_CONFIG_FILENAME) },
      }),
    (error) => {
      assert.equal(error.code, "target_not_configured");
      assert.match(error.message, /zawazawa\.config\.json/u);
      return true;
    },
  );
});

test("環境変数も絶対パスと固定ファイル名だけを受け付ける", (context) => {
  const directory = workspace(context, validConfig());
  // 相対パスは作業ディレクトリ次第で別の実行先を指すため受け付けない。
  assert.throws(
    () => loadTargetConfig({ cwd: directory, env: { ZAWAZAWA_TARGET_CONFIG: TARGET_CONFIG_FILENAME } }),
    (error) => error.code === "target_config_invalid",
  );
  // 固定名以外のファイルを対象の出所にしない。configPathと同じ強さで検査する。
  const otherPath = join(workspace(context, undefined), "target.json");
  writeFileSync(otherPath, JSON.stringify(validConfig()));
  assert.throws(
    () => loadTargetConfig({ cwd: directory, env: { ZAWAZAWA_TARGET_CONFIG: otherPath } }),
    (error) => error.code === "target_config_invalid",
  );
});

test("壊れた設定と未設定を区別する", (context) => {
  const directory = workspace(context, "{ 壊れたJSON");
  assert.throws(
    () => loadTargetConfig({ cwd: directory, env: {} }),
    (error) => error.code === "target_config_invalid",
  );
});

test("不正なグループキーと未知のキーを拒否する", (context) => {
  const cases = [
    validConfig({ target: { groupKey: "Genshin Wiki", displayName: "原神Wiki" } }),
    { ...validConfig(), groupKey: "genshinwiki" },
    { ...validConfig(), version: 1 },
    { ...validConfig(), version: 2 },
    { ...validConfig(), version: 3 },
    validConfig({ moderation: { mode: "auto-review" } }),
    validConfig({ moderation: { mode: "always-proceed" } }),
    validConfig({ moderation: { stage: 1 } }),
  ];
  for (const [index, config] of cases.entries()) {
    const directory = workspace(context, config);
    assert.throws(
      () => loadTargetConfig({ cwd: directory, env: {} }),
      (error) => error.code === "target_config_invalid",
      `case ${index}`,
    );
  }
});

test("guardは対象グループだけを通し、失敗後の再設定を読み直す", (context) => {
  const directory = workspace(context, undefined);
  const env = {};
  const guard = createTargetGuard({ cwd: directory, env });
  assert.throws(() => guard.bind(), (error) => error.code === "target_not_configured");

  writeFileSync(join(directory, TARGET_CONFIG_FILENAME), JSON.stringify(validConfig()));
  const { targetContextId } = guard.bind();
  assert.equal(guard.assertGroupKey("genshinwiki", targetContextId).displayName, "原神Wiki");
  assert.throws(() => guard.assertGroupKey("otherwiki", targetContextId), (error) => {
    assert.equal(error.code, "group_not_allowed");
    assert.match(error.message, /genshinwiki/u);
    return true;
  });
});

test("どのモードでも対象を束縛し、管理者経路と自律経路を排他的に分ける", (context) => {
  for (const mode of MODERATION_MODES) {
    const directory = workspace(context, validConfig({ moderation: { mode } }));
    const guard = createTargetGuard({ cwd: directory, env: {} });
    const bound = guard.bind();
    assert.equal(bound.moderationMode, mode);
    assert.equal(guard.resolve(bound.targetContextId).moderationMode, mode);
    if (AUTONOMOUS_MODERATION_MODES.includes(mode)) {
      assert.equal(guard.assertAutonomousMode(bound.targetContextId).moderationMode, mode);
      assert.throws(() => guard.assertRestrictedMode(bound.targetContextId), (error) => {
        assert.equal(error.code, "moderation_mode_unsupported");
        assert.match(error.message, new RegExp(mode, "u"));
        return true;
      });
      continue;
    }
    assert.equal(guard.assertRestrictedMode(bound.targetContextId).moderationMode, mode);
    // 人間の承認を要するモードでは、自律判断の入口そのものが成立しない。
    assert.throws(() => guard.assertAutonomousMode(bound.targetContextId), (error) => {
      assert.equal(error.code, "moderation_mode_unsupported");
      assert.match(error.message, new RegExp(mode, "u"));
      return true;
    });
  }
  assert.ok(SUPERVISED_MODES.length > 0);
});

test("対象コンテキストIDは発行したプロセスの外では通らない", (context) => {
  const directory = workspace(context, validConfig());
  const issuer = createTargetGuard({ cwd: directory, env: {} });
  const other = createTargetGuard({ cwd: directory, env: {} });
  const { targetContextId } = issuer.bind();

  assert.equal(issuer.assertGroupKey("genshinwiki", targetContextId).groupKey, "genshinwiki");
  assert.throws(
    () => other.assertGroupKey("genshinwiki", targetContextId),
    (error) => error.code === "target_context_invalid",
  );
  // IDは束縛内容を持たない不透明な値で、呼び出し側が作り出すこともできない。
  assert.doesNotMatch(targetContextId, /genshinwiki|zawazawa\.config\.json/u);
  for (const forged of ["", "00000000-0000-4000-8000-000000000000", { }]) {
    assert.throws(
      () => issuer.assertGroupKey("genshinwiki", forged),
      (error) => error.code === "target_context_invalid",
    );
  }
});

function startServer(context, { targetConfigPath }) {
  const storeDirectory = mkdtempSync(join(tmpdir(), "zawazawa-target-config-store-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--no-warnings",
      "--experimental-loader",
      new URL("../test-support/mock-connector-loader.mjs", import.meta.url).href,
      fileURLToPath(new URL("../server/server.mjs", import.meta.url)),
    ],
    env: {
      PATH: process.env.PATH || "",
      ZAWAZAWA_REVIEW_STORE_DIR: storeDirectory,
      ZAWAZAWA_REVIEW_UI: "off",
      ZAWAZAWA_TARGET_CONFIG: targetConfigPath,
    },
  });
  const client = new Client({ name: "target-config-test", version: "0.1.0" });
  context.after(async () => {
    await client.close();
    rmSync(storeDirectory, { recursive: true, force: true });
  });
  return client.connect(transport).then(() => client);
}

function reviewItem() {
  return {
    id: "96517",
    comments: [{ topicNumber: "413", commentNumber: "96517" }],
    history: [],
    basis: ["運用基準の該当項目"],
    recommendation: {
      targets: [{ commentNumber: "96517" }],
      operations: [
        {
          operationId: "keep",
          operationType: "no_external_action",
          targetCommentNumbers: ["96517"],
          messageIds: [],
        },
      ],
      operationCandidates: [],
      messages: [],
    },
  };
}

test("設定した対象を返し、その対象で読み取れる", async (context) => {
  const directory = workspace(context, validConfig());
  const client = await startServer(context, {
    targetConfigPath: join(directory, TARGET_CONFIG_FILENAME),
  });

  const target = await client.callTool({ name: "get_moderation_target_config", arguments: {} });
  assert.equal(target.isError, undefined);
  assert.equal(target.structuredContent.groupKey, "genshinwiki");
  assert.equal(target.structuredContent.displayName, "原神Wiki");
  // 運用モードは以降の工程を分けるので返す。設定ファイルの場所は返さない。
  assert.equal(target.structuredContent.moderationMode, "restricted");
  assert.equal(target.structuredContent.configPath, undefined);
  assert.equal(target.structuredContent.documents, undefined);
  const targetContextId = target.structuredContent.targetContextId;

  const allowed = await client.callTool({
    name: "render_moderation_review",
    arguments: { batchTitle: "対象内", targetContextId, items: [reviewItem()] },
  });
  assert.equal(allowed.isError, undefined);
  assert.equal(allowed.structuredContent.itemCount, 1);
});

test("管理者向け一覧と自律承認は運用モードで排他的に分ける", async (context) => {
  for (const mode of MODERATION_MODES) {
    const directory = workspace(context, validConfig({ moderation: { mode } }));
    const client = await startServer(context, {
      targetConfigPath: join(directory, TARGET_CONFIG_FILENAME),
    });
    const target = await client.callTool({ name: "get_moderation_target_config", arguments: {} });
    assert.equal(target.isError, undefined);
    assert.equal(target.structuredContent.moderationMode, mode);
    const targetContextId = target.structuredContent.targetContextId;

    const rendered = await client.callTool({
      name: "render_moderation_review",
      arguments: { batchTitle: `${mode}の一覧`, targetContextId, items: [reviewItem()] },
    });
    if (mode === "autonomous") {
      assert.equal(rendered.isError, true);
      assert.equal(rendered.structuredContent.errorCode, "moderation_mode_unsupported");
    } else {
      assert.equal(rendered.isError, undefined);
    }
    const prepared = await client.callTool({
      name: "prepare_autonomous_moderation_review",
      arguments: { batchTitle: `${mode}の自律一覧`, targetContextId, items: [reviewItem()] },
    });
    const batch = mode === "autonomous" ? prepared : rendered;
    if (mode === "autonomous") {
      assert.equal(prepared.isError, undefined, JSON.stringify(prepared));
    } else {
      assert.equal(prepared.isError, true);
      assert.equal(prepared.structuredContent.errorCode, "moderation_mode_unsupported");
    }
    const submitted = await client.callTool({
      name: "submit_autonomous_moderation_decisions",
      arguments: {
        targetContextId,
        batchId: batch.structuredContent.batchId,
        snapshotToken: batch.structuredContent.snapshotToken,
        decisions: [{ itemId: "96517", choice: "approve" }],
      },
    });
    if (AUTONOMOUS_MODERATION_MODES.includes(mode)) {
      assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
      // 実行許可の出所は宣言されたモードそのものとして記録へ残る。
      assert.equal(submitted.structuredContent.submission.authorizedBy, mode);
      continue;
    }
    // 人間の承認を要するモードでは、設定値を変えない限りこの経路が成立しない。
    assert.equal(submitted.isError, true);
    assert.equal(submitted.structuredContent.errorCode, "moderation_mode_unsupported");
    assert.match(submitted.content[0].text, new RegExp(mode, "u"));
  }
});

test("未設定のまま読み取りツールを使えない", async (context) => {
  const directory = workspace(context, undefined);
  const client = await startServer(context, {
    targetConfigPath: join(directory, "無い", TARGET_CONFIG_FILENAME),
  });

  const target = await client.callTool({ name: "get_moderation_target_config", arguments: {} });
  assert.equal(target.isError, true);
  assert.equal(target.structuredContent.errorCode, "target_not_configured");

  assert.equal(target.structuredContent.targetContextId, undefined);

  // 束縛できていないので、後続ツールへ渡せる対象コンテキストIDが存在しない。
  // 値を捏造しても通らないことまで確認する。
  const forged = "対象を推測した値";
  const reports = await client.callTool({
    name: "get_zawazawa_open_reports",
    arguments: { targetContextId: forged },
  });
  assert.equal(reports.isError, true);
  assert.equal(reports.structuredContent.errorCode, "target_context_invalid");

  const rendered = await client.callTool({
    name: "render_moderation_review",
    arguments: {
      batchTitle: "未設定",
      targetContextId: forged,
      items: [reviewItem()],
    },
  });
  assert.equal(rendered.isError, true);
  assert.equal(rendered.structuredContent.errorCode, "target_context_invalid");
});
