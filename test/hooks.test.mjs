import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatReport } from '../src/check.mjs';
import { loadCursor, scanCursor } from '../src/cursor.mjs';
import { hookName, loadConfig } from '../src/load.mjs';
import { matcherMatches } from '../src/match.mjs';
import { scan } from '../src/scan.mjs';
import { step, unit, withFiles } from './helpers.mjs';

const claude = (files, opts = {}) =>
  withFiles(files, ({ base, root, home }) => scan(loadConfig({ root, home, managedFile: join(base, 'none.json'), ...opts })));

const preToolUse = (...groups) => ({ hooks: { PreToolUse: groups } });
const hook = (command, extra = {}) => ({ type: 'command', command, ...extra });
const item = (r, leg, id) => unit(r, 'main').legs[leg].find((i) => i.id === id);

test('matchers follow the documented forms: all, exact lists, and regular expressions', () => {
  for (const m of [undefined, '', '*']) assert.ok(matcherMatches(m, 'Bash'));
  assert.ok(matcherMatches('Write|Edit', 'Edit'));
  assert.ok(matcherMatches('Edit, Write', 'Write'));
  assert.ok(!matcherMatches('Edit', 'NotebookEdit'));
  assert.ok(!matcherMatches('mcp__memory', 'mcp__memory__read'), 'letters only: an exact name');
  assert.ok(matcherMatches('mcp__memory__.*', 'mcp__memory__read'));
  assert.ok(matcherMatches('Edit.*', 'NotebookEdit'), 'a regular expression is unanchored');
  assert.ok(!matcherMatches('^Edit$', 'NotebookEdit'));
});

test('a hook is named by the script it runs, or by the host it posts to', () => {
  assert.equal(hookName(hook('node "C:/x/redline/src/redline.mjs" hook pre')), 'redline');
  assert.equal(hookName(hook('powershell.exe -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/hooks/read-guard-hook.ps1"')), 'read-guard-hook');
  assert.equal(hookName(hook('node', { args: ['.claude/hooks/check-command.js'] })), 'check-command');
  assert.equal(hookName({ type: 'http', url: 'https://hooks.example.com/pre' }), 'hooks.example.com');
});

test('each step names the PreToolUse hooks whose matcher and if-rule see it', () => {
  const r = claude({
    '.claude/settings.json': preToolUse(
      { matcher: 'Bash', hooks: [hook('node .claude/hooks/shell-guard.mjs')] },
      { matcher: 'WebFetch', hooks: [hook('node .claude/hooks/fetch-guard.mjs', { if: 'WebFetch(domain:docs.example)' })] },
    ),
  });
  assert.deepEqual(item(r, 'send', 'bash-net').hooks, ['shell-guard']);
  assert.deepEqual(item(r, 'send', 'webfetch').hooks, [], 'the if-rule does not match attacker.example');
  assert.match(r.notes.join('\n'), /2 PreToolUse hook\(s\) were not run/);
});

test('between equally weak steps, the weakest path takes the one no hook sees', () => {
  const r = claude({ '.claude/settings.json': preToolUse({ matcher: 'WebFetch|WebSearch', hooks: [hook('node fetch-guard.mjs')] }) });
  assert.equal(step(r, 'main', 'untrusted').guard, 'model');
  assert.deepEqual(step(r, 'main', 'untrusted').hooks, []);
  assert.match(step(r, 'main', 'untrusted').via, /^curl /);
  const text = formatReport({ platforms: [r], notes: [] }, { failOn: 'open', verbose: false });
  assert.match(text, /no hook sees this step/);
});

test('with --user, hooks of enabled plugins count and those of disabled plugins do not', () => {
  const r = withFiles(
    ({ home }) => ({
      '~/.claude/settings.json': { enabledPlugins: { 'on@m': true, 'off@m': false } },
      '~/.claude/plugins/installed_plugins.json': {
        version: 2,
        plugins: {
          'on@m': [{ scope: 'user', installPath: join(home, 'cache', 'on') }],
          'off@m': [{ scope: 'user', installPath: join(home, 'cache', 'off') }],
        },
      },
      '~/cache/on/hooks/hooks.json': preToolUse({ matcher: 'Bash', hooks: [hook('node ${CLAUDE_PLUGIN_ROOT}/hooks/on-guard.mjs')] }),
      '~/cache/off/hooks/hooks.json': preToolUse({ hooks: [hook('node ${CLAUDE_PLUGIN_ROOT}/hooks/off-guard.mjs')] }),
    }),
    ({ base, root, home }) => scan(loadConfig({ root, home, user: true, managedFile: join(base, 'none.json') })),
  );
  assert.deepEqual(item(r, 'send', 'bash-net').hooks, ['on-guard']);
  assert.deepEqual(item(r, 'send', 'webfetch').hooks, []);
});

test('Cursor IDE steps name the hooks whose event sees them', () => {
  const r = withFiles(
    {
      '.env': 'TOKEN=x',
      '.cursor/hooks.json': { version: 1, hooks: { beforeShellExecution: [{ command: 'node .cursor/hooks/shell-audit.mjs' }] } },
    },
    ({ root, home }) => scanCursor(loadCursor({ root, home })),
  );
  const ide = unit(r, 'cursor (IDE)');
  assert.deepEqual(ide.legs.send.find((i) => i.id === 'bash-net').hooks, ['shell-audit (beforeShellExecution)']);
  assert.deepEqual(ide.legs.send.find((i) => i.id === 'webfetch').hooks, []);
});
