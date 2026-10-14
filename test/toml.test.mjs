import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml } from '../src/toml.mjs';

test('tables, quoted keys, dotted keys and comments', () => {
  const t = parseToml(String.raw`
model = "gpt-5" # trailing comment
[projects.'C:\Users\a\repo']
trust_level = "trusted"
[mcp_servers.github]
command = "npx"
tools.create_issue.approval_mode = "prompt"
`);
  assert.equal(t.model, 'gpt-5');
  assert.equal(t.projects[String.raw`C:\Users\a\repo`].trust_level, 'trusted');
  assert.equal(t.mcp_servers.github.tools.create_issue.approval_mode, 'prompt');
});

test('strings, numbers, booleans, arrays and inline tables', () => {
  const t = parseToml(String.raw`
basic = "tab\there \u00e9"
literal = 'C:\no\escapes'
multi = """
two
lines"""
n = 1_000
f = -0.5
yes = true
args = [
  "-y",   # a comment inside an array
  "@modelcontextprotocol/server-github",
]
env = { TOKEN = "x", nested = { a = 1 } }
`);
  assert.equal(t.basic, 'tab\there é');
  assert.equal(t.literal, String.raw`C:\no\escapes`);
  assert.equal(t.multi, 'two\nlines');
  assert.equal(t.n, 1000);
  assert.equal(t.f, -0.5);
  assert.equal(t.yes, true);
  assert.deepEqual(t.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.deepEqual(t.env, { TOKEN: 'x', nested: { a: 1 } });
});

test('arrays of tables', () => {
  const t = parseToml('[[hooks.PreToolUse]]\nmatcher = "shell"\n[[hooks.PreToolUse]]\nmatcher = "mcp"\n');
  assert.deepEqual(t.hooks.PreToolUse.map((h) => h.matcher), ['shell', 'mcp']);
});

test('a malformed line is an error, not a silent skip', () => {
  assert.throws(() => parseToml('sandbox_mode = '));
});
