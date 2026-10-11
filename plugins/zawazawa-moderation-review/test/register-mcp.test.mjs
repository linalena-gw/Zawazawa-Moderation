import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { registerMcp, updateRegistration } from "../scripts/register-mcp.mjs";

const options = { nodePath: process.execPath, root: join(tmpdir(), "fixture-runtime"), browsers: join(tmpdir(), "fixture-browsers") };
test("managed MCP registration preserves unrelated settings and can update or remove only its block", () => {
  const original = '# user comment\nmodel = "fixture-model"\n[mcp_servers.other]\ncommand = "fixture-command"\n';
  const first = updateRegistration(original, options);
  assert.equal(first.status, "registered");
  assert.ok(first.text.startsWith(original));
  const config = parse(first.text);
  assert.equal(config.mcp_servers.zawazawa_moderation_review.command, options.nodePath);
  assert.deepEqual(config.mcp_servers.zawazawa_moderation_review.args, [join(options.root, "server", "server.mjs")]);
  assert.equal(config.mcp_servers.zawazawa_moderation_review.env.PLAYWRIGHT_BROWSERS_PATH, options.browsers);
  assert.equal(updateRegistration(first.text, options).status, "unchanged");
  const changed = updateRegistration(first.text, { ...options, root: join(tmpdir(), "fixture-runtime-updated") });
  assert.equal(changed.status, "registered");
  assert.equal(updateRegistration(changed.text, { ...options, remove: true }).text, original);
});
test("manual conflicts, edited managed blocks, and invalid TOML are never overwritten", () => {
  for (const name of ["zawazawa_moderation_review", "zawazawa-moderation-review"]) {
    assert.throws(() => updateRegistration(`[mcp_servers.${name}]\ncommand="manual"\n`, options), { code: "MCP_REGISTRATION_CONFLICT" });
  }
  const generated = updateRegistration("", options).text;
  assert.throws(() => updateRegistration(generated.replace("tool_timeout_sec = 300", "tool_timeout_sec = 60"), options), { code: "MANAGED_REGISTRATION_EDITED" });
  assert.throws(() => updateRegistration("model = [", options), { code: "CODEX_CONFIG_INVALID" });
});
test("file registration is idempotent and leaves conflicting user bytes untouched", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zawazawa-registration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.toml");
  const original = '# preserved comment\nmodel = "fixture"\n';
  await writeFile(configPath, original);
  const staleLock = `${configPath}.zawazawa-registration.lock`;
  await writeFile(staleLock, "");
  const past = new Date(Date.now() - 60_000);
  await utimes(staleLock, past, past);
  assert.deepEqual(await registerMcp({ configPath, ...options }), { status: "registered" });
  assert.deepEqual(await registerMcp({ configPath, ...options }), { status: "unchanged" });
  assert.deepEqual(await registerMcp({ configPath, ...options, remove: true }), { status: "removed" });
  assert.equal(await readFile(configPath, "utf8"), original);
  const manual = '[mcp_servers.zawazawa_moderation_review]\ncommand="manual"\n';
  await writeFile(configPath, manual);
  await assert.rejects(registerMcp({ configPath, ...options }), { code: "MCP_REGISTRATION_CONFLICT" });
  assert.equal(await readFile(configPath, "utf8"), manual);
});
