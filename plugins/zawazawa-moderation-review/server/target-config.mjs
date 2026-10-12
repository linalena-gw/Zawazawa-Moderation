import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod/v4";
import { GROUP_KEY } from "./identifiers.mjs";
import { errorCodesForFamily, recoveryForErrorCode } from "./error-codes.mjs";

export const TARGET_CONFIG_FILENAME = "zawazawa.config.json";
export const TARGET_CONFIG_ENV = "ZAWAZAWA_TARGET_CONFIG";
// 正本文書の名前はskillが固定する。設定へ持たせると二つ目の出所ができるため、
// ここでは扱わない。対象グループと運用モードだけを安全制約として束縛する。
const MAX_CONFIG_BYTES = 64 * 1024;
// 発行済み対象コンテキストの保持上限。長く動くサーバーで束縛が際限なく積み上がらない。
const MAX_TARGET_CONTEXTS = 32;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

/** 宣言できる運用モード。実行許可の出所がモードごとに違う。 */
export const MODERATION_MODES = Object.freeze(["restricted", "autonomous"]);
/** 人間の承認に代えて、エージェント自身が実行許可を作れるモード。 */
export const AUTONOMOUS_MODERATION_MODES = Object.freeze(["autonomous"]);
const AUTONOMOUS_MODE_SET = new Set(AUTONOMOUS_MODERATION_MODES);

/** 自律経路の実行許可を作れるモードか。restrictedでは常に人間の承認を要する。 */
export function isAutonomousMode(moderationMode) {
  return AUTONOMOUS_MODE_SET.has(moderationMode);
}

const TARGET_CONFIG_ERROR_CODES = errorCodesForFamily("targetConfig");

export class TargetConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TargetConfigError";
    this.code = TARGET_CONFIG_ERROR_CODES.includes(code) ? code : "target_config_invalid";
  }
}

const configSchema = z
  .object({
    version: z.literal(4),
    target: z
      .object({
        groupKey: z.string().regex(GROUP_KEY, "グループキーの形式が不正です。"),
        displayName: z
          .string()
          .min(1)
          .max(100)
          .refine((value) => !CONTROL_CHARACTER.test(value), {
            message: "表示名に制御文字を含められません。",
          }),
      })
      .strict(),
    moderation: z
      .object({
        mode: z.enum(MODERATION_MODES),
      })
      .strict(),
  })
  .strict();

function findConfigPath(cwd) {
  let directory = resolve(cwd);
  for (;;) {
    const candidate = join(directory, TARGET_CONFIG_FILENAME);
    try {
      // 存在確認で中身を読まない。上限検査を通る唯一の読み取りをreadConfigFileに残す。
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 読めない候補は無いものとして上位へ進む。
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function notConfigured(detail) {
  return new TargetConfigError(
    "target_not_configured",
    `対象グループが未設定のため、ZAWAZAWAの読み取りを行いません。${detail}実行先リポジトリのルートにある${TARGET_CONFIG_FILENAME}の絶対パスをconfigPathへ渡して再試行してください。設定を推測して別のグループを読み取らないでください。`,
  );
}

function firstIssueMessage(error) {
  const issue = error.issues?.[0];
  if (!issue) return "内容が設定の形式に合いません。";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * 明示された設定パスを検査する。ここを緩めると、実行先以外の任意のファイルが
 * 対象グループの出所になる。絶対パスと固定ファイル名だけを通す。
 * `configPath`と環境変数はどちらも同じ強さの入口なので、同じ検査を通す。
 */
function normalizeExplicitPath(configPath, source = "設定パス") {
  if (typeof configPath !== "string" || CONTROL_CHARACTER.test(configPath)) {
    throw new TargetConfigError(
      "target_config_invalid",
      `${source}に使えない文字が含まれています。実行先リポジトリのルートにある${TARGET_CONFIG_FILENAME}の絶対パスを渡してください。`,
    );
  }
  if (!isAbsolute(configPath)) {
    throw new TargetConfigError(
      "target_config_invalid",
      `${source}${configPath}が絶対パスではありません。作業ディレクトリからの相対パスでは実行先を特定できないため受け付けません。`,
    );
  }
  const normalized = resolve(configPath);
  if (basename(normalized) !== TARGET_CONFIG_FILENAME) {
    throw new TargetConfigError(
      "target_config_invalid",
      `${source}${normalized}のファイル名が${TARGET_CONFIG_FILENAME}ではありません。実行先リポジトリのルートに置いた固定名の設定だけを対象の出所にできます。`,
    );
  }
  return normalized;
}

function readConfigFile(configPath) {
  let raw;
  try {
    raw = readFileSync(configPath);
  } catch {
    throw notConfigured(`${configPath}を読み取れません。`);
  }
  if (raw.byteLength > MAX_CONFIG_BYTES) {
    throw new TargetConfigError(
      "target_config_invalid",
      `${configPath}が大きすぎます。対象グループと運用モードだけを書いてください。`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new TargetConfigError(
      "target_config_invalid",
      `${configPath}をJSONとして読めません。修正してから再試行してください。`,
    );
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new TargetConfigError(
      "target_config_invalid",
      `${configPath}の内容が不正です（${firstIssueMessage(result.error)}）。修正してから再試行してください。`,
    );
  }

  return {
    configPath,
    groupKey: result.data.target.groupKey,
    displayName: result.data.target.displayName,
    moderationMode: result.data.moderation.mode,
    // 束縛後の差し替えを検出するための内容指紋。ここから設定の中身は復元できない。
    contentHash: createHash("sha256").update(raw).digest("hex"),
  };
}

/**
 * 対象グループ設定を読み、正規化して返す。呼び出しごとに読み直すため、
 * 設定を作成・修正した直後の再試行はサーバーを再起動しなくても通る。
 *
 * configPathを明示した場合だけ、作業ディレクトリと無関係の実行先を対象にできる。
 * インストール済みプラグインは実行先とは別のディレクトリ木から起動されるため、
 * 暗黙探索だけでは実行先へ届かない。
 */
export function loadTargetConfig({ cwd = process.cwd(), env = process.env, configPath } = {}) {
  if (configPath !== undefined) return readConfigFile(normalizeExplicitPath(configPath));

  const configured = env[TARGET_CONFIG_ENV];
  // 環境変数も対象グループの出所である以上、configPathと同じ検査を通す。
  // 相対パスや別名のファイルを許すと、緩い方の入口から実行先以外を対象にできる。
  if (configured) {
    return readConfigFile(normalizeExplicitPath(configured, `環境変数${TARGET_CONFIG_ENV}の値`));
  }

  const searchStartedAt = resolve(cwd);
  const found = findConfigPath(searchStartedAt);
  if (!found) {
    throw notConfigured(
      `${searchStartedAt}から上位へ${TARGET_CONFIG_FILENAME}を探しましたが見つかりません。この作業ディレクトリがインストール済みプラグインの位置で、実行先リポジトリと別のディレクトリ木にある場合、暗黙探索では実行先へ到達できません。`,
    );
  }
  return readConfigFile(found);
}

/**
 * 対象コンテキストIDを発行・検証する。束縛内容はこのサーバープロセスのメモリにだけ置き、
 * IDそのものは中身を持たない不透明な値にする。呼び出し側はIDを読むことも作り出すこともできず、
 * モデルが任意の`groupKey`を指定できる経路は生まれない。
 *
 * 有効なのはサーバープロセスの寿命内だけである。再起動後は`get_moderation_target_config`から
 * 束縛し直す。保持するのは直近の`MAX_TARGET_CONTEXTS`件だけで、古い束縛から順に無効になる。
 */
export function createTargetContextRegistry() {
  const targetContexts = new Map();
  function invalid() {
    return new TargetConfigError(
      "target_context_invalid",
      "対象コンテキストIDが不正か、このサーバープロセスが発行したものではありません。get_moderation_target_configで対象を束縛し直してから再試行してください。",
    );
  }
  return {
    issue(config) {
      const targetContextId = randomUUID();
      // 束縛内容は凍結して渡す。利用側が書き換えても、後続の照合に使う値は変わらない。
      targetContexts.set(
        targetContextId,
        Object.freeze({
          configPath: config.configPath,
          contentHash: config.contentHash,
          groupKey: config.groupKey,
        }),
      );
      while (targetContexts.size > MAX_TARGET_CONTEXTS) {
        targetContexts.delete(targetContexts.keys().next().value);
      }
      return targetContextId;
    },
    open(targetContextId) {
      const bound =
        typeof targetContextId === "string" ? targetContexts.get(targetContextId) : undefined;
      if (!bound) throw invalid();
      return bound;
    },
  };
}

/**
 * 対象グループを許可リストとして強制する。未設定も、束縛時から内容が変わった設定も通さない。
 * 対象設定は対象コンテキストIDごとに束縛し、利用時には設定ファイルを読み直して照合する。
 */
export function createTargetGuard({ cwd = process.cwd(), env = process.env } = {}) {
  const registry = createTargetContextRegistry();
  function resolveContext(targetContextId) {
    const bound = registry.open(targetContextId);
    let current;
    try {
      current = readConfigFile(bound.configPath);
    } catch (error) {
      throw new TargetConfigError(
        "target_config_changed",
        `束縛した対象設定${bound.configPath}を読み直せません（${error.message}）。読み取りを止めます。設定ファイルの所在を管理者へ確認してください。`,
      );
    }
    if (current.contentHash !== bound.contentHash || current.groupKey !== bound.groupKey) {
      throw new TargetConfigError(
        "target_config_changed",
        `対象設定${bound.configPath}が束縛後に変わりました。読み取りを止めます。変更後の対象で続ける場合は、対象を束縛し直してから調査をやり直してください。`,
      );
    }
    return current;
  }
  return {
    /** 対象を確定し、後続の読み取りが必須入力として使う対象コンテキストIDを発行する。 */
    bind({ configPath } = {}) {
      const config = loadTargetConfig({ cwd, env, configPath });
      return { ...config, targetContextId: registry.issue(config) };
    },
    resolve: resolveContext,
    /**
     * 管理者判断の入口を運用モードで塞ぐ。autonomousで宣言された実行先では、
     * 管理者向け一覧を作らず、全案件を自律経路へまとめる。
     */
    assertRestrictedMode(targetContextId) {
      const config = resolveContext(targetContextId);
      if (config.moderationMode !== "restricted") {
        throw new TargetConfigError(
          "moderation_mode_unsupported",
          `${config.moderationMode}モードでは、管理者判断の一覧を作成できません。全案件を自律処理の一覧へまとめてください。管理者判断へ切り替える場合は、管理者が${TARGET_CONFIG_FILENAME}のmoderation.modeを変更します。`,
        );
      }
      return config;
    },
    /**
     * 自律経路の入口を運用モードで塞ぐ。restrictedで宣言された実行先では、
     * エージェントが自分で実行許可を作る経路そのものを持たせない。
     */
    assertAutonomousMode(targetContextId) {
      const config = resolveContext(targetContextId);
      if (!isAutonomousMode(config.moderationMode)) {
        throw new TargetConfigError(
          "moderation_mode_unsupported",
          `${config.moderationMode}モードでは、エージェントが自分で実行許可を作れません。管理者の承認を一覧UIで受け取ってください。自律処理へ切り替える場合は、管理者が${TARGET_CONFIG_FILENAME}のmoderation.modeを変更します。`,
        );
      }
      return config;
    },
    assertGroupKey(groupKey, targetContextId) {
      const config = resolveContext(targetContextId);
      if (groupKey !== config.groupKey) {
        throw new TargetConfigError(
          "group_not_allowed",
          `グループキー${groupKey}はこのリポジトリの対象ではありません。対象は${config.groupKey}です。対象を取り違えていないか確認し、対象自体を変える必要がある場合は管理者へ設定変更を依頼してください。`,
        );
      }
      return config;
    },
  };
}

/** コネクタ失敗と同じ形で返し、モデルがコードで判別できるようにする。 */
export function targetConfigErrorResult(error) {
  const errorCode = error instanceof TargetConfigError ? error.code : "target_config_invalid";
  const message =
    error instanceof TargetConfigError
      ? error.message
      : `対象グループ設定を確認できませんでした。${TARGET_CONFIG_FILENAME}を確認してください。`;
  return {
    isError: true,
    structuredContent: { errorCode, ...recoveryForErrorCode(errorCode) },
    content: [{ type: "text", text: `[${errorCode}] ${message}` }],
  };
}
