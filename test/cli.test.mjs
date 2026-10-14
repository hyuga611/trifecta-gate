import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'src', 'check.mjs');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('the bad example fails and names the issue-triage subagent', () => {
  const r = run(join(HERE, '..', 'examples', 'bad'));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /FAIL {2}issue-triage/);
  assert.match(r.stdout, /private data \d+ open · untrusted content 1 open · external send 1 open/);
});

test('the bad example also fails for Cursor, through the mcpAllowlist', () => {
  const r = run(join(HERE, '..', 'examples', 'bad'));
  assert.match(r.stdout, /^Cursor —/m);
  assert.match(r.stdout, /FAIL {2}cursor \(IDE\)/);
  assert.match(r.stdout, /MCP allowlist entry github:\*/);
});

test('--cursor-mode rejects a mode Cursor does not have', () => {
  const r = run('--cursor-mode', 'yolo');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--cursor-mode must be/);
});

test('the good example passes at --fail-on open and fails at --fail-on model', () => {
  assert.equal(run(join(HERE, '..', 'examples', 'good')).status, 0);
  assert.equal(run(join(HERE, '..', 'examples', 'good'), '--fail-on', 'model').status, 1);
});

test('an unknown flag is a usage error, not a silent pass', () => {
  const r = run('--zzz');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option --zzz/);
});

test('--json prints a parseable result', () => {
  const r = run(join(HERE, '..', 'examples', 'bad'), '--json');
  const j = JSON.parse(r.stdout);
  assert.equal(j.failed, true);
  assert.deepEqual(j.platforms.map((p) => p.platform), ['Claude Code', 'Cursor']);
  assert.equal(j.platforms[0].agents[0].name, 'main');
  assert.ok(j.platforms[0].agents[0].counts.open > 0);
});
