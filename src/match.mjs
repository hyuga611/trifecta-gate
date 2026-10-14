// Permission-rule matching, following Claude Code's documented semantics:
// https://code.claude.com/docs/en/permissions
// Paths are compared in POSIX form, as Claude Code does on Windows (C:\Users\a → /c/Users/a).

export function toPosix(p) {
  const s = String(p).replace(/\\/g, '/');
  const drive = /^([A-Za-z]):(\/|$)/.exec(s);
  return drive ? `/${drive[1].toLowerCase()}${s.slice(2)}` : s;
}

export function fromPosix(p) {
  const drive = process.platform === 'win32' && /^\/([a-z])(\/|$)/.exec(p);
  return drive ? `${drive[1]}:${p.slice(2) || '/'}` : p;
}

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export function underDir(path, dir, ctx) {
  const norm = (s) => (ctx.caseInsensitive ? s.toLowerCase() : s).replace(/\/+$/, '');
  return norm(path) === norm(dir) || norm(path).startsWith(`${norm(dir)}/`);
}

export function resolveDir(p, ctx) {
  if (p.startsWith('~/')) return ctx.home + p.slice(1);
  if (p.startsWith('//')) return p.slice(1);
  const posix = toPosix(p);
  return posix.startsWith('/') ? posix : `${ctx.cwd}/${posix.replace(/^\.\//, '')}`;
}

export function parseRule(raw) {
  const m = /^([^(]+?)(?:\((.*)\))?$/s.exec(String(raw).trim());
  return m ? { tool: m[1].trim(), body: m[2] } : { tool: String(raw), body: undefined };
}

export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const segmentStart = i === 0 || glob[i - 1] === '/';
      if (segmentStart && glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += escapeRe(c);
  }
  return re;
}

// `/path` is anchored at the settings source: ~/.claude for user settings, the project otherwise.
export function pathRuleRegex(body, kind, scope, ctx) {
  let pattern;
  if (body.startsWith('//')) pattern = body.slice(1);
  else if (body.startsWith('~/')) pattern = ctx.home + body.slice(1);
  else if (body.startsWith('/')) pattern = (scope === 'user' ? `${ctx.home}/.claude` : ctx.cwd) + body;
  else {
    const rel = body.replace(/^\.\//, '');
    const segments = rel.replace(/\/$/, '').split('/');
    const anyDepth = segments.length === 1 || (kind !== 'allow' && segments.length === 2 && segments[1] === '**');
    pattern = anyDepth ? `${ctx.cwd}/**/${rel}` : `${ctx.cwd}/${rel}`;
  }
  const dirTail = pattern.endsWith('/') ? '.*' : '';
  return new RegExp(`^${globToRegex(pattern)}${dirTail}$`, ctx.caseInsensitive ? 'i' : '');
}

export function commandRegex(body) {
  const b = body.endsWith(':*') ? `${body.slice(0, -2)} *` : body;
  const stars = b.split('*').length - 1;
  if (stars === 1 && b.endsWith(' *')) return new RegExp(`^${escapeRe(b.slice(0, -2))}(?: .*)?$`, 's');
  return new RegExp(`^${b.split('*').map(escapeRe).join('.*')}$`, 's');
}

export function domainMatches(pattern, host) {
  const p = pattern.trim().toLowerCase().replace(/\.$/, '');
  const h = host.toLowerCase().replace(/\.$/, '');
  if (p === '*') return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  return new RegExp(`^${p.split('*').map(escapeRe).join('[^.]*')}$`).test(h);
}

// https://code.claude.com/docs/en/hooks ("Matcher patterns")
export function matcherMatches(matcher, name) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (/^[\w\s,|-]*$/.test(matcher)) return matcher.split(/[|,]/).map((s) => s.trim()).includes(name);
  try {
    return new RegExp(matcher).test(name);
  } catch {
    return false;
  }
}

export const toolName = (probe) => (probe.tool === 'mcp' ? `mcp__${probe.server}__${probe.name}` : probe.tool);

function toolNameMatches(ruleTool, kind, probe) {
  const name = toolName(probe);
  if (!ruleTool.includes('*')) {
    return ruleTool === name || (probe.tool === 'mcp' && ruleTool === `mcp__${probe.server}`);
  }
  if (kind === 'allow' && !(probe.tool === 'mcp' && ruleTool.startsWith(`mcp__${probe.server}__`))) return false;
  return new RegExp(`^${ruleTool.split('*').map(escapeRe).join('.*')}$`).test(name);
}

// Does a rule cover this concrete tool call? `target` picks which part of a probe the
// rule is checked against: a `cat` probe is checked once as Bash and once as a Read.
export function ruleMatches(rule, kind, probe, ctx, target = probe.tool) {
  if (target === 'Read' && probe.tool !== 'Read') {
    if (rule.tool !== 'Read') return false;
    return rule.body === undefined || pathRuleRegex(rule.body, kind, rule.scope, ctx).test(probe.path);
  }
  if (!toolNameMatches(rule.tool, kind, probe)) return false;
  const { body } = rule;
  if (body === undefined) return true;
  if (probe.tool === 'mcp') return false;
  switch (probe.tool) {
    case 'Read':
      return pathRuleRegex(body, kind, rule.scope, ctx).test(probe.path);
    case 'Bash':
    case 'PowerShell':
      return commandRegex(body).test(probe.command);
    case 'WebFetch':
      return body.startsWith('domain:') && domainMatches(body.slice(7), probe.domain);
    default:
      return false;
  }
}

// Entering auto mode drops allow rules that grant arbitrary code execution.
// https://code.claude.com/docs/en/permission-modes ("How the classifier evaluates actions")
const INTERPRETER = /^(python\d*(\.\d+)?|node|deno|bun|ruby|perl|php|bash|sh|zsh|pwsh|powershell|cmd)\b/;
const RUNNER = /^((npm|pnpm|yarn|bun) (run|exec|x)|npx|pnpx|bunx)\b/;

export function droppedInAutoMode(rule) {
  if (rule.tool === 'Agent' || rule.tool === 'Monitor') return true;
  if (rule.tool !== 'Bash' && rule.tool !== 'PowerShell') return false;
  const body = rule.body?.trim();
  if (body === undefined || body === '*') return true;
  return body.includes('*') && (INTERPRETER.test(body) || RUNNER.test(body));
}

// Splits a command line into words, honouring quotes, the way a rule engine sees argv.
export const splitArgs = (command) =>
  [...command.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
