import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { secretTargets } from './catalog.mjs';
import { fromPosix, parseRule, resolveDir, toPosix } from './match.mjs';

const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const MANAGED = {
  win32: 'C:/Program Files/ClaudeCode/managed-settings.json',
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
};

export const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export const samePath = (a, b, ctx) =>
  ctx.caseInsensitive ? toPosix(a).toLowerCase() === toPosix(b).toLowerCase() : toPosix(a) === toPosix(b);

export function readJson(file, problems) {
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
    return text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    problems.push(`${file}: ${e.message}`);
    return null;
  }
}

function frontmatter(file) {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

const toolList = (v) =>
  v === undefined || v === ''
    ? undefined
    : v.replace(/^\[|\]$/g, '').split(/,\s*|\s+(?=[A-Z]|mcp__)/).map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);

// Git checks a symlink out as a small text file holding its target when symlinks are off
// (the Windows default), so a skills folder can arrive as a file.
function realDir(path) {
  if (!path || !existsSync(path)) return null;
  const st = statSync(path);
  if (st.isDirectory()) return path;
  if (st.size > 1024) return null;
  const target = readFileSync(path, 'utf8').trim();
  const resolved = target && !target.includes('\n') ? resolve(dirname(path), target) : null;
  return resolved && existsSync(resolved) && statSync(resolved).isDirectory() ? resolved : null;
}

function markdownUnits(dir, nested) {
  const real = realDir(dir);
  if (!real) return [];
  const out = [];
  for (const name of readdirSync(real)) {
    const file = nested ? join(real, name, 'SKILL.md') : join(real, name);
    if (nested ? existsSync(file) : name.endsWith('.md') && statSync(file).isFile()) {
      out.push({ file, meta: frontmatter(file), fallback: name.replace(/\.md$/, '') });
    }
  }
  return out;
}

// A short name for a hook in the report: the script it runs, or its URL's host.
export function hookName(h) {
  if (h?.type === 'http') {
    try {
      return new URL(h.url).host;
    } catch {
      return 'http hook';
    }
  }
  if (h?.type && h.type !== 'command') return `${h.type} hook`;
  const text = [h?.command, ...(Array.isArray(h?.args) ? h.args : [])].join(' ');
  const script = /([\w.-]+)\.(?:m?js|cjs|ts|py|ps1|sh|bash|bat|cmd|rb)\b/i.exec(text);
  return script ? script[1] : String(h?.command ?? '').trim().split(/\s+/)[0] || 'hook';
}

function preToolUse(hooks, file) {
  const groups = Array.isArray(hooks?.PreToolUse) ? hooks.PreToolUse : [];
  return groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []).map((h) => ({ matcher: g.matcher, if: h.if, name: hookName(h), file })));
}

// Hooks of the plugins the settings enable, from where Claude Code installed them.
function pluginHooks(sources, home, problems) {
  const enabled = {};
  for (const { json } of sources) Object.assign(enabled, json.enabledPlugins ?? {});
  const installed = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'), problems)?.plugins ?? {};
  return Object.entries(installed)
    .filter(([id]) => enabled[id] === true)
    .flatMap(([id, installs]) =>
      [installs].flat().flatMap((i) => (i?.installPath ? preToolUse(readJson(join(i.installPath, 'hooks', 'hooks.json'), problems)?.hooks, `plugin ${id}`) : [])),
    );
}

export function serversFrom(obj, origin) {
  return Object.entries(obj ?? {}).map(([name, s]) => ({
    name,
    origin,
    command: s.command,
    args: Array.isArray(s.args) ? s.args.map(String) : [],
    url: s.url,
  }));
}

const DISK = {
  exists: (p) => existsSync(fromPosix(p)),
  list: (dir) => {
    try {
      return readdirSync(fromPosix(dir), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  },
};

// What every platform shares: where the project and home are, and which secrets to look for.
export function context({ root = '.', user = false, home = homedir() } = {}) {
  const cwdNative = resolve(root);
  const ctx = { cwd: toPosix(cwdNative), home: toPosix(home), caseInsensitive: process.platform === 'win32' };
  const { secrets, missing } = secretTargets(ctx, user ? DISK : null);
  const problems = [];
  const declared = readJson(join(cwdNative, '.trifecta.json'), problems) ?? {};
  return { ctx, cwdNative, home, user, secrets, missingSecrets: missing, declared, problems };
}

export const shownPath = (p, ctx) => {
  const posix = toPosix(p);
  if (ctx.cwd !== ctx.home && posix.startsWith(ctx.cwd)) return `.${posix.slice(ctx.cwd.length)}`;
  return posix.startsWith(ctx.home) ? `~${posix.slice(ctx.home.length)}` : posix;
};

// Reads a project's Claude Code configuration, and with `user: true` the user's own as well.
export function loadConfig({ root = '.', user = false, home = homedir(), mode, managedFile } = {}) {
  const env = context({ root, user, home });
  const { ctx, cwdNative, problems } = env;
  const shown = (p) => shownPath(p, ctx);

  // Started from the home directory, the project's .claude is the user's own: read it once.
  const seen = new Set();
  const once = (file) => {
    const key = ctx.caseInsensitive ? toPosix(file).toLowerCase() : toPosix(file);
    return !seen.has(key) && seen.add(key);
  };

  const sources = [];
  const add = (scope, file) => {
    if (!once(file)) return;
    const json = readJson(file, problems);
    if (json) sources.push({ scope, file: shown(file), json });
  };
  if (user) {
    add('user', join(home, '.claude', 'settings.json'));
    add('user', join(home, '.claude', 'settings.local.json'));
  }
  add('project', join(cwdNative, '.claude', 'settings.json'));
  add('local', join(cwdNative, '.claude', 'settings.local.json'));
  add('managed', managedFile ?? MANAGED[process.platform] ?? MANAGED.linux);

  const rules = [];
  const workingDirs = [ctx.cwd];
  let blockOutside = false;
  let disableAuto = false;
  const hooks = [];
  let sandbox = false;
  for (const { scope, file, json } of sources) {
    const p = json.permissions ?? {};
    for (const kind of ['deny', 'ask', 'allow']) {
      for (const raw of p[kind] ?? []) rules.push({ raw, ...parseRule(raw), kind, scope, file });
    }
    for (const d of p.additionalDirectories ?? []) workingDirs.push(resolveDir(d, ctx));
    if (p.blockReadsOutsideWorkingDirectories) blockOutside = true;
    if (p.disableAutoMode === 'disable') disableAuto = true;
    hooks.push(...preToolUse(json.hooks, file));
    if (json.sandbox?.enabled) sandbox = true;
  }

  if (user) hooks.push(...pluginHooks(sources, home, problems));
  const resolved = resolveMode(mode, sources, disableAuto);

  const mcpServers = [...serversFrom(readJson(join(cwdNative, '.mcp.json'), problems)?.mcpServers, './.mcp.json')];
  if (user) {
    const cj = readJson(join(home, '.claude.json'), problems) ?? {};
    mcpServers.push(...serversFrom(cj.mcpServers, '~/.claude.json'));
    const project = Object.entries(cj.projects ?? {}).find(([dir]) => toPosix(dir).toLowerCase() === ctx.cwd.toLowerCase());
    if (project) mcpServers.push(...serversFrom(project[1].mcpServers, '~/.claude.json (this project)'));
  }

  const unitDirs = (name) => [join(cwdNative, '.claude', name), ...(user ? [join(home, '.claude', name)] : [])].filter(once);
  const agentDirs = unitDirs('agents');
  const agents = agentDirs.flatMap((d) => markdownUnits(d, false)).map(({ file, meta, fallback }) => ({
    name: meta.name || fallback,
    file: shown(file),
    tools: toolList(meta.tools),
    disallowedTools: toolList(meta.disallowedTools),
  }));

  const skillDirs = unitDirs('skills');
  const skills = skillDirs.flatMap((d) => markdownUnits(d, true)).map(({ file, meta, fallback }) => ({
    name: meta.name || fallback,
    file: shown(file),
    allowedTools: toolList(meta['allowed-tools']),
  }));

  return {
    ctx,
    secrets: env.secrets,
    missingSecrets: env.missingSecrets,
    mode: resolved.mode,
    modeSource: resolved.source,
    alsoMode: resolved.also,
    rules,
    workingDirs,
    blockOutside,
    hooks,
    sandbox,
    mcpServers,
    agents,
    skills,
    declared: env.declared,
    problems,
    user,
  };
}

// https://code.claude.com/docs/en/permission-modes ("Which mode a session starts in")
function resolveMode(flag, sources, disableAuto) {
  if (flag) {
    if (!MODES.includes(flag)) throw new Error(`unknown mode "${flag}" (expected one of: ${MODES.join(', ')})`);
    return { mode: flag, source: '--mode' };
  }
  const order = ['managed', 'local', 'project', 'user'];
  const set = sources
    .filter((s) => MODES.includes(s.json.permissions?.defaultMode))
    .sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope));
  for (const s of set) {
    const m = s.json.permissions.defaultMode;
    const inProject = s.scope === 'project' || s.scope === 'local';
    if (inProject && m === 'bypassPermissions') return { mode: 'default', source: `${s.file} (bypassPermissions is ignored here)` };
    if (inProject && m === 'auto') break;
    if (m === 'auto' && disableAuto) continue;
    return { mode: m, source: s.file };
  }
  // Sessions where auto mode is off start in default mode, which keeps the broad allow
  // rules auto mode drops.
  return disableAuto
    ? { mode: 'default', source: 'built-in default (auto mode disabled)' }
    : { mode: 'auto', source: 'built-in default for interactive sessions', also: 'default' };
}
