import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  classifyDiagnosticFailure,
  createSafeReport,
  KNOWN_TOOL_NAMES,
  knownMissingPackage,
  parseMcpManifest,
  validateDefaultStoragePaths,
} from "../scripts/diagnose-mcp.mjs";

const execFile = promisify(execFileCallback);
const diagnosticScript = fileURLToPath(new URL("../scripts/diagnose-mcp.mjs", import.meta.url));

test("diagnostic connects through the packaged manifest and lists the server tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zawazawa-mcp-diagnostic-test-"));
  const env = {
    ...process.env,
    ZAWAZAWA_REVIEW_STORE_DIR: join(directory, "caller-store"),
    ZAWAZAWA_CONNECTOR_PROFILE_DIR: join(directory, "caller-profile"),
  };
  delete env.ZAWAZAWA_TARGET_CONFIG;

  try {
    const { stdout, stderr } = await execFile(process.execPath, [diagnosticScript], {
      cwd: directory,
      env,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    const report = JSON.parse(stdout);

    assert.equal(stderr, "");
    assert.equal(report.result, "success");
    assert.equal(report.phase, "tools");
    assert.equal(report.runtime.nodeSupported, true);
    assert.equal(report.runtime.pluginVersion, "0.2.1");
    assert.equal(report.scope, "isolated_startup");
    assert.equal(report.invocation, "direct_process");
    assert.equal(report.check, "packaged_manifest_stdio");
    assert.equal(report.realStorageWriteCheck, "not_performed");
    assert.equal(report.directStartupOk, true);
    assert.equal(report.hostRegistrationChecked, false);
    assert.ok(report.toolCount >= 15);
    assert.equal(report.knownToolsPresent.get_moderation_target_config, true);
    assert.equal(report.knownToolsPresent.get_zawazawa_open_reports, true);
    assert.equal(report.knownToolsPresent.render_moderation_review, true);
    assert.equal(report.knownToolsPresent.get_moderation_review_snapshot, false);
    assert.equal(report.errorCategory, null);
    assert.deepEqual(report.dependencyIssues, []);
    assert.equal(JSON.stringify(report).includes(directory), false);
    assert.equal(JSON.stringify(report).includes("caller-store"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows default-path validation reports a missing LOCALAPPDATA without exposing details", () => {
  assert.deepEqual(
    validateDefaultStoragePaths({ platform: "win32", env: {} }),
    { ok: false, errorCategory: "platform_storage_invalid", failureDetail: "env_missing" },
  );
  const report = createSafeReport({
    phase: "environment",
    errorCategory: "env_missing",
    env: { LOCALAPPDATA: "private-value" },
    platform: "win32",
  });
  assert.equal(report.environment.localAppDataPresent, true);
  assert.equal(JSON.stringify(report).includes("private-value"), false);
});

test("manifest parsing and failure classification return stable categories only", () => {
  assert.throws(() => parseMcpManifest("{"), {
    code: "MCP_MANIFEST_INVALID",
    message: "Invalid MCP manifest",
  });
  assert.equal(
    classifyDiagnosticFailure({ error: Object.assign(new Error("missing"), { code: "ENOENT" }), phase: "spawn" }),
    "node_unavailable",
  );
  assert.equal(
    classifyDiagnosticFailure({
      error: Object.assign(new Error("Cannot find package"), { code: "MODULE_NOT_FOUND" }),
      stderr: "",
      phase: "initialize",
    }),
    "dependencies_missing",
  );
  assert.equal(
    classifyDiagnosticFailure({ error: Object.assign(new Error("expired"), { code: "DIAGNOSTIC_TIMEOUT" }) }),
    "timeout",
  );
  assert.equal(KNOWN_TOOL_NAMES.length, 4);
});

test("safe report includes only runtime, phases, known tool presence, and environment booleans", () => {
  const report = createSafeReport({
    phase: "tools",
    toolNames: ["get_moderation_target_config"],
    env: {
      LOCALAPPDATA: "private-value",
      ZAWAZAWA_REVIEW_STORE_DIR: "private-value",
      ZAWAZAWA_CONNECTOR_PROFILE_DIR: "private-value",
      ZAWAZAWA_TARGET_CONFIG: "private-value",
    },
    platform: "win32",
    nodeVersion: "v24.1.0",
  });

  assert.equal(report.runtime.runtimeSupported, true);
  assert.equal(report.hostRegistrationChecked, false);
  assert.equal(report.toolCount, 1);
  assert.equal(report.knownToolsPresent.get_moderation_target_config, true);
  assert.equal(report.knownToolsPresent.get_moderation_review_snapshot, false);
  assert.deepEqual(report.environment, {
    localAppDataPresent: true,
    reviewStoreOverridePresent: true,
    connectorProfileOverridePresent: true,
    targetConfigPresent: true,
  });
  assert.equal(JSON.stringify(report).includes("private-value"), false);
  assert.deepEqual(Object.keys(report).sort(), [
    "check",
    "cleanupCategory",
    "dependencyIssues",
    "directStartupOk",
    "elapsedMs",
    "environment",
    "errorCategory",
    "failureDetail",
    "hostRegistrationChecked",
    "invocation",
    "isInstalledCache",
    "knownToolsPresent",
    "phase",
    "realStorageWriteCheck",
    "result",
    "runtime",
    "scope",
    "toolCount",
  ]);
});

test("diagnostic detects an SDK manifest with missing entry files without leaking paths", async () => {
  const pluginRoot = resolve(dirname(diagnosticScript), "..");
  const fixture = await mkdtemp(join(tmpdir(), "zawazawa-sdk-fixture-"));
  try {
    await mkdir(join(fixture, "scripts"));
    await mkdir(join(fixture, "server"));
    await Promise.all([
      copyFile(diagnosticScript, join(fixture, "scripts", "diagnose-mcp.mjs")),
      copyFile(join(pluginRoot, "server", "platform-paths.mjs"), join(fixture, "server", "platform-paths.mjs")),
      copyFile(join(pluginRoot, ".mcp.json"), join(fixture, ".mcp.json")),
      copyFile(join(pluginRoot, "package.json"), join(fixture, "package.json")),
      copyFile(join(pluginRoot, "package-lock.json"), join(fixture, "package-lock.json")),
    ]);
    {
      const sdkPath = join(fixture, "node_modules", "@modelcontextprotocol", "sdk");
      await mkdir(sdkPath, { recursive: true });
      await copyFile(join(pluginRoot, "node_modules", "@modelcontextprotocol", "sdk", "package.json"), join(sdkPath, "package.json"));
    }
    let stdout;
    try {
      await execFile(process.execPath, [join(fixture, "scripts", "diagnose-mcp.mjs")], {
        env: { ...process.env, ZAWAZAWA_REVIEW_STORE_DIR: join(fixture, "unused-store"), ZAWAZAWA_CONNECTOR_PROFILE_DIR: join(fixture, "unused-profile") },
        timeout: 15_000,
      });
      assert.fail("Missing SDK files must fail the diagnostic");
    } catch (error) {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, "");
      stdout = error.stdout;
    }
    const report = JSON.parse(stdout);
    assert.equal(report.phase, "dependencies");
    assert.equal(report.errorCategory, "dependencies_missing");
    assert.equal(report.dependencyIssues.length, 2);
    for (const issue of report.dependencyIssues) {
      assert.equal(issue.errorCode, "ERR_MODULE_NOT_FOUND");
      assert.equal(issue.missingPackage, "@modelcontextprotocol/sdk");
      assert.equal(issue.packageManifestPresent, true);
      assert.equal(issue.entrypointResolved, true);
      assert.equal(issue.entrypointExists, false);
    }
    assert.equal(stdout.includes(fixture), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("missing-package details only return names present in public lock metadata", () => {
  const names = ["@modelcontextprotocol/sdk", "zod"];
  assert.equal(knownMissingPackage(new Error("Cannot find package 'zod' imported from a private location"), names), "zod");
  assert.equal(knownMissingPackage(new Error("Cannot find module 'C:\\private-fixture\\node_modules\\zod\\missing.js'"), names), "zod");
  assert.equal(knownMissingPackage(new Error("Cannot find package 'private-fixture'"), names), null);
  assert.equal(knownMissingPackage(new Error("Cannot find module 'C:\\private-fixture\\missing.js'"), names), null);
});
