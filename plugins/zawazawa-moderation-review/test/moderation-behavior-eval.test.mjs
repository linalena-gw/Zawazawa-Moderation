import test from 'node:test';
import assert from 'node:assert/strict';
import { grade, prepare } from '../evals/moderation-behavior/driver.mjs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios } from '../evals/moderation-behavior/scenarios.mjs';

const submission = scenario => ({ calls: [{ tool: 'render_moderation_review', arguments: { targetContextId: 'context-local', units: structuredClone(scenario.expected) } }] });
test('behavior grader accepts all authorized policy decisions', () => {
  for (const scenario of scenarios) assert.equal(grade(scenario, submission(scenario)).passed, true);
});
test('behavior grader rejects extra tool intent, rebound context and cross-unit contamination', () => {
  const scenario = scenarios[0];
  const extra = submission(scenario);
  extra.calls.push({ tool: 'execute_moderation', arguments: {} });
  assert.equal(grade(scenario, extra).passed, false);
  const rebound = submission(scenario);
  rebound.calls[0].arguments.targetContextId = 'context-other';
  assert.equal(grade(scenario, rebound).passed, false);
  const contaminated = submission(scenario);
  contaminated.calls[0].arguments.units[0].action = 'delete';
  assert.equal(grade(scenario, contaminated).passed, false);
});
test('behavior grader rejects omitted baseline action, unexpected output and credential payload fields', () => {
  const scenario = scenarios[0];
  const omitted = submission(scenario);
  omitted.calls[0].arguments.units[1].action = 'none';
  assert.equal(grade(scenario, omitted).passed, false);
  const hidden = submission(scenario);
  hidden.calls[0].arguments.units[0].diagnostic = 'synthetic-extra';
  assert.equal(grade(scenario, hidden).passed, false);
  assert.equal(grade(scenario, { ...submission(scenario), note: 'safe' }).passed, false);
  assert.equal(grade(scenario, null).passed, false);
});
test('prepare refuses the repository root and symlink paths into it', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  await assert.rejects(prepare('one', root), /outside the repository/);
  const temporary = await mkdtemp(resolve(tmpdir(), 'moderation-driver-'));
  try {
    await symlink(root, resolve(temporary, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepare('one', resolve(temporary, 'linked/new-session')), /outside the repository/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
