#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(pluginRoot, "../..");

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}が${expected}と一致しません: ${actual}`);
}

function assertContains(path, text, label) {
  if (!readFileSync(path, "utf8").includes(text)) {
    throw new Error(`${label}に${JSON.stringify(text)}がありません。`);
  }
}

export function verifyReleaseMetadata() {
  const packageJson = json(join(pluginRoot, "package.json"));
  const packageLock = json(join(pluginRoot, "package-lock.json"));
  const codexManifest = json(join(pluginRoot, ".codex-plugin", "plugin.json"));
  const claudeManifest = json(join(pluginRoot, ".claude-plugin", "plugin.json"));
  const codexMarketplace = json(join(repositoryRoot, ".agents", "plugins", "marketplace.json"));
  const claudeMarketplace = json(join(repositoryRoot, ".claude-plugin", "marketplace.json"));
  const version = packageJson.version;
  const pluginName = packageJson.name;
  const repository = "https://github.com/linalena-gw/Zawazawa-Moderation";

  assertEqual(version, "0.2.0", "公開版version");
  assertEqual(packageLock.version, version, "package-lock version");
  assertEqual(packageLock.packages?.[""]?.version, version, "package-lock root version");
  assertEqual(codexManifest.version, version, "Codex manifest version");
  assertEqual(claudeManifest.version, version, "Claude manifest version");
  assertEqual(codexManifest.name, pluginName, "Codex plugin name");
  assertEqual(claudeManifest.name, pluginName, "Claude plugin name");
  assertEqual(packageJson.repository, repository, "package repository");
  assertEqual(codexManifest.repository, repository, "Codex repository");
  assertEqual(claudeManifest.repository, repository, "Claude repository");

  assertContains(
    join(pluginRoot, "server", "server.mjs"),
    `name: "${pluginName}", version: "${version}"`,
    "MCP server identity",
  );
  assertContains(
    join(pluginRoot, "ui", "review.html"),
    `name: "${pluginName}", version: "${version}"`,
    "MCP App identity",
  );

  for (const [label, marketplace] of [
    ["Codex marketplace", codexMarketplace],
    ["Claude marketplace", claudeMarketplace],
  ]) {
    assertEqual(marketplace.name, "zawazawa-moderation", `${label} name`);
    assertEqual(marketplace.plugins?.length, 1, `${label} plugin count`);
    assertEqual(marketplace.plugins[0].name, pluginName, `${label} plugin name`);
  }
  assertEqual(claudeMarketplace.plugins[0].version, version, "Claude marketplace plugin version");

  for (const relativePath of [
    "zawazawa.config.json",
    "運用基準.md",
    "根拠資料.md",
    "判断事例.md",
  ]) {
    if (existsSync(join(repositoryRoot, relativePath))) {
      throw new Error(`公開ルートへ含めない項目が存在します: ${relativePath}`);
    }
  }
  for (const relativePath of ["moderation-reports", ".codex", ".vscode"]) {
    const path = join(repositoryRoot, relativePath);
    const containsMaterial =
      existsSync(path) &&
      readdirSync(path, { recursive: true, withFileTypes: true }).some((entry) => !entry.isDirectory());
    if (containsMaterial) {
      throw new Error(`公開ルートへ含めない項目が存在します: ${relativePath}`);
    }
  }
  return { pluginName, version, marketplace: "zawazawa-moderation" };
}

const invokedAsScript = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  const result = verifyReleaseMetadata();
  process.stdout.write(
    `release metadata verified: ${result.pluginName}@${result.version} (${result.marketplace})\n`,
  );
}
