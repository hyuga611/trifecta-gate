import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ideSettings, loadCursor, scanCursor } from '../src/cursor.mjs';
import { step, unit, weakest, withFiles } from './helpers.mjs';

const GITHUB = { mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } } };
const IDE = 'cursor (IDE)';
const CLI = 'cursor-agent (CLI)';

const cursor = (files, opts = {}) =>
  withFiles({ '.env': 'TOKEN=x', ...files }, ({ root, home }) => {
    const cfg = loadCursor({ root, home, ...opts });
    return cfg && scanCursor(cfg);
  });

test('no .cursor directory: Cursor is not reported', () => {
  assert.equal(cursor({}), null);
});

test('an empty mcp.json is read as no servers, not an error', () => {
  const r = cursor({ '.cursor/mcp.json': '' });
  assert.deepEqual(r.unclassified, []);
});

test('the Run Mode is assumed to be auto-review unless --cursor-mode says otherwise', () => {
  const files = { '.cursor/mcp.json': GITHUB };
  const auto = cursor(files);
  assert.match(auto.setup, /auto-review \(assumed/);
  assert.equal(weakest(auto, IDE), 'model');
  assert.equal(weakest(cursor(files, { mode: 'allowlist' }), IDE), 'human');
  assert.equal(weakest(cursor(files, { mode: 'run-everything' }), IDE), 'open');
});

test('an mcpAllowlist entry for the whole server opens the trifecta', () => {
  const r = cursor({ '.cursor/mcp.json': GITHUB, '.cursor/permissions.json': { mcpAllowlist: ['github:*'] } }, { mode: 'allowlist' });
  assert.equal(weakest(r, IDE), 'open');
  assert.equal(step(r, IDE, 'send').id, 'mcp:github');
  assert.match(step(r, IDE, 'send').reason, /MCP allowlist entry github:\*/);
});

test('terminalAllowlist matches whole words at the start of the command', () => {
  const send = (entry) => {
    const r = cursor({ '.cursor/permissions.json': { terminalAllowlist: [entry] } }, { mode: 'allowlist' });
    return unit(r, IDE).legs.send.find((i) => i.id === 'bash-net');
  };
  assert.equal(send('curl').guard, 'open');
  assert.equal(send('cur').guard, 'human');
});

test('readBoundary = workspace asks before reading a secret outside the project', () => {
  const files = {
    '~/.ssh/id_ed25519': 'k',
    '~/.cursor/sandbox.json': { readBoundary: 'workspace' },
  };
  const ssh = (r) => unit(r, IDE).legs.private.find((i) => i.id === 'ssh');
  assert.equal(ssh(cursor(files, { user: true, mode: 'allowlist' })).guard, 'human');
  const extra = { ...files, '~/.cursor/sandbox.json': { readBoundary: 'workspace', additionalReadPaths: ['~/.ssh/**'] } };
  assert.equal(ssh(cursor(extra, { user: true, mode: 'allowlist' })).guard, 'open');
  // The project .env is inside the workspace either way.
  assert.equal(unit(cursor(files, { user: true }), IDE).legs.private.find((i) => i.id === 'dotenv').guard, 'open');
});

test('the CLI is reported only when its config exists, and its deny rules win', () => {
  assert.equal(cursor({ '.cursor/mcp.json': GITHUB }).agents.length, 1);
  const r = cursor(
    {
      '.cursor/mcp.json': GITHUB,
      '.cursor/cli.json': { permissions: { allow: ['Mcp(github:*)', 'WebFetch(*)'], deny: ['Mcp(github:create_*)'] } },
    },
    { user: false },
  );
  const github = (leg) => unit(r, CLI).legs[leg].find((i) => i.id === 'mcp:github');
  assert.equal(github('untrusted').guard, 'open');
  assert.equal(github('send').guard, 'open', 'add_issue_comment is not denied');
  assert.match(unit(r, CLI).legs.send.find((i) => i.id === 'mcp:github').via, /add_issue_comment/);
  assert.match(r.setup, /CLI approvalMode: allowlist \(assumed default\)/);
});

test('CLI: WebFetch without an allow entry asks, and web search needs autoAcceptWebSearch', () => {
  const r = cursor({ '~/.cursor/cli-config.json': { permissions: { allow: [], deny: [] }, approvalMode: 'allowlist' } }, { user: true });
  assert.equal(weakest(r, CLI), 'human');
  const open = cursor(
    { '~/.cursor/cli-config.json': { permissions: { allow: ['WebFetch(*)'], deny: [] }, approvalMode: 'allowlist' } },
    { user: true },
  );
  assert.equal(weakest(open, CLI), 'open');
  assert.equal(weakest(cursor({ '~/.cursor/cli-config.json': { permissions: { allow: [], deny: [] }, approvalMode: 'unrestricted' } }, { user: true }), CLI), 'open');
});

const sqlite = await import('node:sqlite').catch(() => null);

// The IDE keeps its Run Mode and allowlists in a SQLite store under the user's app data.
function ideStore(home, composerState) {
  const base = { win32: 'AppData/Roaming', darwin: 'Library/Application Support' }[process.platform] ?? '.config';
  const dir = join(home, base, 'Cursor', 'User', 'globalStorage');
  mkdirSync(dir, { recursive: true });
  const db = new sqlite.DatabaseSync(join(dir, 'state.vscdb'));
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(
    'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser',
    JSON.stringify({ cursorCreds: { token: 'never read' }, composerState }),
  );
  db.close();
}

const agentMode = (run) => ({ modes4: [{ id: 'chat', autoRun: false }, { id: 'agent', ...run }] });

test('ideSettings maps the agent mode flags to a Run Mode', () => {
  assert.equal(ideSettings({}).mode, 'ask-every-time');
  assert.equal(ideSettings(agentMode({ autoRun: true })).mode, 'allowlist');
  assert.equal(ideSettings(agentMode({ autoRun: true, smartAutoRun: true })).mode, 'auto-review');
  assert.equal(ideSettings(agentMode({ autoRun: true, fullAutoRun: true })).mode, 'run-everything');
});

test('with --user the Run Mode and allowlists come from the Cursor settings store', { skip: !sqlite && 'needs node:sqlite' }, () => {
  const read = (state, opts = {}) =>
    withFiles({ '.cursor/mcp.json': GITHUB }, ({ root, home }) => {
      ideStore(home, state);
      return scanCursor(loadCursor({ root, home, user: true, ...opts }));
    });

  const asked = read(agentMode({ autoRun: false }));
  assert.match(asked.setup, /IDE run mode: ask-every-time \(Cursor settings/);
  assert.equal(weakest(asked, IDE), 'human');

  // An allowlisted MCP tool runs on its own, but only once auto-run is on.
  const tools = { ...agentMode({ autoRun: true }), mcpAllowedTools: ['github:*'] };
  assert.equal(weakest(read(tools), IDE), 'open');
  assert.equal(weakest(read({ ...tools, ...agentMode({ autoRun: false }) }), IDE), 'human');

  const fetch = (state) => unit(read({ ...agentMode({ autoRun: true }), ...state }), IDE).legs.send.find((i) => i.id === 'webfetch');
  assert.equal(fetch({}).guard, 'human');
  assert.equal(fetch({ webFetchDomainAllowlist: ['*.example'] }).guard, 'open');
  assert.equal(fetch({ isWebFetchToolEnabled: false }).guard, 'blocked');

  assert.equal(weakest(read(agentMode({ autoRun: false }), { mode: 'run-everything' }), IDE), 'open', '--cursor-mode wins');
});
