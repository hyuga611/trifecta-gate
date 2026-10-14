import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadConfig } from '../src/load.mjs';
import { scan } from '../src/scan.mjs';
import { unit as find, withFiles } from './helpers.mjs';

const GITHUB = { mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } } };

const project = (files, opts = {}) =>
  withFiles(files, ({ base, root, home }) => scan(loadConfig({ root, home, managedFile: join(base, 'none.json'), ...opts })));

const unit = (r, name = 'main') => find(r, name);
const weakest = (r, name) => unit(r, name).weakest?.guard ?? 'broken';

test('no configuration: every path is left to the auto-mode classifier', () => {
  const r = project({});
  assert.equal(r.mode, 'auto');
  assert.equal(weakest(r), 'model');
  assert.equal(unit(r).counts.open, 0);
});

test('allowing a whole GitHub MCP server opens the trifecta', () => {
  const r = project({ '.mcp.json': GITHUB, '.claude/settings.json': { permissions: { allow: ['mcp__github'] } } });
  assert.equal(weakest(r), 'open');
  const [priv, untrusted, send] = unit(r).weakest.steps;
  assert.match(priv.via, /\.env/);
  assert.equal(untrusted.id, 'mcp:github');
  assert.equal(send.id, 'mcp:github');
});

test('allowing only the read tools keeps the send leg behind the classifier', () => {
  const r = project({ '.mcp.json': GITHUB, '.claude/settings.json': { permissions: { allow: ['mcp__github__get_*'] } } });
  assert.equal(weakest(r), 'model');
});

test('a deny rule on the send side blocks that leg', () => {
  const r = project({
    '.claude/settings.json': { permissions: { allow: ['WebFetch'], deny: ['WebFetch(domain:*)', 'Bash', 'PowerShell'] } },
  });
  assert.equal(weakest(r), 'broken');
});

test('a Read deny on .env does not close the private leg: grep -r never names the file', () => {
  const r = project({ '.claude/settings.json': { permissions: { deny: ['Read(.env)'] } } });
  const env = unit(r).legs.private.find((i) => i.id === 'dotenv');
  assert.equal(env.guard, 'open');
  assert.match(env.via, /grep -r/);
});

test('auto mode drops Bash(*) allow rules; default mode keeps them', () => {
  const files = { '.claude/settings.json': { permissions: { allow: ['Bash(*)'] } } };
  assert.equal(weakest(project(files, { mode: 'auto' })), 'model');
  assert.equal(weakest(project(files, { mode: 'default' })), 'open');
});

test('when no setting picks the mode, sessions without auto mode are checked too', () => {
  const r = project({ '.claude/settings.json': { permissions: { allow: ['Bash'] } } });
  assert.equal(r.mode, 'auto');
  assert.match(r.setup, /also checked: default/);
  assert.equal(weakest(r), 'open');
  assert.equal(unit(r).mode, 'default');
  const plain = project({});
  assert.equal(weakest(plain), 'model');
  assert.equal(unit(plain).mode, undefined);
  const pinned = project({ '.claude/settings.json': { permissions: { allow: ['Bash'], defaultMode: 'plan' } } });
  assert.doesNotMatch(pinned.setup, /also checked/);
});

test('gh issue view brings in untrusted text and gh issue comment sends it out', () => {
  const r = project({ '.claude/settings.json': { permissions: { allow: ['Bash(gh issue view:*)', 'Bash(gh issue comment:*)'] } } });
  assert.equal(weakest(r), 'open');
  const [, untrusted, send] = unit(r).weakest.steps;
  assert.equal(untrusted.id, 'gh-cli');
  assert.equal(send.id, 'gh-cli');
  const api = project({ '.claude/settings.json': { permissions: { allow: ['Bash(gh api:*)'] } } });
  assert.match(unit(api).weakest.steps[2].via, /^gh api .* -f body=/);
});

test('npx and uv run can start code that sends', () => {
  for (const rule of ['Bash(npx:*)', 'Bash(uv run:*)']) {
    const r = project({ '.claude/settings.json': { permissions: { allow: [rule] } } }, { mode: 'default' });
    assert.equal(unit(r).legs.send.find((i) => i.id === 'bash-interp').guard, 'open', rule);
  }
});

test('bypassPermissions in project settings does not take effect', () => {
  const r = project({ '.claude/settings.json': { permissions: { defaultMode: 'bypassPermissions' } } });
  assert.equal(r.mode, 'default');
  assert.equal(weakest(r), 'human');
});

test('a user-level defaultMode is used when the project sets none', () => {
  const r = project({ '~/.claude/settings.json': { permissions: { defaultMode: 'dontAsk' } } }, { user: true });
  assert.equal(r.mode, 'dontAsk');
});

test('a subagent with the GitHub tools it needs holds the trifecta on its own', () => {
  const r = project({
    '.mcp.json': GITHUB,
    '.claude/settings.json': { permissions: { allow: ['mcp__github'] } },
    '.claude/agents/triage.md': '---\nname: triage\ntools: Read, mcp__github__get_issue, mcp__github__add_issue_comment\n---\nbody\n',
    '.claude/agents/docs.md': '---\nname: docs\ntools: Read, Grep, Glob\n---\nbody\n',
  });
  assert.equal(weakest(r, 'triage'), 'open');
  assert.equal(weakest(r, 'docs'), 'broken');
});

test('a skill whose allowed-tools open a path is reported', () => {
  const r = project({
    '.claude/skills/research/SKILL.md': '---\nname: research\nallowed-tools: WebFetch\n---\nbody\n',
  });
  assert.equal(weakest(r, 'research'), 'open');
});

test('unknown MCP servers are listed, and .trifecta.json can declare their legs', () => {
  const custom = { mcpServers: { crm: { command: 'crm-mcp' } } };
  const settings = { permissions: { allow: ['mcp__crm'] } };
  const plain = project({ '.mcp.json': custom, '.claude/settings.json': settings });
  assert.deepEqual(plain.unclassified, ['crm']);
  const declared = project({
    '.mcp.json': custom,
    '.claude/settings.json': settings,
    '.trifecta.json': { mcp: { crm: ['untrusted', 'send'] } },
  });
  assert.equal(weakest(declared), 'open');
});

test('with --user, only secrets that exist on disk are counted', () => {
  const r = project({ '~/.ssh/work_key': 'k', '~/.ssh/work_key.pub': 'p', '~/.ssh/known_hosts': 'h' }, { user: true });
  const ids = unit(r).legs.private.map((i) => i.id);
  assert.deepEqual(ids, ['ssh']);
  assert.match(unit(r).legs.private[0].via, /work_key$/);
});

test('without --user, every well-known secret is counted, as on a CI runner', () => {
  const r = project({});
  assert.ok(unit(r).legs.private.length >= 6);
});

test('a skills folder checked out as a symlink stand-in file is followed', () => {
  const r = project({
    '.claude/skills': '../.agents/skills',
    '.agents/skills/triage/SKILL.md': '---\nname: triage\nallowed-tools: WebFetch\n---\n',
  });
  assert.ok(find(r, 'triage'));
});

test('context7 counts as untrusted content; sequential-thinking is known and has no legs', () => {
  const r = project({
    '.mcp.json': JSON.stringify({
      mcpServers: {
        context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
        'sequential-thinking': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
      },
    }),
    '.claude/settings.json': JSON.stringify({ enableAllProjectMcpServers: true }),
  });
  assert.ok(find(r, 'main').legs.untrusted.some((i) => i.id === 'mcp:context7'));
  assert.ok(!r.notes.some((n) => /not classified/.test(n)));
});
