#!/usr/bin/env node
import { isMainModule } from "../server/script-entry.mjs";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  const codexMarketplace = json(join(repositoryRoot, ".agents", "plugins", "marketplace.json"));
  const mcpManifest = json(join(pluginRoot, "mcp.runtime.json"));
  const version = packageJson.version;
  const pluginName = packageJson.name;
  const repository = "https://github.com/linalena-gw/Zawazawa-Moderation";

  assertEqual(version, "0.6.0", "公開版version");
  assertEqual(packageLock.version, version, "package-lock version");
  assertEqual(packageLock.packages?.[""]?.version, version, "package-lock root version");
  assertEqual(codexManifest.version, version, "Codex manifest version");
  assertEqual(codexManifest.name, pluginName, "Codex plugin name");
  assertEqual(codexManifest.mcpServers, undefined, "MCP登録はsetupが専用Nodeの絶対パスで行う");
  if (existsSync(join(pluginRoot, ".mcp.json"))) throw new Error("Codexが自動検出する.mcp.jsonを配布へ含めないでください。");
  assertEqual(mcpManifest.mcpServers?.[pluginName]?.args?.[0], "./scripts/runtime-launcher.mjs", "開発・診断用runtime launcher");
  assertEqual(packageJson.repository, repository, "package repository");
  assertEqual(codexManifest.repository, repository, "Codex repository");

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
  ]) {
    assertEqual(marketplace.name, "zawazawa-moderation", `${label} name`);
    assertEqual(marketplace.plugins?.length, 1, `${label} plugin count`);
    assertEqual(marketplace.plugins[0].name, pluginName, `${label} plugin name`);
  }

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

const invokedAsScript = await isMainModule(import.meta.url);
if (invokedAsScript) {
  const result = verifyReleaseMetadata();
  process.stdout.write(
    `release metadata verified: ${result.pluginName}@${result.version} (${result.marketplace})\n`,
  );
}
