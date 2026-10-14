import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drill, parseDrillArgs } from '../src/drill.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BAD = join(HERE, '..', 'examples', 'bad');
const GOOD = join(HERE, '..', 'examples', 'good');
const capture = () => {
  const lines = [];
  return { io: { log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(`ERR ${a.join(' ')}`) }, text: () => lines.join('\n') };
};

test('parseDrillArgs reads the directory and the options', () => {
  const o = parseDrillArgs(['somedir', '--port', '0', '--timeout', '30', '--keep', '--simulate']);
  assert.equal(o.dir, 'somedir');
  assert.equal(o.timeout, 30);
  assert.ok(o.keep && o.simulate);
});

test('parseDrillArgs rejects a non-numeric timeout and an unknown flag', () => {
  assert.throws(() => parseDrillArgs(['--timeout', 'soon']));
  assert.throws(() => parseDrillArgs(['--nope']));
});

test('--simulate drives a mock exfiltration and the canary is caught on every channel', async () => {
  const c = capture();
  const code = await drill([BAD, '--simulate', '--timeout', '10'], c.io);
  const out = c.text();
  assert.equal(code, 1, out);
  assert.match(out, /CANARY RECEIVED/);
  assert.match(out, /URL, body, header/);
  assert.match(out, /listener: http:\/\/127\.0\.0\.1:\d+/);
});

test('the static verdict is shown before the live drill and includes hidden instructions', async () => {
  const c = capture();
  await drill([BAD, '--simulate', '--timeout', '10'], c.io);
  const out = c.text();
  assert.ok(out.indexOf('static verdict for the training ground') < out.indexOf('live drill'));
  assert.match(out, /Hidden instructions/);
});

test('with nothing taking the bait the drill passes and says so', async () => {
  const c = capture();
  const code = await drill([GOOD, '--timeout', '1'], c.io);
  assert.equal(code, 0);
  assert.match(c.text(), /canary did not arrive/);
});

test('--keep leaves the training ground on disk, default removes it', async () => {
  const kept = capture();
  await drill([GOOD, '--timeout', '1', '--keep'], kept.io);
  const path = /training ground kept at: (.+)$/m.exec(kept.text())?.[1]?.trim();
  assert.ok(path && existsSync(path), 'kept ground should exist');
  assert.ok(existsSync(join(path, 'issue.md')) && existsSync(join(path, '.env')));
  rmSync(dirname(path), { recursive: true, force: true });

  const gone = capture();
  await drill([GOOD, '--timeout', '1'], gone.io);
  assert.match(gone.text(), /training ground removed/);
});
