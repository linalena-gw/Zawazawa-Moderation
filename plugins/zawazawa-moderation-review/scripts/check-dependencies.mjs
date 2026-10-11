#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const reportPrefix = "ZAWAZAWA_DEPENDENCY_CHECK:";
const imports = [
  ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/server/mcp.js"],
  ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/server/stdio.js"],
  ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/client/index.js"],
  ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/client/stdio.js"],
  ["@modelcontextprotocol/ext-apps", "@modelcontextprotocol/ext-apps/server"],
  ["zod", "zod/v3"],
  ["cheerio", "cheerio"],
  ["playwright-core", "playwright-core"],
];
const readable = [["@modelcontextprotocol/ext-apps", "@modelcontextprotocol/ext-apps/app-with-deps"]];

function probeSource() {
  return `
import { access, constants } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const imports = ${JSON.stringify(imports)};
const readable = ${JSON.stringify(readable)};
const issues = [];
const codeOf = (error) => /^[A-Z][A-Z0-9_]*$/.test(error?.code ?? "") ? error.code : "DEPENDENCY_CHECK_FAILED";
const record = (packageName, specifier, error) => {
  const errorCode = codeOf(error);
  issues.push({ packageName, specifier,
    category: ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(errorCode) ? "dependency_missing" : "dependency_import_failed",
    errorCode });
};
await Promise.all(imports.map(async ([packageName, specifier]) => {
  try { await import(specifier); } catch (error) { record(packageName, specifier, error); }
}));
const requireFromRuntime = createRequire(pathToFileURL(resolve("server/mcp-app-runtime.mjs")));
await Promise.all(readable.map(async ([packageName, specifier]) => {
  try { await access(requireFromRuntime.resolve(specifier), constants.R_OK); }
  catch (error) { record(packageName, specifier, error); }
}));
issues.sort((a, b) => (a.packageName + "/" + a.specifier).localeCompare(b.packageName + "/" + b.specifier));
const category = issues.length === 0 ? "dependencies_available"
  : issues.every((issue) => issue.category === "dependency_missing") ? "dependencies_missing" : "dependency_import_failed";
process.stdout.write(${JSON.stringify(reportPrefix)} + JSON.stringify({ ok: issues.length === 0, category, issues }) + "\\n");
`;
}

function runnerFailure(error) {
  const errorCode = /^[A-Z][A-Z0-9_]*$/.test(error?.code ?? "") ? error.code : "DEPENDENCY_CHECK_FAILED";
  return { ok: false, category: "dependency_check_failed", issues: [{
    packageName: "node", specifier: "runtime dependency check", category: "dependency_import_failed", errorCode,
  }] };
}

/** Check runtime entrypoints using this Node runtime and the supplied installed plugin root. */
export async function checkDependencies(pluginRoot) {
  if (typeof pluginRoot !== "string" || pluginRoot.length === 0) {
    return { ok: false, category: "plugin_root_invalid", issues: [] };
  }
  try {
    const { stdout } = await execFile(process.execPath, ["--input-type=module", "--eval", probeSource()], {
      cwd: resolve(pluginRoot), encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    const line = stdout.split(/\r?\n/u).findLast((entry) => entry.startsWith(reportPrefix));
    if (!line) return runnerFailure(null);
    const result = JSON.parse(line.slice(reportPrefix.length));
    if (typeof result?.ok !== "boolean" || typeof result?.category !== "string" || !Array.isArray(result?.issues)) {
      return runnerFailure(null);
    }
    return result;
  } catch (error) {
    return runnerFailure(error);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await checkDependencies(pluginRoot);
  if (result.ok) {
    process.stdout.write(`Runtime dependencies available (category: ${result.category}).\n`);
  } else {
    process.stderr.write(`Runtime dependency check failed (category: ${result.category}).\n`);
    for (const { specifier, errorCode } of result.issues) process.stderr.write(`  ${specifier}: ${errorCode}\n`);
    process.exitCode = 1;
  }
}
