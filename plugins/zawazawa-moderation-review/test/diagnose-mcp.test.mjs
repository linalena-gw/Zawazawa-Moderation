import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  classifyDiagnosticFailure,
  createSafeReport,
  KNOWN_TOOL_NAMES,
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
