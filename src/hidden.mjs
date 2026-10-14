import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { context, isDir, shownPath } from './load.mjs';

// The "untrusted content" leg read from the inside: a repository's own instruction files
// are text an agent treats as direction, so an attacker who lands a commit can hide a
// command there — invisible to a human reviewer, plain to the model. This finds such text
// in the files agents read as instructions. It reads them only; nothing is decoded as code.

const INSTRUCTION_EXT = new Set(['.md', '.mdc', '.markdown', '.txt']);
const ROOT_FILES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules']);
const PRUNE = new Set(['.git', 'node_modules', 'vendor', 'target', 'dist', 'build', 'out', '.next', 'coverage', '.venv', 'venv']);

// Top-level directories whose prose an agent loads as direction. The scan stays within
// these and the root-level files below; it does not hunt for nested CLAUDE.md files deep in
// the source tree, where a match would more often be a fixture or vendored sample than an
// instruction the agents in this project actually read.
const CONFIG_DIRS = ['.claude', '.agents', '.codex', '.cursor', '.github'];

const isInstructionFile = (rel) => {
  const ext = extname(rel).toLowerCase();
  if (rel === '.github/copilot-instructions.md') return true;
  if (/^\.github\/ISSUE_TEMPLATE\//.test(rel) && (INSTRUCTION_EXT.has(ext) || ext === '.yml' || ext === '.yaml')) return true;
  if (/^\.github\/PULL_REQUEST_TEMPLATE/.test(rel)) return true;
  if (/^\.(claude|agents|codex)\//.test(rel) && INSTRUCTION_EXT.has(ext)) return true;
  if (/^\.cursor\/rules\//.test(rel) && INSTRUCTION_EXT.has(ext)) return true;
  return false;
};

function collectFiles(root) {
  const files = [];
  let top;
  try {
    top = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of top) if (e.isFile() && ROOT_FILES.has(e.name)) files.push(join(root, e.name));

  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!PRUNE.has(e.name)) walk(join(dir, e.name), childRel);
      } else if (isInstructionFile(childRel)) {
        files.push(join(dir, e.name));
      }
    }
  };
  for (const d of CONFIG_DIRS) if (isDir(join(root, d))) walk(join(root, d), d);
  return files;
}

const lineStarts = (text) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
};

const lineAt = (starts, idx) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};

const HIDDEN_RANGES = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];
const isHiddenCp = (cp) => (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || HIDDEN_RANGES.some(([a, b]) => cp >= a && cp <= b);

// Reveals only the invisible and control code points as \u{...}; ordinary text, including
// Japanese and emoji, is left readable so the excerpt still reads as what the author wrote.
const escapeHidden = (s) =>
  [...s]
    .map((ch) => {
      const cp = ch.codePointAt(0);
      if (cp === 0x09) return '\\t';
      if (cp === 0x0a || cp === 0x0d) return ' ';
      return isHiddenCp(cp) ? `\\u{${cp.toString(16).toUpperCase()}}` : ch;
    })
    .join('');

const clip = (s, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

// A zero-width joiner between two pictographs builds one emoji; that use is legitimate.
const isEmoji = (cp) =>
  cp >= 0x1f000 ||
  (cp >= 0x2600 && cp <= 0x27bf) ||
  (cp >= 0x2300 && cp <= 0x23ff) ||
  cp === 0xfe0f ||
  (cp >= 0x1f1e6 && cp <= 0x1f1ff) ||
  (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
  cp === 0x2640 ||
  cp === 0x2642;

const cpBefore = (text, i) => {
  if (i === 0) return 0;
  const lead = text.charCodeAt(i - 1);
  return lead >= 0xdc00 && lead <= 0xdfff && i >= 2 ? text.codePointAt(i - 2) : lead;
};
const cpAfter = (text, i) => (i + 1 < text.length ? text.codePointAt(i + 1) : 0);
const emojiJoiner = (text, i) => isEmoji(cpBefore(text, i)) || isEmoji(cpAfter(text, i));

// Fenced ``` / ~~~ blocks and inline `code` are examples a human reader sees, so they are
// masked to spaces (offsets preserved) before the prose detectors run.
function maskCode(text) {
  const lines = text.split('\n');
  let fence = '';
  return lines
    .map((line) => {
      const open = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (open && line.trim().startsWith(fence)) fence = '';
        return ' '.repeat(line.length);
      }
      if (open) {
        fence = open[1][0].repeat(3);
        return ' '.repeat(line.length);
      }
      return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
    })
    .join('\n');
}

const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// Phrases that read as an instruction aimed at the agent rather than at a human reader.
const AI = /\b(a\.?i\.?|assistant|agent|model|llm|claude|copilot|cursor|codex|chat\s*gpt|gpt-?\d*|gemini)\b/i;
const OVERRIDE = /\b(ignore|disregard|forget|override)\b.{0,48}\b(previous|above|prior|earlier|all|these|the\s+(above|following)|your)\b.{0,32}\b(instruction|prompt|direction|rule|message|context|guideline)/is;
const SYSTEM_PROMPT = /\b(system\s*prompt|developer\s*(message|prompt)|initial\s+instructions|reveal\s+your\s+prompt|print\s+your\s+(system\s+)?prompt)\b/i;
const EXFIL = /\b(exfiltrat\w*|leak)\b/i;
const SECRECY = /\b(do\s*not|don'?t|never)\b.{0,32}\b(tell|mention|reveal|disclose|inform|notify|warn|say)\b/i;
const ACTION = /\b(send|post|upload|email|mail|transmit|forward|fetch|curl|wget|read|cat|print|output|reveal|disclose|include|copy)\b/i;
const TARGET = /(\.env\b|\benv\s*(file|var)|\bsecret|\btoken|\bcredential|\bpassword|\bapi[_\s-]?key|\bprivate\s*key|\.ssh\b|\bssh\s*key|\baccess\s*key|\bauth\s*token)/i;

function injectionReason(text) {
  if (OVERRIDE.test(text)) return 'tells the agent to ignore its instructions';
  if (SYSTEM_PROMPT.test(text)) return 'asks for the system prompt';
  if (EXFIL.test(text)) return 'names exfiltration';
  if (SECRECY.test(text) && (AI.test(text) || TARGET.test(text))) return 'tells the agent to keep something from the user';
  if (AI.test(text) && ACTION.test(text) && TARGET.test(text)) return 'directs the agent to move a secret';
  return null;
}

function scanChars(text, starts, add) {
  for (const m of text.matchAll(/[\u{E0000}-\u{E007F}]+/gu)) {
    let decoded = '';
    for (const ch of m[0]) {
      const cp = ch.codePointAt(0);
      if (cp >= 0xe0020 && cp <= 0xe007e) decoded += String.fromCharCode(cp - 0xe0000);
    }
    add({
      line: lineAt(starts, m.index),
      kind: 'tag',
      label: `${[...m[0]].length} Unicode tag character(s) hiding ASCII text`,
      detail: decoded ? `decodes to: ${escapeHidden(decoded)}` : '',
      excerpt: escapeHidden(m[0]),
    });
  }

  const byLine = new Map();
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp > 0xffff) i++;
    let cat = null;
    if (cp === 0xfeff) cat = i === 0 ? null : 'byte order mark mid-file';
    else if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) cat = 'bidirectional control character';
    else if (cp === 0x200d) cat = emojiJoiner(text, i) ? null : 'zero-width character';
    else if ((cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2060 && cp <= 0x2064)) cat = 'zero-width character';
    if (!cat) continue;
    const line = lineAt(starts, i);
    const key = `${line}\u0000${cat}`;
    if (!byLine.has(key)) byLine.set(key, { line, cat, count: 0, first: i });
    byLine.get(key).count++;
  }
  for (const { line, cat, count, first } of byLine.values()) {
    const start = starts[line - 1];
    const end = text.indexOf('\n', start);
    add({
      line,
      kind: cat === 'byte order mark mid-file' ? 'bom' : cat.startsWith('bidi') ? 'bidi' : 'zero-width',
      label: count > 1 ? `${count} ${cat}s` : cat,
      detail: '',
      excerpt: escapeHidden(text.slice(start, end === -1 ? undefined : end)),
    });
  }
}

function scanComments(masked, starts, add) {
  for (const m of masked.matchAll(/<!--([\s\S]*?)-->/g)) {
    const reason = injectionReason(m[1]);
    if (reason) {
      add({
        line: lineAt(starts, m.index),
        kind: 'comment',
        label: `HTML comment that ${reason}`,
        detail: '',
        excerpt: escapeHidden(clip(m[1].trim().replace(/\s+/g, ' '))),
      });
    }
  }
}

const HIDDEN_STYLE = /style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0)[^"']*["']/i;

function scanHiddenHtml(masked, starts, add) {
  const re = /<([a-z][\w-]*)\b([^>]*)>([\s\S]{0,600}?)<\/\1\s*>/gi;
  for (const m of masked.matchAll(re)) {
    const attrs = m[2];
    if (!HIDDEN_STYLE.test(attrs) && !/\shidden(\s|=|$)/i.test(attrs)) continue;
    const inner = stripTags(m[3]);
    const reason = injectionReason(inner);
    if (reason) {
      add({
        line: lineAt(starts, m.index),
        kind: 'hidden-html',
        label: `hidden <${m[1]}> whose text ${reason}`,
        detail: '',
        excerpt: escapeHidden(clip(inner)),
      });
    }
  }
}

// Query keys and placeholders that mean the link is carrying data out, not fetching a page.
const EXFIL_QUERY = /[?&#](secret|secrets|token|apikey|api_key|env|dotenv|payload|creds?|credential|password|pwd|leak|exfil|data)=/i;
const EXFIL_PLACEHOLDER = /\$\{|\{\{|%[A-Z][A-Z0-9_]*%|\{secret|<secret|\[secret|\.env\b|\.ssh\b|id_(rsa|ed25519|ecdsa)/i;

function scanExfilLinks(masked, starts, add) {
  for (const m of masked.matchAll(/(!?)\[[^\]]*\]\(\s*(<?)([^)\s>]+)/g)) {
    const url = m[3];
    if (!/^(https?:)?\/\//i.test(url)) continue;
    const q = url.includes('?') || url.includes('#') ? url.slice(Math.min(...[url.indexOf('?'), url.indexOf('#')].filter((i) => i >= 0))) : '';
    if (!EXFIL_QUERY.test(q) && !EXFIL_PLACEHOLDER.test(url)) continue;
    add({
      line: lineAt(starts, m.index),
      kind: 'exfil-link',
      label: `${m[1] ? 'image' : 'link'} to an external URL that carries data in its query`,
      detail: clip(url, 120),
      excerpt: escapeHidden(clip(url, 160)),
    });
  }
}

const SINK = /https?:\/\/|\bcurl\b|\bwget\b|\bnc\b/i;

// A base64 blob is unreadable to a human reviewer, so it is checked wherever it appears;
// the decoded text must read as an injection, not merely mention a keyword, to count.
function base64Reason(decoded) {
  return injectionReason(decoded) || (ACTION.test(decoded) && TARGET.test(decoded) && SINK.test(decoded) ? 'decodes to a command that sends a secret out' : null);
}

function scanBase64(text, starts, add) {
  for (const m of text.matchAll(/[A-Za-z0-9+/]{32,}={0,2}/g)) {
    const blob = m[0];
    if (blob.length % 4 !== 0) continue;
    let bytes;
    try {
      bytes = Buffer.from(blob, 'base64');
    } catch {
      continue;
    }
    if (bytes.length < 12) continue;
    const printable = bytes.reduce((n, b) => n + (b === 9 || b === 10 || b === 13 || (b >= 0x20 && b <= 0x7e) ? 1 : 0), 0);
    if (printable / bytes.length < 0.9) continue;
    const decoded = bytes.toString('utf8');
    const reason = base64Reason(decoded);
    if (!reason) continue;
    add({
      line: lineAt(starts, m.index),
      kind: 'base64',
      label: `base64 that ${reason}`,
      detail: `decodes to: ${escapeHidden(clip(decoded, 120))}`,
      excerpt: escapeHidden(clip(decoded)),
    });
  }
}

function scanText(text) {
  const starts = lineStarts(text);
  const masked = maskCode(text);
  const findings = [];
  const add = (f) => findings.push(f);
  scanChars(text, starts, add);
  scanComments(masked, starts, add);
  scanHiddenHtml(masked, starts, add);
  scanExfilLinks(masked, starts, add);
  scanBase64(text, starts, add);
  return findings;
}

export function scanHidden({ root = '.' } = {}) {
  const { ctx } = context({ root });
  const files = collectFiles(root).sort();
  const findings = [];
  for (const file of files) {
    let text;
    try {
      if (statSync(file).size > 4 * 1024 * 1024) continue;
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const shown = shownPath(file, ctx);
    for (const f of scanText(text)) findings.push({ file: shown, ...f });
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { scanned: files.length, findings };
}

export { scanText };
