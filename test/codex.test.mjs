import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodex, parseRules, scanCodex } from '../src/codex.mjs';
import { step, weakest, withFiles } from './helpers.mjs';

const trusted = (root, rest = '') => `${rest}\n[projects.'${root}']\ntrust_level = "trusted"\n`;

// Each project has a .env, so with --user there is a secret on disk to find.
const codex = (files, opts = { user: true }) =>
  withFiles((dirs) => ({ '.env': 'TOKEN=x', ...(typeof files === 'function' ? files(dirs) : files) }), ({ root, home }) => {
    const cfg = loadCodex({ root, home, ...opts });
    return cfg && scanCodex(cfg);
  });

test('nothing to read: Codex is not reported', () => {
  assert.equal(codex({}), null);
  assert.equal(codex({ '.codex/config.toml': 'sandbox_mode = "read-only"' }, { user: false }) === null, false);
});

test('a trusted project on the defaults: no network in the sandbox, so sending asks first', () => {
  const r = codex(({ root }) => ({ '~/.codex/config.toml': trusted(root) }));
  assert.match(r.setup, /sandbox: workspace-write/);
  assert.equal(weakest(r, 'codex'), 'human');
  assert.equal(step(r, 'codex', 'private').guard, 'open');
  assert.equal(step(r, 'codex', 'untrusted').via, 'web_search <query>');
});

test('network_access = true opens the whole path', () => {
  const r = codex(({ root }) => ({
    '~/.codex/config.toml': trusted(root, '[sandbox_workspace_write]\nnetwork_access = true'),
  }));
  assert.equal(weakest(r, 'codex'), 'open');
  assert.match(step(r, 'codex', 'send').reason, /network_access = true/);
});

test('approval_policy = never with no network leaves no way to send', () => {
  const r = codex(({ root }) => ({ '~/.codex/config.toml': trusted(root, 'approval_policy = "never"') }));
  assert.equal(weakest(r, 'codex'), 'broken');
});

test('trust is found on an ancestor directory, ignoring case on Windows', () => {
  const r = codex(({ root }) => ({
    '~/.codex/config.toml': trusted(process.platform === 'win32' ? root.replace(/repo$/, '').toUpperCase() : root.replace(/repo$/, '')),
  }));
  assert.match(r.setup, /project: trusted/);
});

test('an untrusted project cannot loosen the sandbox from its own .codex/config.toml', () => {
  const r = codex({
    '~/.codex/config.toml': 'model = "x"',
    '.codex/config.toml': 'sandbox_mode = "danger-full-access"\napproval_policy = "never"',
  });
  assert.match(r.setup, /sandbox: read-only/);
  assert.match(r.setup, /project: untrusted/);
  assert.ok(r.notes.some((n) => /ignores \.codex\/config\.toml/.test(n)));
  assert.equal(weakest(r, 'codex'), 'human');
});

test('an allow rule runs curl outside the sandbox; a forbidden rule blocks it', () => {
  const allow = codex(({ root }) => ({
    '~/.codex/config.toml': trusted(root),
    '~/.codex/rules/default.rules': 'prefix_rule(pattern = ["curl"], decision = "allow")',
  }));
  assert.equal(weakest(allow, 'codex'), 'open');
  assert.match(step(allow, 'codex', 'send').reason, /prefix_rule \["curl"\]/);
  const forbid = codex(({ root }) => ({
    '~/.codex/config.toml': trusted(root, '[sandbox_workspace_write]\nnetwork_access = true'),
    '~/.codex/rules/default.rules': 'prefix_rule(pattern = ["curl"], decision = "allow")\nprefix_rule(pattern = ["curl"], decision = "forbidden")',
  }));
  const curl = forbid.agents[0].legs.send.find((i) => /curl/.test(i.via));
  assert.equal(curl?.guard ?? 'blocked', 'blocked');
});

test('rules: alternatives in a pattern, keyword or positional arguments, comments', () => {
  const rules = parseRules(`
# git pushes ask first
prefix_rule(
    pattern = ["git", ["push", "fetch"]],
    decision = "prompt",
    justification = "talks to a remote",
)
prefix_rule(["rm", "-rf"], "forbidden")
`);
  assert.deepEqual(rules, [
    { pattern: ['git', ['push', 'fetch']], decision: 'prompt' },
    { pattern: ['rm', '-rf'], decision: 'forbidden' },
  ]);
});

test('MCP approval_mode follows Codex: unset means auto, which asks before tools that are not read-only', () => {
  const r = (top, mode = '') =>
    codex(({ root }) => ({
      '~/.codex/config.toml': trusted(
        root,
        `${top}
[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
${mode}`,
      ),
      '.codex/x': '',
    }));
  const mcp = (res, leg) => res.agents[0].legs[leg].find((i) => i.id === 'mcp:github');
  assert.equal(mcp(r('', 'default_tools_approval_mode = "prompt"'), 'untrusted').guard, 'human');
  assert.equal(mcp(r('', 'default_tools_approval_mode = "writes"'), 'send').guard, 'human');
  assert.equal(mcp(r('', 'default_tools_approval_mode = "writes"'), 'untrusted').guard, 'open');
  assert.equal(mcp(r('', 'default_tools_approval_mode = "approve"'), 'send').guard, 'open');
  const unset = r('');
  assert.equal(mcp(unset, 'send').guard, 'human');
  assert.match(mcp(unset, 'send').reason, /approval_mode unset \(auto\)/);
  assert.equal(mcp(unset, 'untrusted').guard, 'open');
  assert.equal(mcp(r('approval_policy = "never"\nsandbox_mode = "read-only"'), 'send').guard, 'blocked');
  assert.equal(mcp(r('approval_policy = "never"\nsandbox_mode = "danger-full-access"'), 'send').guard, 'open');
  const reviewed = mcp(r('approvals_reviewer = "auto_review"'), 'send');
  assert.equal(reviewed.guard, 'model');
  assert.match(reviewed.reason, /subagent/);
});

test('disabled_tools removes a tool from a leg', () => {
  const r = codex(({ root }) => ({
    '~/.codex/config.toml': trusted(
      root,
      '[mcp_servers.github]\ncommand = "npx"\nargs = ["@modelcontextprotocol/server-github"]\nenabled_tools = ["get_issue"]',
    ),
  }));
  assert.equal(r.agents[0].legs.send.find((i) => i.id === 'mcp:github'), undefined);
});
