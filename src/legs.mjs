import { LEGS } from './catalog.mjs';
import { underDir } from './match.mjs';

// What stands between an injected agent and one step, weakest first.
export const GUARDS = ['open', 'model', 'human', 'blocked'];
export const rank = (g) => GUARDS.indexOf(g);

// Weaker first; between equals, the one fewer hooks see, since an attacker would pick it.
const weaker = (a, b) => rank(a.guard) - rank(b.guard) || (a.hooks?.length ?? 0) - (b.hooks?.length ?? 0);

// Collects, for each leg, the weakest way to take each item. `evaluate` returns
// { guard, reason, hooks? } for one probe, and `show` renders the probe for the report.
export function legBuilder(evaluate, show) {
  const legs = Object.fromEntries(LEGS.map((l) => [l, []]));
  const add = (leg, id, label, probes) => {
    if (!probes.length) return;
    const best = probes
      .map((probe) => ({ probe, ...evaluate(probe, leg) }))
      .reduce((a, b) => (weaker(b, a) < 0 ? b : a));
    legs[leg].push({ id, label, guard: best.guard, via: show(best.probe), reason: best.reason, ...(best.hooks && { hooks: best.hooks }) });
  };
  return { legs, add };
}

// A path is one item from each leg; it is as strong as its strongest step.
export function assess(legs) {
  const counts = { open: 0, model: 0, human: 0 };
  const live = (leg) => legs[leg].filter((i) => i.guard !== 'blocked');
  for (const a of live('private')) {
    for (const b of live('untrusted')) {
      for (const c of live('send')) counts[GUARDS[Math.max(rank(a.guard), rank(b.guard), rank(c.guard))]]++;
    }
  }
  const weakestOf = (leg) => live(leg).reduce((x, y) => (x && weaker(x, y) <= 0 ? x : y), undefined);
  const steps = LEGS.map(weakestOf);
  const weakest = steps.every(Boolean) ? { guard: GUARDS[Math.max(...steps.map((s) => rank(s.guard)))], steps } : null;
  return { legs, counts, weakest };
}

export const shortPath = (path, ctx) => {
  if (underDir(path, ctx.cwd, ctx) && ctx.cwd !== ctx.home) return `.${path.slice(ctx.cwd.length)}`;
  return underDir(path, ctx.home, ctx) ? `~${path.slice(ctx.home.length)}` : path;
};

// The ways an injected agent would read one secret, from the most to the least visible.
export function secretProbes(secret, ctx, workingDirs) {
  const { path } = secret;
  const shown = shortPath(path, ctx);
  const probes = [
    { tool: 'Read', path, readOnly: true },
    { tool: 'Bash', command: `cat ${shown}`, path, named: true, readOnly: true },
    { tool: 'Bash', command: `node -e "process.stdout.write(require('fs').readFileSync('${shown}'))"`, path },
  ];
  // A read that never names the file is outside the reach of rules on file paths.
  const dir = workingDirs.find((d) => underDir(path, d, ctx));
  if (dir) probes.push({ tool: 'Bash', command: 'grep -r . .', dir, path, readOnly: true });
  return probes;
}
