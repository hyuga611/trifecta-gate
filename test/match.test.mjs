import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandRegex, domainMatches, droppedInAutoMode, parseRule, pathRuleRegex, toPosix } from '../src/match.mjs';

const ctx = { cwd: '/c/repo', home: '/c/Users/a', caseInsensitive: true };

test('Windows paths are compared in POSIX form', () => {
  assert.equal(toPosix('C:\\Users\\a\\.env'), '/c/Users/a/.env');
});

test('path rules: the four anchors from the Claude Code docs', () => {
  assert.ok(pathRuleRegex('//c/Users/a/.ssh/**', 'deny', 'project', ctx).test('/c/Users/a/.ssh/id_ed25519'));
  assert.ok(pathRuleRegex('~/.aws/**', 'deny', 'project', ctx).test('/c/Users/a/.aws/credentials'));
  // A single leading slash anchors at the settings source, which is ~/.claude for user settings.
  assert.ok(pathRuleRegex('/secrets/**', 'deny', 'user', ctx).test('/c/Users/a/.claude/secrets/k'));
  assert.ok(!pathRuleRegex('/secrets/**', 'deny', 'user', ctx).test('/c/repo/secrets/k'));
  // A bare file name matches at any depth under the current directory.
  assert.ok(pathRuleRegex('.env', 'deny', 'project', ctx).test('/c/repo/app/.env'));
});

test('one-segment directory patterns reach nested copies only in deny and ask rules', () => {
  assert.ok(pathRuleRegex('src/**', 'deny', 'project', ctx).test('/c/repo/vendor/pkg/src/lib.js'));
  assert.ok(!pathRuleRegex('src/**', 'allow', 'project', ctx).test('/c/repo/vendor/pkg/src/lib.js'));
});

test('Bash rules: a trailing " *" also matches the bare command, and the space counts', () => {
  assert.ok(commandRegex('ls *').test('ls'));
  assert.ok(commandRegex('ls *').test('ls -la'));
  assert.ok(!commandRegex('ls *').test('lsof'));
  assert.ok(commandRegex('ls*').test('lsof'));
  assert.ok(commandRegex('ls:*').test('ls -la'));
  assert.ok(!commandRegex('* --help *').test('npm --help'));
});

test('WebFetch domains: a middle wildcard does not cross a dot', () => {
  assert.ok(domainMatches('example.*', 'example.org'));
  assert.ok(!domainMatches('example.*', 'example.evil.com'));
  assert.ok(domainMatches('*.example.com', 'a.b.example.com'));
  assert.ok(!domainMatches('*.example.com', 'example.com'));
});

test('auto mode drops allow rules that grant arbitrary code execution', () => {
  for (const r of ['Bash', 'Bash(*)', 'Bash(python*)', 'Bash(npm run *)', 'Agent']) assert.ok(droppedInAutoMode(parseRule(r)), r);
  for (const r of ['Bash(npm test)', 'Bash(git status)', 'WebFetch']) assert.ok(!droppedInAutoMode(parseRule(r)), r);
});
