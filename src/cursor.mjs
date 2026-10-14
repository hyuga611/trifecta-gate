import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { HOST, LEGS, NETWORK_ITEMS, classifyServer } from './catalog.mjs';
import { assess, legBuilder, secretProbes, shortPath } from './legs.mjs';
import { context, hookName, isDir, readJson, samePath, serversFrom, shownPath } from './load.mjs';
import { domainMatches, globToRegex, parseRule, splitArgs, toPosix, underDir } from './match.mjs';

// Cursor: the IDE agent and the cursor-agent CLI, from ~/.cursor and the project's .cursor/.
// https://cursor.com/docs/reference/permissions, /reference/sandbox, /agent/security/run-modes,
// /cli/reference/permissions
// The IDE's own settings live in a SQLite store, not in a file; how they combine follows the
// Cursor 3.17 client.

export const CURSOR_MODES = ['ask-every-time', 'allowlist', 'auto-review', 'run-everything'];
export const CLI_MODES = ['allowlist', 'auto-review', 'unrestricted'];

// https://cursor.com/docs/agent/hooks: the events that run before a step and can stop it.
const HOOK_EVENTS = {
  preToolUse: () => true,
  beforeShellExecution: (p) => Boolean(p.command),
  beforeMCPExecution: (p) => p.tool === 'mcp',
  beforeReadFile: (p) => p.tool === 'Read',
};

const globMatches = (glob, value, flags = '') => new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, flags).test(value);

function pathGlob(body, ctx) {
  const abs = body.startsWith('~/') ? ctx.home + body.slice(1) : toPosix(body);
  const full = abs.startsWith('/') ? abs : `${ctx.cwd}/${abs.replace(/^\.\//, '')}`;
  return new RegExp(`^${globToRegex(full)}$`, ctx.caseInsensitive ? 'i' : '');
}

// sandbox.json: per-repo settings win, network allow and deny lists are unioned, and an
// explicit "deny" default beats "allow".
function mergeSandbox(sources) {
  const sb = { type: 'workspace_readwrite', readBoundary: 'system', additionalReadPaths: [], allow: [], deny: [], source: 'default' };
  const defaults = [];
  for (const { json, file } of sources) {
    if (json.type) sb.type = json.type;
    if (json.readBoundary) sb.readBoundary = json.readBoundary;
    if (json.additionalReadPaths) sb.additionalReadPaths = json.additionalReadPaths;
    sb.allow.push(...(json.networkPolicy?.allow ?? []));
    sb.deny.push(...(json.networkPolicy?.deny ?? []));
    if (json.networkPolicy?.default) defaults.push(json.networkPolicy.default);
    sb.source = file;
  }
  sb.networkDefault = defaults.includes('deny') || !defaults.length ? 'deny' : 'allow';
  return sb;
}

const STATE_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

function stateFile(home) {
  const base = {
    win32: join(home, 'AppData', 'Roaming'),
    darwin: join(home, 'Library', 'Application Support'),
  }[process.platform] ?? join(home, '.config');
  return join(base, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

// Read-only, and only the agent settings are kept: the same row also holds the login.
function readIdeState(file, notes) {
  if (!existsSync(file)) return null;
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (/SQLite/.test(w?.message ?? w) ? undefined : emit.call(process, w, ...rest));
  let db;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true });
    const value = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(STATE_KEY)?.value;
    if (value === undefined) return null;
    return JSON.parse(typeof value === 'string' ? value : Buffer.from(value).toString('utf8')).composerState ?? null;
  } catch (e) {
    notes.push(e.code === 'ERR_UNKNOWN_BUILTIN_MODULE' ? 'Reading the Cursor IDE settings needs Node 22.13 or later; its Run Mode was assumed.' : `The Cursor IDE settings could not be read (${e.code ?? e.message}); its Run Mode was assumed.`);
    return null;
  } finally {
    db?.close();
    process.emitWarning = emit;
  }
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// What a new install starts with: auto-review in the sandbox, nothing allowlisted.
const IDE_DEFAULTS = {
  mode: 'auto-review',
  sandboxAutoRun: true,
  terminalAllowlist: [],
  mcpAllowlist: [],
  webFetchAllowlist: [],
  autoAcceptWebSearch: false,
  webSearch: true,
  webFetch: true,
};

export function ideSettings(state) {
  const agent = (Array.isArray(state.modes4) && state.modes4.find((m) => m?.id === 'agent')) || {};
  const mode = !agent.autoRun ? 'ask-every-time' : agent.fullAutoRun ? 'run-everything' : agent.smartAutoRun ? 'auto-review' : 'allowlist';
  return {
    mode,
    sandboxAutoRun: agent.sandboxAutoRun === true,
    terminalAllowlist: strings(state.yoloCommandAllowlist),
    mcpAllowlist: strings(state.mcpAllowedTools),
    webFetchAllowlist: strings(state.webFetchDomainAllowlist),
    autoAcceptWebSearch: state.autoAcceptWebSearchTool === true,
    webSearch: state.isWebSearchToolEnabled3 !== false,
    webFetch: state.isWebFetchToolEnabled !== false,
  };
}

export function loadCursor({ root = '.', user = false, home = homedir(), mode } = {}) {
  const env = context({ root, user, home });
  const { ctx, cwdNative, problems } = env;
  const userDir = join(home, '.cursor');
  const projectDir = join(cwdNative, '.cursor');
  const hasUser = user && isDir(userDir);
  const hasProject = !samePath(userDir, projectDir, ctx) && isDir(projectDir);
  if (!hasUser && !hasProject) return null;
  if (mode && !CURSOR_MODES.includes(mode)) throw new Error(`unknown Cursor run mode "${mode}" (expected one of: ${CURSOR_MODES.join(', ')})`);
  const notes = [];

  const dirs = [...(hasUser ? [userDir] : []), ...(hasProject ? [projectDir] : [])];
  const read = (name) =>
    dirs.map((d) => ({ file: shownPath(join(d, name), ctx), json: readJson(join(d, name), problems) })).filter((x) => x.json);

  const declared = env.declared.mcp ?? {};
  const servers = [];
  const unclassified = [];
  for (const srv of read('mcp.json').flatMap((x) => serversFrom(x.json.mcpServers, x.file))) {
    const c = classifyServer(srv, declared);
    if (c) servers.push({ ...srv, ...c });
    else unclassified.push(srv.name);
  }

  const stateAt = stateFile(home);
  const state = user ? readIdeState(stateAt, notes) : null;
  const ide = state ? ideSettings(state) : IDE_DEFAULTS;
  const fromUi = (list) => list.map((value) => ({ value, file: 'Cursor settings' }));

  // A terminal allowlist in permissions.json replaces the one set in the UI; MCP lists add up.
  const permissions = read('permissions.json');
  const listFrom = (key) => permissions.flatMap(({ json, file }) => (json[key] ?? []).map((value) => ({ value: String(value), file })));
  const terminalFile = listFrom('terminalAllowlist');
  const terminalAllowlist = terminalFile.length ? terminalFile : fromUi(ide.terminalAllowlist);
  const mcpAllowlist = [...listFrom('mcpAllowlist'), ...fromUi(ide.mcpAllowlist)];
  const sandbox = mergeSandbox(read('sandbox.json'));

  const hooks = read('hooks.json').flatMap(({ json }) =>
    Object.keys(HOOK_EVENTS).flatMap((event) => (Array.isArray(json.hooks?.[event]) ? json.hooks[event] : []).map((h) => ({ event, name: hookName(h) }))),
  );

  const cliUser = hasUser ? readJson(join(userDir, 'cli-config.json'), problems) : null;
  const cliProject = hasProject ? readJson(join(projectDir, 'cli.json'), problems) : null;
  let cli = null;
  if (cliUser || cliProject) {
    const userFile = shownPath(join(userDir, 'cli-config.json'), ctx);
    const rules = [
      [cliUser, userFile],
      [cliProject, shownPath(join(projectDir, 'cli.json'), ctx)],
    ].flatMap(([json, file]) =>
      ['deny', 'allow'].flatMap((kind) => (json?.permissions?.[kind] ?? []).map((raw) => ({ raw, ...parseRule(raw), kind, file }))),
    );
    const approvalMode = CLI_MODES.includes(cliUser?.approvalMode) ? cliUser.approvalMode : 'allowlist';
    cli = {
      rules,
      approvalMode,
      approvalSource: cliUser?.approvalMode ? userFile : 'assumed default',
      sandbox: cliUser?.sandbox?.mode === 'enabled' && process.platform !== 'win32',
      autoAcceptWebSearch: cliUser?.autoAcceptWebSearch === true,
    };
    if (cli.sandbox) {
      notes.push(`cli-config.json sandbox.networkAccess = ${cliUser.sandbox.networkAccess ?? 'unset'} is not documented; the CLI's network was judged from sandbox.json.`);
    }
  }

  const sandboxed = process.platform !== 'win32' && sandbox.type !== 'insecure_none' && ide.sandboxAutoRun;
  if (process.platform === 'win32') notes.push('Cursor has no terminal sandbox on Windows (Cursor 3.17 reports sandboxSupported=false); terminal commands were evaluated without it.');
  if (hooks.length) notes.push(`${hooks.length} Cursor hook(s) were not run; IDE steps name the ones whose event sees them. Whether cursor-agent runs them was not checked.`);
  if (unclassified.length) notes.push(`MCP servers not classified: ${unclassified.join(', ')}. Declare their legs in .trifecta.json.`);

  return {
    ctx,
    secrets: env.secrets,
    missingSecrets: env.missingSecrets,
    mode: mode ?? ide.mode,
    modeSource: mode
      ? '--cursor-mode'
      : state
        ? `Cursor settings, ${shownPath(stateAt, ctx)}`
        : `assumed; ${user ? 'no Cursor IDE settings found, pass --cursor-mode' : 'pass --cursor-mode, or --user to read it from Cursor'}`,
    ide,
    hooks,
    servers,
    unclassified,
    terminalAllowlist,
    mcpAllowlist,
    sandbox,
    sandboxed,
    cli,
    notes,
    problems,
  };
}

function readAllowed(path, cfg) {
  const { ctx, sandbox } = cfg;
  if (!path || underDir(path, ctx.cwd, ctx)) return 'inside the workspace';
  if (sandbox.readBoundary !== 'workspace') return `readBoundary = system (${sandbox.source}) allows reads outside the workspace`;
  const extra = sandbox.additionalReadPaths.find((g) => pathGlob(g, ctx).test(path));
  return extra && `additionalReadPaths entry ${extra} (${sandbox.source})`;
}

function hostAllowed(host, sandbox) {
  if (sandbox.deny.some((p) => domainMatches(p, host))) return false;
  if (sandbox.allow.some((p) => domainMatches(p, host))) return true;
  return sandbox.networkDefault === 'allow';
}

// A command the sandbox lets through without leaving it: reads within the read boundary,
// network only to hosts the policy allows.
function sandboxLets(probe, leg, cfg) {
  if (leg !== 'private') {
    return hostAllowed(HOST, cfg.sandbox) && `the sandbox network policy (${cfg.sandbox.source}) lets it reach ${HOST}`;
  }
  const read = readAllowed(probe.path ?? probe.dir, cfg);
  return read && `runs in the ${cfg.sandbox.type} sandbox; ${read}`;
}

const MODE_GUARD = {
  'run-everything': ['open', 'Run Everything mode runs it'],
  'auto-review': ['model', 'auto-review leaves it to a reviewing model'],
  allowlist: ['human', 'allowlist mode asks a person'],
  'ask-every-time': ['human', 'Ask Every Time mode asks a person'],
  unrestricted: ['open', 'approvalMode = unrestricted runs it'],
};
const byMode = (mode, why = '') => {
  const [guard, reason] = MODE_GUARD[mode];
  return { guard, reason: why ? `${why}; ${reason}` : reason };
};

// Outside Ask Every Time, allowlisted calls run on their own; Run Everything runs all of them.
function evaluateIde(probe, leg, cfg) {
  const { mode, ide } = cfg;
  const autoRun = mode !== 'ask-every-time';
  if (probe.tool === 'Read') {
    const read = readAllowed(probe.path, cfg);
    return read ? { guard: 'open', reason: read } : byMode(mode, 'outside readBoundary = workspace');
  }
  if (probe.tool === 'WebSearch') {
    if (!ide.webSearch) return { guard: 'blocked', reason: 'the web search tool is turned off' };
    if (mode === 'run-everything') return byMode(mode);
    return ide.autoAcceptWebSearch
      ? { guard: 'open', reason: 'auto-accept web search is on' }
      : { guard: 'human', reason: 'web search asks a person unless auto-accept web search is on' };
  }
  if (probe.tool === 'WebFetch' && !ide.webFetch) return { guard: 'blocked', reason: 'the web fetch tool is turned off' };
  if (mode === 'run-everything') return byMode(mode);
  switch (probe.tool) {
    case 'WebFetch': {
      const hit = autoRun && ide.webFetchAllowlist.find((p) => domainMatches(p, probe.domain));
      if (hit) return { guard: 'open', reason: `web fetch domain allowlist entry ${hit} (Cursor settings)` };
      return mode === 'auto-review'
        ? { guard: 'model', reason: 'not on the web fetch domain allowlist; assumed to go to auto-review' }
        : byMode(mode, 'not on the web fetch domain allowlist');
    }
    case 'mcp': {
      const hit = autoRun && cfg.mcpAllowlist.find(({ value }) => {
        if (value === '*') return true;
        const [server, tool = '*'] = value.split(':');
        return globMatches(server, probe.server) && globMatches(tool, probe.name);
      });
      return hit ? { guard: 'open', reason: `MCP allowlist entry ${hit.value} in ${hit.file}` } : byMode(mode);
    }
    default: {
      const hit = autoRun && cfg.terminalAllowlist.find(({ value }) => probe.command === value || probe.command.startsWith(`${value} `));
      if (hit) return { guard: 'open', reason: `terminal allowlist entry "${hit.value}" in ${hit.file}` };
      const sandbox = autoRun && cfg.sandboxed && sandboxLets(probe, leg, cfg);
      return sandbox ? { guard: 'open', reason: sandbox } : byMode(mode);
    }
  }
}

function cliRuleMatches(rule, probe, ctx) {
  const { tool, body = '*' } = rule;
  if (tool === 'Shell' && probe.command) {
    const args = splitArgs(probe.command);
    const [base, rest] = body.includes(':') ? [body.slice(0, body.indexOf(':')), body.slice(body.indexOf(':') + 1)] : [body, '*'];
    return globMatches(base, args[0]) && globMatches(rest, args.slice(1).join(' '), 's');
  }
  if (tool === 'Read' && probe.tool === 'Read') return pathGlob(body, ctx).test(probe.path);
  if (tool === 'WebFetch' && probe.tool === 'WebFetch') return domainMatches(body, probe.domain);
  if (tool === 'Mcp' && probe.tool === 'mcp') {
    const [server, name = '*'] = body.split(':');
    return globMatches(server, probe.server) && globMatches(name, probe.name);
  }
  return false;
}

function evaluateCli(probe, leg, cfg) {
  const { cli, ctx } = cfg;
  for (const kind of ['deny', 'allow']) {
    const rule = cli.rules.find((r) => r.kind === kind && cliRuleMatches(r, probe, ctx));
    if (rule) return { guard: kind === 'deny' ? 'blocked' : 'open', reason: `${kind} ${rule.raw} in ${rule.file}` };
  }
  const mode = cli.approvalMode;
  if (mode === 'unrestricted') return byMode(mode);
  switch (probe.tool) {
    case 'Read':
      return { guard: 'open', reason: 'no Read deny rule matches, and cursor-agent never asks before a read' };
    case 'WebSearch':
      return cli.autoAcceptWebSearch
        ? { guard: 'open', reason: 'autoAcceptWebSearch = true' }
        : byMode(mode, 'autoAcceptWebSearch is off');
    case 'WebFetch':
      return byMode(mode, 'no WebFetch allow entry');
    case 'mcp':
      return byMode(mode);
    default: {
      const sandbox = cli.sandbox && sandboxLets(probe, leg, cfg);
      return sandbox ? { guard: 'open', reason: sandbox } : byMode(mode);
    }
  }
}

export function scanCursor(cfg) {
  const { ctx } = cfg;
  const show = (probe) => {
    if (probe.show) return probe.show;
    if (probe.tool === 'Read') return `Read ${shortPath(probe.path, ctx)}`;
    if (probe.tool === 'mcp') return `${probe.server}:${probe.name} (MCP)`;
    return probe.dir ? `${probe.command}  (in ${shortPath(probe.dir, ctx)})` : probe.command;
  };
  const unit = (name, evaluate) => {
    const { legs, add } = legBuilder(evaluate, show);
    for (const s of cfg.secrets) add('private', s.id, s.label, secretProbes(s, ctx, [ctx.cwd]));
    for (const item of NETWORK_ITEMS) {
      for (const leg of ['untrusted', 'send']) if (item[leg]) add(leg, item.id, item.label, item[leg]);
    }
    for (const srv of cfg.servers) {
      for (const leg of LEGS) {
        const tools = srv.legs[leg];
        if (tools) add(leg, `mcp:${srv.name}`, `MCP ${srv.name} (${srv.kind})`, tools.map((n) => ({ tool: 'mcp', server: srv.name, name: n })));
      }
    }
    return { name, file: null, ...assess(legs) };
  };

  const seenBy = (probe) => [...new Set(cfg.hooks.filter((h) => HOOK_EVENTS[h.event](probe)).map((h) => `${h.name} (${h.event})`))];
  const ide = (p, leg) => ({ ...evaluateIde(p, leg, cfg), ...(cfg.hooks.length && { hooks: seenBy(p) }) });
  const agents = [unit('cursor (IDE)', ide)];
  const setup = [`IDE run mode: ${cfg.mode} (${cfg.modeSource})`];
  if (cfg.cli) {
    agents.push(unit('cursor-agent (CLI)', (p, leg) => evaluateCli(p, leg, cfg)));
    setup.push(`CLI approvalMode: ${cfg.cli.approvalMode} (${cfg.cli.approvalSource})`);
  }
  return { platform: 'Cursor', setup: setup.join(' · '), agents, skills: [], unclassified: cfg.unclassified, notes: cfg.notes };
}
