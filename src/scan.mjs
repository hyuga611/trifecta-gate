import { LEGS, NETWORK_ITEMS, classifyServer } from './catalog.mjs';
import { GUARDS, assess, legBuilder, rank, secretProbes, shortPath } from './legs.mjs';
import { droppedInAutoMode, matcherMatches, parseRule, ruleMatches, toolName, underDir } from './match.mjs';

export { GUARDS, rank };

const MODE_DEFAULT = {
  default: ['human', 'prompts in default mode'],
  acceptEdits: ['human', 'prompts in acceptEdits mode'],
  plan: ['human', 'prompts in plan mode'],
  auto: ['model', 'left to the auto-mode classifier'],
  dontAsk: ['blocked', 'dontAsk mode denies anything not allowed'],
  bypassPermissions: ['open', 'bypassPermissions mode skips prompts'],
};

const show = (probe, ctx) => {
  if (probe.show) return probe.show;
  if (probe.tool === 'Read') return `Read ${shortPath(probe.path, ctx)}`;
  if (probe.tool === 'mcp') return toolName(probe);
  return probe.dir ? `${probe.command}  (in ${shortPath(probe.dir, ctx)})` : probe.command;
};

const describe = (rule, kind) => `${kind} rule ${rule.raw} in ${rule.file}`;

export function evaluate(probe, config, extraAllow = []) {
  const { ctx, mode } = config;
  const targets = probe.named ? [probe.tool, 'Read'] : [probe.tool];
  const find = (rules, kind) => {
    for (const target of targets) {
      const hit = rules.find((r) => r.kind === kind && ruleMatches(r, kind, probe, ctx, target));
      if (hit) return hit;
    }
    return undefined;
  };

  const deny = find(config.rules, 'deny');
  if (deny) return { guard: 'blocked', reason: describe(deny, 'deny') };
  const ask = find(config.rules, 'ask');
  if (ask) return { guard: mode === 'dontAsk' ? 'blocked' : 'human', reason: describe(ask, 'ask') };
  const allowRules = [...config.rules, ...extraAllow].filter((r) => !(mode === 'auto' && droppedInAutoMode(r)));
  const allow = find(allowRules, 'allow');
  if (allow) return { guard: 'open', reason: describe(allow, 'allow') };

  // https://code.claude.com/docs/en/permissions ("Read-only commands") and
  // https://code.claude.com/docs/en/permission-modes ("The first read outside the working directories")
  if (probe.readOnly) {
    const at = probe.dir ?? probe.path;
    if (config.workingDirs.some((d) => underDir(at, d, ctx))) {
      return { guard: 'open', reason: 'reads inside a working directory need no approval' };
    }
    const shell = probe.tool !== 'Read';
    if (config.blockOutside) {
      return shell
        ? { guard: 'human', reason: 'blockReadsOutsideWorkingDirectories makes this prompt' }
        : { guard: 'blocked', reason: 'blockReadsOutsideWorkingDirectories' };
    }
    if (shell) return { guard: 'open', reason: 'read-only shell commands run without a prompt in every mode' };
    if (mode === 'auto' || mode === 'bypassPermissions') {
      return { guard: 'open', reason: `${mode} mode reads outside the working directories without a prompt` };
    }
    if (mode === 'dontAsk') return { guard: 'blocked', reason: 'dontAsk mode denies reads that would prompt' };
    return { guard: 'human', reason: 'reads outside the working directories prompt' };
  }
  const [guard, reason] = MODE_DEFAULT[mode] ?? MODE_DEFAULT.default;
  return { guard, reason };
}

function listed(list, probe) {
  const name = toolName(probe);
  return list.some((t) => {
    if (t === name || (probe.tool === 'Read' && t === 'Grep')) return true;
    if (probe.tool !== 'mcp') return false;
    if (t === `mcp__${probe.server}`) return true;
    return t.includes('*') && new RegExp(`^${t.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);
  });
}

const canCall = (agent, probe) =>
  !(agent.disallowedTools && listed(agent.disallowedTools, probe)) && (!agent.tools || listed(agent.tools, probe));

// The PreToolUse hooks that would be asked about this step. They are not run: what they
// decide is up to their code.
function hooksSeeing(probe, config) {
  const seen = config.hooks.filter((h) => {
    if (!matcherMatches(h.matcher, toolName(probe))) return false;
    if (!h.if) return true;
    const rule = { ...parseRule(h.if), scope: 'project' };
    return ruleMatches(rule, 'allow', probe, config.ctx);
  });
  return [...new Set(seen.map((h) => h.name))];
}

function buildLegs(config, servers, agent, extraAllow) {
  const { legs, add } = legBuilder(
    (probe) => ({
      ...evaluate(probe, config, extraAllow),
      ...(config.hooks.length && { hooks: hooksSeeing(probe, config) }),
    }),
    (probe) => show(probe, config.ctx),
  );
  const usable = (probes) => probes.filter((p) => canCall(agent, p));
  for (const s of config.secrets) add('private', s.id, s.label, usable(secretProbes(s, config.ctx, config.workingDirs)));
  for (const item of NETWORK_ITEMS) {
    for (const leg of ['untrusted', 'send']) if (item[leg]) add(leg, item.id, item.label, usable(item[leg]));
  }
  for (const srv of servers) {
    for (const leg of LEGS) {
      const tools = srv.legs[leg];
      if (tools) add(leg, `mcp:${srv.name}`, `MCP ${srv.name} (${srv.kind})`, usable(tools.map((name) => ({ tool: 'mcp', server: srv.name, name }))));
    }
  }
  return legs;
}

export function scan(config) {
  const declared = config.declared?.mcp ?? {};
  const servers = [];
  const unclassified = [];
  for (const srv of config.mcpServers) {
    const c = classifyServer(srv, declared);
    if (c) servers.push({ ...srv, ...c });
    else unclassified.push(srv.name);
  }

  const unit = (agent, extraAllow = []) => assess(buildLegs(config, servers, agent, extraAllow));

  const main = { name: 'main', file: null, ...unit({}) };
  const agents = [main, ...config.agents.map((a) => ({ name: a.name, file: a.file, ...unit(a) }))];

  const mainGuard = main.weakest ? rank(main.weakest.guard) : rank('blocked');
  const skills = [];
  for (const s of config.skills) {
    if (!s.allowedTools?.length) continue;
    const extra = s.allowedTools.map((raw) => ({ raw, ...parseRule(raw), kind: 'allow', scope: 'skill', file: s.file }));
    const r = unit({}, extra);
    if (r.weakest && rank(r.weakest.guard) < mainGuard) skills.push({ name: s.name, file: s.file, ...r });
  }

  const notes = [];
  if (config.hooks.length) {
    notes.push(
      `${config.hooks.length} PreToolUse hook(s) were not run; each step names the ones that see it. ` +
        'A hook can block a step it sees, and one that answers "allow" skips the prompt.',
    );
  }
  if (config.user) {
    notes.push('claude.ai connectors and plugin MCP servers are not in local files and were not evaluated.');
  }
  if (config.sandbox) notes.push('The sandbox is enabled; Bash network steps may be stricter than shown.');
  if (unclassified.length) {
    notes.push(`MCP servers not classified: ${unclassified.join(', ')}. Declare their legs in .trifecta.json.`);
  }

  return {
    platform: 'Claude Code',
    setup: `mode: ${config.mode} (${config.modeSource})`,
    mode: config.mode,
    modeSource: config.modeSource,
    agents,
    skills,
    unclassified,
    notes,
  };
}
