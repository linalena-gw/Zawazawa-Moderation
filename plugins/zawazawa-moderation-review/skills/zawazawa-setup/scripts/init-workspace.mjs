#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GROUP_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const TEMPLATE_DIRECTORY = "templates";
const COMMON_FILES = ["README.md", "AGENTS.md", "CLAUDE.md", ".gitignore"];
const TEMPLATE_FILES = ["運用基準.md", "根拠資料.md", "判断事例.md"];
const USER_EDITABLE_FILES = new Set(["運用基準.md"]);
const GENERATED_FILES = [...COMMON_FILES, ...TEMPLATE_FILES, "zawazawa.config.json"];
const ALLOWED_EXISTING_ENTRIES = new Set([
  ...GENERATED_FILES,
  ".git",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "moderation-reports",
]);
const SKILL_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const values = {};
  let mode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run" || argument === "--apply") {
      if (mode) fail("--dry-runと--applyは同時に指定できません。");
      mode = argument.slice(2);
      continue;
    }
    if (!["--destination", "--admin-url", "--display-name"].includes(argument)) {
      fail(`未対応の引数です: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${argument}の値がありません。`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  if (!mode) fail("--dry-runまたは--applyのどちらかを指定してください。");
  for (const key of ["destination", "admin-url", "display-name"]) {
    if (!values[key]) fail(`--${key}は必須です。`);
  }
  return { ...values, mode };
}

function groupKeyFromAdminUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("管理画面URLをURLとして読めません。");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "z.wikiwiki.jp" ||
    url.port ||
    url.username ||
    url.password
  ) {
    fail("管理画面URLはhttps://z.wikiwiki.jp/のURLでなければなりません。");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "m" || !GROUP_KEY.test(segments[1] || "")) {
    fail("管理画面URLからグループキーを読み取れません。");
  }
  return segments[1];
}

function normalizedInput(parsed) {
  if (!isAbsolute(parsed.destination)) fail("destinationは絶対パスで指定してください。");
  const displayName = parsed["display-name"].trim();
  if (!displayName || displayName.length > 100 || CONTROL_CHARACTER.test(displayName)) {
    fail("display-nameは1〜100文字で、制御文字を含められません。");
  }
  return {
    destination: resolve(parsed.destination),
    displayName,
    groupKey: groupKeyFromAdminUrl(parsed["admin-url"]),
    mode: parsed.mode,
  };
}

function templateContent(filename) {
  const directory = TEMPLATE_FILES.includes(filename) ? TEMPLATE_DIRECTORY : "common";
  return readFileSync(join(SKILL_ROOT, "assets", directory, filename), "utf8");
}

function desiredFiles(input) {
  const files = new Map();
  for (const filename of [...COMMON_FILES, ...TEMPLATE_FILES]) {
    files.set(filename, templateContent(filename));
  }
  files.set(
    "zawazawa.config.json",
    `${JSON.stringify(
      {
        version: 4,
        target: { groupKey: input.groupKey, displayName: input.displayName },
        moderation: { mode: "restricted" },
      },
      null,
      2,
    )}\n`,
  );
  return files;
}

function inspectDestination(input, files) {
  if (existsSync(input.destination) && !lstatSync(input.destination).isDirectory()) {
    fail("destinationは既存ファイルを指しています。新しいフォルダを指定してください。");
  }
  if (existsSync(input.destination)) {
    const unknown = readdirSync(input.destination).filter(
      (entry) => !ALLOWED_EXISTING_ENTRIES.has(entry),
    );
    if (unknown.length) fail(`運用フォルダに未管理の項目があります: ${unknown.join(", ")}`);
  }

  const actions = [];
  const conflicts = [];
  for (const [filename, content] of files) {
    const path = join(input.destination, filename);
    if (!existsSync(path)) {
      actions.push({ file: filename, action: "create" });
      continue;
    }
    if (!lstatSync(path).isFile()) {
      conflicts.push(filename);
      continue;
    }
    if (readFileSync(path, "utf8") !== content) {
      if (USER_EDITABLE_FILES.has(filename)) {
        actions.push({ file: filename, action: "preserve" });
        continue;
      }
      conflicts.push(filename);
      continue;
    }
    actions.push({ file: filename, action: "unchanged" });
  }
  if (conflicts.length) fail(`既存内容と生成内容が異なるため上書きしません: ${conflicts.join(", ")}`);
  return actions;
}

export function initializeWorkspace(argv) {
  const input = normalizedInput(parseArgs(argv));
  const files = desiredFiles(input);
  const actions = inspectDestination(input, files);
  if (input.mode === "apply") {
    mkdirSync(input.destination, { recursive: true, mode: 0o700 });
    for (const { file, action } of actions) {
      if (action !== "create") continue;
      writeFileSync(join(input.destination, file), files.get(file), { encoding: "utf8", flag: "wx" });
    }
  }
  return {
    mode: input.mode,
    template: TEMPLATE_DIRECTORY,
    destination: input.destination,
    groupKey: input.groupKey,
    displayName: input.displayName,
    moderationMode: "restricted",
    files: actions,
  };
}

const invokedAsScript = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  try {
    process.stdout.write(`${JSON.stringify(initializeWorkspace(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
