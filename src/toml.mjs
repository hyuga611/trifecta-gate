// A small TOML reader, enough for Codex's config.toml: tables, arrays of tables, dotted and
// quoted keys, strings (basic, literal, multi-line), numbers, booleans, dates, arrays and
// inline tables. https://toml.io/en/v1.0.0

export function parseToml(text) {
  const src = text.replace(/^﻿/, '');
  let i = 0;
  const root = {};
  let table = root;

  const fail = (msg) => {
    const line = src.slice(0, i).split('\n').length;
    throw new Error(`TOML line ${line}: ${msg}`);
  };
  const skipSpace = () => {
    while (src[i] === ' ' || src[i] === '\t') i++;
  };
  const skipComment = () => {
    if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
  };
  const skipBlank = () => {
    for (;;) {
      skipSpace();
      skipComment();
      if (src[i] === '\n' || src[i] === '\r') i++;
      else return;
    }
  };
  const endOfLine = () => {
    skipSpace();
    skipComment();
    if (i < src.length && src[i] !== '\n' && src[i] !== '\r') fail(`unexpected "${src[i]}"`);
  };

  const ESC = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
  function basicString() {
    const multi = src.startsWith('"""', i);
    i += multi ? 3 : 1;
    if (multi && src[i] === '\n') i++;
    else if (multi && src.startsWith('\r\n', i)) i += 2;
    let out = '';
    for (;;) {
      if (i >= src.length) fail('unterminated string');
      if (multi ? src.startsWith('"""', i) && src[i + 3] !== '"' : src[i] === '"') {
        i += multi ? 3 : 1;
        return out;
      }
      const c = src[i++];
      if (c === '\n' && !multi) fail('newline in string');
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = src[i++];
      if (e in ESC) out += ESC[e];
      else if (e === 'u' || e === 'U') {
        const n = e === 'u' ? 4 : 8;
        out += String.fromCodePoint(parseInt(src.slice(i, i + n), 16));
        i += n;
      } else if (multi && /\s/.test(e)) {
        while (/\s/.test(src[i] ?? '')) i++;
      } else fail(`bad escape \\${e}`);
    }
  }
  function literalString() {
    const multi = src.startsWith("'''", i);
    i += multi ? 3 : 1;
    if (multi && src[i] === '\n') i++;
    else if (multi && src.startsWith('\r\n', i)) i += 2;
    const end = src.indexOf(multi ? "'''" : "'", i);
    if (end < 0) fail('unterminated string');
    const out = src.slice(i, end);
    if (!multi && out.includes('\n')) fail('newline in string');
    i = end + (multi ? 3 : 1);
    return out;
  }

  function key() {
    const parts = [];
    for (;;) {
      skipSpace();
      if (src[i] === '"') parts.push(basicString());
      else if (src[i] === "'") parts.push(literalString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 256));
        if (!m) fail('expected a key');
        parts.push(m[0]);
        i += m[0].length;
      }
      skipSpace();
      if (src[i] !== '.') return parts;
      i++;
    }
  }

  function value() {
    skipSpace();
    const c = src[i];
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        skipBlank();
        if (src[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value());
        skipBlank();
        if (src[i] === ',') i++;
        else if (src[i] !== ']') fail('expected , or ] in array');
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      skipSpace();
      if (src[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        const k = key();
        if (src[i] !== '=') fail('expected =');
        i++;
        assign(obj, k, value());
        skipSpace();
        if (src[i] === ',') i++;
        else if (src[i] === '}') {
          i++;
          return obj;
        } else fail('expected , or } in inline table');
      }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i, i + 64));
    if (!m) fail('expected a value');
    let word = m[0];
    // A date-time may carry a space between the date and the time.
    const dt = /^ \d{2}:\d{2}/.exec(src.slice(i + word.length, i + word.length + 6));
    if (/^\d{4}-\d{2}-\d{2}$/.test(word) && dt) word += src.slice(i + word.length).match(/^ [^\s,\]}#]+/)[0];
    i += word.length;
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (/^\d{4}-\d{2}-\d{2}/.test(word) || /^\d{2}:\d{2}/.test(word)) return word;
    const num = Number(word.replace(/_/g, '').replace(/^([+-]?)inf$/, '$1Infinity'));
    if (Number.isNaN(num) && !/nan$/.test(word)) fail(`bad value "${word}"`);
    return num;
  }

  function assign(obj, parts, v) {
    let t = obj;
    for (const p of parts.slice(0, -1)) {
      if (t[p] === undefined) t[p] = {};
      t = t[p];
      if (typeof t !== 'object' || Array.isArray(t)) fail(`key ${parts.join('.')} conflicts with a value`);
    }
    t[parts.at(-1)] = v;
  }

  function header() {
    const many = src.startsWith('[[', i);
    i += many ? 2 : 1;
    const parts = key();
    if (!src.startsWith(many ? ']]' : ']', i)) fail('unterminated table header');
    i += many ? 2 : 1;
    let t = root;
    parts.forEach((p, n) => {
      const last = n === parts.length - 1;
      if (last && many) {
        if (t[p] === undefined) t[p] = [];
        const next = {};
        t[p].push(next);
        t = next;
        return;
      }
      if (t[p] === undefined) t[p] = {};
      t = Array.isArray(t[p]) ? t[p].at(-1) : t[p];
    });
    return t;
  }

  for (;;) {
    skipBlank();
    if (i >= src.length) return root;
    if (src[i] === '[') table = header();
    else {
      const k = key();
      if (src[i] !== '=') fail('expected =');
      i++;
      assign(table, k, value());
    }
    endOfLine();
  }
}
