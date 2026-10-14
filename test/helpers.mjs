import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Lays out a project and a home in a fresh temp directory, so the real ~ never leaks in.
// Keys starting with "~/" go under the home; the rest under the project. `files` may be a
// function of { root, home }, for configs that name the project's own path.
export function withFiles(files, fn) {
  const base = mkdtempSync(join(tmpdir(), 'trifecta-'));
  const root = join(base, 'repo');
  const home = join(base, 'home');
  const entries = typeof files === 'function' ? files({ root, home }) : files;
  for (const [name, body] of Object.entries(entries)) {
    const file = name.startsWith('~/') ? join(home, name.slice(2)) : join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  try {
    return fn({ base, root, home });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export const unit = (r, name) => [...r.agents, ...r.skills].find((u) => u.name === name);
export const weakest = (r, name) => unit(r, name).weakest?.guard ?? 'broken';
export const step = (r, name, leg) => unit(r, name).weakest.steps[['private', 'untrusted', 'send'].indexOf(leg)];
