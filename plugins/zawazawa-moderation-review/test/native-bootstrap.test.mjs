import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const scriptRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const shell = join(scriptRoot, 'bootstrap.sh');
const release = JSON.parse(await readFile(join(scriptRoot, 'node-release.json'), 'utf8'));
test('native bootstrap pins every supported official Node archive', () => {
  assert.equal(release.version, '24.21.0');
  for (const platform of ['darwin-arm64', 'darwin-x64', 'win-arm64', 'win-x64']) assert.match(release[platform], /^[a-f0-9]{64}$/);
});
test('macOS read-only entry never creates an unprepared home or uses PATH Node', { skip: process.platform !== 'darwin' }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'zawazawa-native-test-'));
  try {
    const base = join(temporary, 'unprepared');
    const result = spawnSync('/bin/sh', [shell, '--print-root'], { env: { ...process.env, ZAWAZAWA_HOME_DIR: base, PATH: '/nonexistent' }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Dedicated Node is not prepared/);
    await assert.rejects(access(base), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
test('macOS rejects relative homes and unsupported operations before preparation', { skip: process.platform !== 'darwin' }, () => {
  for (const [args, base] of [[['--prepare'], 'relative'], [['--run-script', 'arbitrary'], '/tmp/example'], [['--run-script', 'register', 'extra'], '/tmp/example'], [['--run-script', 'diagnose', 'extra'], '/tmp/example']]) {
    const result = spawnSync('/bin/sh', [shell, ...args], { env: { ...process.env, ZAWAZAWA_HOME_DIR: base }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});
test('macOS print-node uses only the dedicated verified-version binary', { skip: process.platform !== 'darwin' }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'zawazawa-native-test-'));
  try {
    const arm = process.arch === 'arm64' || spawnSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).stdout.trim() === '1';
    const target = join(temporary, 'node', `v${release.version}-darwin-${arm ? 'arm64' : 'x64'}`);
    await mkdir(join(target, 'bin'), { recursive: true });
    await mkdir(join(target, 'lib/node_modules/npm/bin'), { recursive: true });
    await writeFile(join(target, 'bin/node'), '#!/bin/sh\nprintf "v24.21.0\\n"\n', { mode: 0o700 });
    await writeFile(join(target, 'lib/node_modules/npm/bin/npm-cli.js'), '');
    const result = spawnSync('/bin/sh', [shell, '--print-node'], { env: { ...process.env, ZAWAZAWA_HOME_DIR: temporary, PATH: '/nonexistent' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), await realpath(join(target, 'bin/node')));
    const bad = spawnSync('/bin/sh', [shell, '--print-node', 'extra'], { env: { ...process.env, ZAWAZAWA_HOME_DIR: temporary }, encoding: 'utf8' });
    assert.equal(bad.status, 1);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
