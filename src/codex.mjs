import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LEGS, SHELL_NETWORK_ITEMS, classifyServer } from './catalog.mjs';
import { assess, legBuilder, secretProbes, shortPath } from './legs.mjs';
import { context, isDir, samePath, shownPath } from './load.mjs';
import { splitArgs, toPosix, underDir } from './match.mjs';
import { parseToml } from './toml.mjs';

// OpenAI Codex: ~/.codex/config.toml, and .codex/ in projects it trusts.
// https://learn.chatgpt.com/docs/agent-configuration (config, sandbox, approvals, rules)

function readToml(file, problems) {
  if (!existsSync(file)) return null;
  try {
    return parseToml(readFileSync(file, 'utf8'));
  } catch (e) {
    problems.push(`${file}: ${e.message}`);
    return null;
  }
}

const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = isTable(v) && isTable(a?.[k]) ? merge(a[k], v) : v;
  return out;
}

// Rules are Starlark files of prefix_rule(pattern = [...], decision = "...") calls.
// https://learn.chatgpt.com/docs/agent-configuration/rules
const TOKEN = /\s+|#[^\n]*|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|([A-Za-z_]\w*)|([()[\],=])|([^\s()[\],=#"']+)/g;
const unquote = (s) =>
  /^("""|''')/.test(s) ? s.slice(3, -3) : s.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);

export function parseRules(text) {
  const t = [...text.matchAll(TOKEN)]
    .filter((m) => m[1] || m[2] || m[3] || m[4])
    .map((m) => (m[1] ? { str: unquote(m[1]) } : m[2] ? { id: m[2] } : m[3] ? { p: m[3] } : { other: m[4] }));
  let i = 0;
  const value = () => {
    const tok = t[i++];
    const close = { '[': ']', '(': ')' }[tok?.p];
    if (!close) return tok?.str ?? tok?.id ?? tok?.other;
    const list = [];
    while (i < t.length && t[i].p !== close) {
      if (t[i].p === ',') i++;
      else list.push(value());
    }
    i++;
    return list;
  };
  const rules = [];
  for (; i < t.length; i++) {
    if (t[i].id !== 'prefix_rule' || t[i + 1]?.p !== '(') continue;
    i += 2;
    const named = {};
    const positional = [];
    while (i < t.length && t[i].p !== ')') {
      if (t[i].p === ',') i++;
      else if (t[i].id && t[i + 1]?.p === '=') {
        const key = t[i].id;
        i += 2;
        named[key] = value();
      } else positional.push(value());
    }
    const pattern = named.pattern ?? positional[0];
    if (Array.isArray(pattern) && pattern.length) rules.push({ pattern, decision: named.decision ?? positional[1] ?? 'allow' });
  }
  return rules;
}

const STRICTNESS = ['allow', 'prompt', 'forbidden'];

// Every rule whose pattern is a prefix of the command applies; the strictest decision wins.
function strictestRule(rules, args) {
  let hit;
  for (const r of rules) {
    if (r.pattern.length > args.length) continue;
    if (!r.pattern.every((el, k) => (Array.isArray(el) ? el.includes(args[k]) : el === args[k]))) continue;
    if (!hit || STRICTNESS.indexOf(r.decision) > STRICTNESS.indexOf(hit.decision)) hit = r;
  }
  return hit;
}

function rulesIn(dir, ctx, problems) {
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.rules'))
    .flatMap((n) => {
      try {
        return parseRules(readFileSync(join(dir, n), 'utf8')).map((r) => ({ ...r, file: shownPath(join(dir, n), ctx) }));
      } catch (e) {
        problems.push(`${join(dir, n)}: ${e.message}`);
        return [];
      }
    });
}

const HOOK_EVENTS = /^(PreToolUse|PermissionRequest|pre_tool_use|permission_request)$/i;
const countHooks = (hooks) =>
  Object.entries(hooks ?? {})
    .filter(([event]) => HOOK_EVENTS.test(event))
    .reduce((n, [, list]) => n + (Array.isArray(list) ? list.reduce((m, h) => m + (h.hooks?.length ?? 1), 0) : 1), 0);

// The nearest [projects.'<dir>'] entry at or above the working directory.
function trustEntry(projects, ctx) {
  let best;
  for (const [dir, p] of Object.entries(projects ?? {})) {
    const d = toPosix(dir);
    if (!underDir(ctx.cwd, d, { caseInsensitive: true })) continue;
    if (!best || d.length > toPosix(best.dir).length) best = { dir, level: p?.trust_level };
  }
  return best;
}

function approvalOf(value) {
  if (isTable(value?.granular)) return { policy: 'granular', granular: value.granular };
  if (value === 'on-failure') return { policy: 'on-request' };
  return { policy: value };
}

export function loadCodex({ root = '.', user = false, home = homedir() } = {}) {
  const env = context({ root, user, home });
  const { ctx, cwdNative, problems } = env;
  const userDir = join(home, '.codex');
  const projectDir = join(cwdNative, '.codex');
  const hasUser = user && existsSync(join(userDir, 'config.toml'));
  const hasProject = !samePath(userDir, projectDir, ctx) && isDir(projectDir);
  if (!hasUser && !hasProject) return null;
  const notes = [];

  const userFile = shownPath(join(userDir, 'config.toml'), ctx);
  const userCfg = (user && readToml(join(userDir, 'config.toml'), problems)) || {};

  let trust;
  if (user) {
    const entry = trustEntry(userCfg.projects, ctx);
    trust = entry
      ? { level: entry.level === 'trusted' ? 'trusted' : 'untrusted', source: `[projects.'${entry.dir}'] in ${userFile}` }
      : { level: 'untrusted', source: `not listed under [projects] in ${userFile}` };
  } else {
    trust = { level: 'trusted', source: 'assumed; pass --user to read [projects] from ~/.codex/config.toml' };
  }
  const trusted = trust.level === 'trusted';
  if (hasProject && !trusted) notes.push('Codex ignores .codex/config.toml and .codex/rules in a project it does not trust.');

  const projectFile = shownPath(join(projectDir, 'config.toml'), ctx);
  const projectCfg = (hasProject && trusted && readToml(join(projectDir, 'config.toml'), problems)) || {};
  const merged = merge(userCfg, projectCfg);
  const profileName = merged.profile;
  const profile = (profileName && merged.profiles?.[profileName]) || {};

  // Where a setting comes from, highest priority first.
  const layers = [
    [profile, `profile "${profileName}"`],
    [projectCfg, projectFile],
    [userCfg, userFile],
  ];
  const pick = (key, fallback) => {
    for (const [cfg, source] of layers) if (cfg[key] !== undefined) return { value: cfg[key], source };
    return { value: fallback[0], source: fallback[1] };
  };

  const sandbox = pick('sandbox_mode', trusted ? ['workspace-write', 'default for a trusted project'] : ['read-only', 'default for an untrusted project']);
  const approvalSetting = pick('approval_policy', trusted ? ['on-request', 'default for a trusted project'] : ['untrusted', 'default for an untrusted project']);
  const approval = { ...approvalOf(approvalSetting.value), source: approvalSetting.source };
  const network = pick('sandbox_workspace_write', [{}, '']).value.network_access === true;
  const reviewer = pick('approvals_reviewer', ['user', 'default']);
  const legacySearch = merged.tools?.web_search;
  const search = pick('web_search', [
    legacySearch === true ? 'live' : legacySearch === false ? 'disabled' : sandbox.value === 'danger-full-access' ? 'live' : 'cached',
    legacySearch === undefined ? 'default' : '[tools] web_search',
  ]);

  const rules = [
    ...(user ? rulesIn(join(userDir, 'rules'), ctx, problems) : []),
    ...(hasProject && trusted ? rulesIn(join(projectDir, 'rules'), ctx, problems) : []),
  ];

  const declared = env.declared.mcp ?? {};
  const servers = [];
  const unclassified = [];
  for (const [name, s] of Object.entries(merged.mcp_servers ?? {})) {
    if (s.enabled === false) continue;
    const srv = { name, command: s.command, args: (s.args ?? []).map(String), url: s.url, conf: s };
    const c = classifyServer(srv, declared);
    if (c) servers.push({ ...srv, ...c });
    else unclassified.push(name);
  }

  let hooks = countHooks(merged.hooks);
  for (const [dir, on] of [[userDir, user], [projectDir, hasProject && trusted]]) {
    const file = join(dir, 'hooks.json');
    if (!on || !existsSync(file)) continue;
    try {
      hooks += countHooks(JSON.parse(readFileSync(file, 'utf8')).hooks);
    } catch (e) {
      problems.push(`${file}: ${e.message}`);
    }
  }

  notes.push('Command-line flags (--sandbox, --ask-for-approval, --full-auto, --profile) override these files; a wrapper that passes them is not seen here.');
  const profiles = Object.keys(merged.profiles ?? {}).filter((p) => p !== profileName);
  if (profiles.length) notes.push(`Profiles not evaluated (they apply with --profile): ${profiles.join(', ')}.`);
  if (merged.default_permissions) notes.push('default_permissions (named permission profiles) was not evaluated.');
  if (hooks) notes.push(`${hooks} PreToolUse / PermissionRequest hook(s) were not evaluated; they may block some of these steps.`);
  const requirements = [user && join(userDir, 'requirements.toml'), process.platform !== 'win32' && '/etc/codex/requirements.toml'].filter(Boolean);
  if (requirements.some((f) => existsSync(f))) notes.push('requirements.toml (admin-enforced limits) was not evaluated; it can only make these settings stricter.');
  if (unclassified.length) notes.push(`MCP servers not classified: ${unclassified.join(', ')}. Declare their legs in .trifecta.json.`);

  return {
    ctx,
    secrets: env.secrets,
    missingSecrets: env.missingSecrets,
    trust,
    sandbox,
    approval,
    reviewer,
    network,
    search,
    rules,
    servers,
    unclassified,
    notes,
    problems,
  };
}

const SAFE_READS = new Set(['cat', 'grep', 'rg', 'head', 'tail', 'ls', 'wc', 'type', 'Get-Content', 'Select-String']);

function evaluateShell(probe, leg, cfg) {
  const args = splitArgs(probe.command);
  const { policy, granular } = cfg.approval;
  const rule = strictestRule(cfg.rules, args);
  if (rule) {
    const where = `prefix_rule ${JSON.stringify(rule.pattern)} in ${rule.file}`;
    if (rule.decision === 'forbidden') return { guard: 'blocked', reason: `forbidden by ${where}` };
    if (rule.decision === 'prompt') {
      const silent = policy === 'never' || (policy === 'granular' && granular.rules === false);
      return silent
        ? { guard: 'blocked', reason: `${where} asks, and approval_policy never shows the prompt` }
        : { guard: 'human', reason: `${where} asks a person` };
    }
    return { guard: 'open', reason: `allowed by ${where}; it runs outside the sandbox` };
  }
  const net = leg !== 'private';
  if (policy === 'untrusted') {
    return SAFE_READS.has(args[0]) && !net
      ? { guard: 'open', reason: 'known-safe read commands run without approval in an untrusted project' }
      : { guard: 'human', reason: 'an untrusted project asks before anything but known-safe reads' };
  }
  const mode = cfg.sandbox.value;
  if (mode === 'danger-full-access') return { guard: 'open', reason: 'sandbox_mode = danger-full-access runs commands unsandboxed' };
  if (!net) return { guard: 'open', reason: `runs in the ${mode} sandbox, which can read the whole disk` };
  if (mode === 'workspace-write' && cfg.network) {
    return { guard: 'open', reason: 'sandbox_workspace_write.network_access = true lets sandboxed commands reach the network' };
  }
  // The sandbox has no network; what remains is whether Codex may ask to run it outside.
  if (policy === 'never') return { guard: 'blocked', reason: `the ${mode} sandbox has no network, and approval_policy = never never asks to leave it` };
  if (policy === 'granular' && !granular.sandbox_approval) {
    return { guard: 'blocked', reason: `the ${mode} sandbox has no network, and granular sandbox_approval is off` };
  }
  return { guard: 'human', reason: `the ${mode} sandbox has no network; running it outside needs approval` };
}

// Mirrors codex-rs/core/src/mcp_tool_call.rs: the mode defaults to auto, and auto and writes
// skip the prompt only for tools the server marks read-only.
function evaluateMcp(probe, leg, cfg) {
  const s = probe.srv.conf;
  const set = s.tools?.[probe.name]?.approval_mode ?? s.default_tools_approval_mode;
  const mode = set ?? 'auto';
  const named = set ? `approval_mode = ${mode}` : 'approval_mode unset (auto)';
  const { policy } = cfg.approval;
  if (mode === 'approve') return { guard: 'open', reason: `${named} for ${probe.server}` };
  if (policy === 'never' && cfg.sandbox.value === 'danger-full-access') {
    return { guard: 'open', reason: 'approval_policy = never with danger-full-access approves every MCP call' };
  }
  if (mode !== 'prompt' && leg !== 'send') {
    return { guard: 'open', reason: `${named} asks only for tools not marked read-only; ${probe.name} is assumed to be marked` };
  }
  if (policy === 'never') return { guard: 'blocked', reason: `${named} asks before ${probe.name}, and approval_policy = never denies it` };
  return { guard: 'human', reason: `${named} asks before ${probe.name}` };
}

const usableTool = (srv, name) => {
  const { enabled_tools: on, disabled_tools: off } = srv.conf;
  if (name === 'any_tool') return !Array.isArray(on) || on.length > 0;
  return (!Array.isArray(on) || on.includes(name)) && !(Array.isArray(off) && off.includes(name));
};

export function scanCodex(cfg) {
  const { ctx } = cfg;
  const evaluate = (probe, leg) => {
    if (probe.tool === 'web_search') return { guard: 'open', reason: `web_search = ${cfg.search.value} (${cfg.search.source})` };
    const verdict = probe.tool === 'mcp' ? evaluateMcp(probe, leg, cfg) : evaluateShell(probe, leg, cfg);
    if (verdict.guard !== 'human' || !/^(auto_review|guardian_subagent)$/.test(cfg.reviewer.value)) return verdict;
    return { guard: 'model', reason: `${verdict.reason}; approvals_reviewer = ${cfg.reviewer.value} lets a subagent answer` };
  };
  const show = (probe) => {
    if (probe.show) return probe.show;
    if (probe.tool === 'mcp') return `${probe.server}/${probe.name} (MCP)`;
    return probe.dir ? `${probe.command}  (in ${shortPath(probe.dir, ctx)})` : probe.command;
  };
  const { legs, add } = legBuilder(evaluate, show);
  const shell = (probes) => probes.filter((p) => p.tool !== 'Read');
  for (const s of cfg.secrets) add('private', s.id, s.label, shell(secretProbes(s, ctx, [ctx.cwd])));
  if (cfg.search.value !== 'disabled') add('untrusted', 'web_search', 'web_search', [{ tool: 'web_search', show: 'web_search <query>' }]);
  for (const item of SHELL_NETWORK_ITEMS) {
    for (const leg of ['untrusted', 'send']) if (item[leg]) add(leg, item.id, item.label, item[leg]);
  }
  for (const srv of cfg.servers) {
    for (const leg of LEGS) {
      const tools = (srv.legs[leg] ?? []).filter((name) => usableTool(srv, name));
      add(leg, `mcp:${srv.name}`, `MCP ${srv.name} (${srv.kind})`, tools.map((name) => ({ tool: 'mcp', server: srv.name, name, srv })));
    }
  }

  const approvalText = cfg.approval.policy === 'granular' ? 'granular' : cfg.approval.policy;
  return {
    platform: 'Codex',
    setup: [
      `sandbox: ${cfg.sandbox.value} (${cfg.sandbox.source})`,
      `approval: ${approvalText} (${cfg.approval.source})`,
      `project: ${cfg.trust.level} (${cfg.trust.source})`,
    ].join(' · '),
    agents: [{ name: 'codex', file: null, ...assess(legs) }],
    skills: [],
    unclassified: cfg.unclassified,
    notes: cfg.notes,
  };
}
