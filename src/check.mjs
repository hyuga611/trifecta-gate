#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LEGS, LEG_TITLES } from './catalog.mjs';
import { loadCodex, scanCodex } from './codex.mjs';
import { CURSOR_MODES, loadCursor, scanCursor } from './cursor.mjs';
import { GUARDS, rank } from './legs.mjs';
import { loadConfig } from './load.mjs';
import { scan } from './scan.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `trifecta-gate ${VERSION} — can one agent read a secret, read an attacker's text, and send data out?

Usage: trifecta-gate [dir] [options]

Reads the agent configuration of a project (and with --user, your own) for Claude Code,
Codex and Cursor, and finds every agent that holds all three legs of the lethal trifecta.
Nothing is sent anywhere.

Options:
  --user                 also read your own configuration: ~/.claude, ~/.claude.json,
                         ~/.codex and ~/.cursor. Secrets count only if they exist on disk.
  --mode <mode>          Claude Code permission mode to assume
                         (default: what the settings would start in)
  --cursor-mode <mode>   Cursor IDE Run Mode: ${CURSOR_MODES.join(' | ')}
                         (default: with --user, what Cursor's settings say; otherwise
                         auto-review, the default of a new install)
  --fail-on <guard>      fail when a path is guarded by no more than this: open | model | human
                         (default: open — fail only when nothing stops the whole path)
  --json                 print the result as JSON
  --verbose              list every item on every leg
  -h, --help             show this help
  -v, --version          show the version

Guards, weakest first:
  open     nothing stops the step
  model    only a model reviews it (Claude Code's auto mode, Cursor's auto-review)
  human    a permission prompt asks a person
  blocked  a rule, the sandbox or a setting refuses the step

Exit codes: 0 pass, 1 a path at or below --fail-on exists, 2 usage error or unreadable configuration.`;

export function parseArgs(argv) {
  const opts = { root: '.', user: false, mode: undefined, cursorMode: undefined, failOn: 'open', json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--user') opts.user = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--mode') opts.mode = value();
    else if (a === '--cursor-mode') opts.cursorMode = value();
    else if (a === '--fail-on') opts.failOn = value();
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else opts.root = a;
  }
  if (!['open', 'model', 'human'].includes(opts.failOn)) {
    throw new Error(`--fail-on must be open, model or human (got "${opts.failOn}")`);
  }
  if (opts.cursorMode !== undefined && !CURSOR_MODES.includes(opts.cursorMode)) {
    throw new Error(`--cursor-mode must be ${CURSOR_MODES.join(', ')} (got "${opts.cursorMode}")`);
  }
  return opts;
}

const GUARD_TEXT = {
  open: 'nothing stops it',
  model: 'only a model reviews it',
  human: 'a person is asked',
  blocked: 'refused',
};

// "private data 2 open · untrusted content 4 model": how each leg can be taken.
function legSummary(unit) {
  return LEGS.map((leg) => {
    const live = unit.legs[leg].filter((i) => i.guard !== 'blocked');
    const parts = GUARDS.filter((g) => g !== 'blocked')
      .map((g) => [g, live.filter((i) => i.guard === g).length])
      .filter(([, n]) => n)
      .map(([g, n]) => `${n} ${g}`);
    return `${LEG_TITLES[leg]} ${parts.join(', ') || 'none'}`;
  }).join(' · ');
}

function formatUnit(unit, failOn, verbose) {
  const lines = [];
  const where = `${unit.file ? ` (${unit.file})` : ''}${unit.mode ? ` [in ${unit.mode} mode]` : ''}`;
  const { weakest } = unit;
  if (!weakest) {
    const missing = LEGS.filter((l) => !unit.legs[l].some((i) => i.guard !== 'blocked')).map((l) => LEG_TITLES[l]);
    lines.push(`  ok    ${unit.name}${where}: no ${missing.join(', ')} — the trifecta is broken`);
  } else {
    const fails = rank(weakest.guard) <= rank(failOn);
    lines.push(`  ${fails ? 'FAIL' : 'ok  '}  ${unit.name}${where}: ${legSummary(unit)}`);
    lines.push(`        weakest path — ${GUARD_TEXT[weakest.guard]}:`);
    LEGS.forEach((leg, i) => {
      const s = weakest.steps[i];
      lines.push(`          ${LEG_TITLES[leg].padEnd(18)} ${s.guard.padEnd(6)} ${s.via}`);
      lines.push(`          ${''.padEnd(18)} ${''.padEnd(6)} ↳ ${s.reason}`);
      if (s.hooks) {
        const seen = s.hooks.length ? `hooks that see it (not run): ${s.hooks.join(', ')}` : 'no hook sees this step';
        lines.push(`          ${''.padEnd(18)} ${''.padEnd(6)} ↳ ${seen}`);
      }
    });
  }
  if (verbose) {
    for (const leg of LEGS) {
      lines.push(`        ${LEG_TITLES[leg]}:`);
      if (!unit.legs[leg].length) lines.push('          (nothing)');
      for (const it of unit.legs[leg]) {
        const hooks = it.hooks?.length ? ` [hooks: ${it.hooks.join(', ')}]` : '';
        lines.push(`          ${it.guard.padEnd(7)} ${it.label} — ${it.via} (${it.reason})${hooks}`);
      }
    }
  }
  return lines;
}

export function formatReport(result, opts) {
  const out = [`trifecta-gate ${VERSION}`];
  for (const p of result.platforms) {
    out.push('', `${p.platform} — ${p.setup}`);
    for (const unit of p.agents) out.push(...formatUnit(unit, opts.failOn, opts.verbose));
    if (p.skills.length) {
      out.push('  skills whose allowed-tools open a weaker path while they run:');
      for (const unit of p.skills) out.push(...formatUnit(unit, opts.failOn, opts.verbose));
    }
    out.push(...p.notes.map((n) => `  note: ${n}`));
  }
  if (result.notes.length) out.push('', ...result.notes.map((n) => `note: ${n}`));
  return out.join('\n');
}

export function failed(result, failOn) {
  return result.platforms.some((p) => [...p.agents, ...p.skills].some((u) => u.weakest && rank(u.weakest.guard) <= rank(failOn)));
}

export function run(opts) {
  const { root, user } = opts;
  const claude = loadConfig({ root, user, mode: opts.mode });
  const codex = loadCodex({ root, user });
  const cursor = loadCursor({ root, user, mode: opts.cursorMode });
  const problems = [claude, codex, cursor].flatMap((c) => c?.problems ?? []);
  const platforms = [scan(claude), ...(codex ? [scanCodex(codex)] : []), ...(cursor ? [scanCursor(cursor)] : [])];
  const notes = [];
  if (user && claude.missingSecrets.length) {
    notes.push(`Only secrets that exist on disk were counted. Not found: ${claude.missingSecrets.join(', ')}.`);
  }
  return { problems, result: { platforms, notes } };
}

export function main(argv, io = { log: console.log, error: console.error }) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    io.error(`trifecta-gate: ${e.message}\nRun trifecta-gate --help for usage.`);
    return 2;
  }
  if (opts.help) return io.log(HELP), 0;
  if (opts.version) return io.log(VERSION), 0;

  let outcome;
  try {
    outcome = run(opts);
  } catch (e) {
    io.error(`trifecta-gate: ${e.message}`);
    return 2;
  }
  for (const p of outcome.problems) io.error(`trifecta-gate: could not read ${p}`);
  if (outcome.problems.length) return 2;

  const { result } = outcome;
  const fail = failed(result, opts.failOn);
  if (opts.json) io.log(JSON.stringify({ version: VERSION, failOn: opts.failOn, failed: fail, ...result }, null, 2));
  else io.log(formatReport(result, opts));
  return fail ? 1 : 0;
}

export { GUARDS };

// npm i -g and npx call the bin through a symlink, so compare resolved paths.
function runDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
}

if (runDirectly()) process.exit(main(process.argv.slice(2)));
