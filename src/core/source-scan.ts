/**
 * Lexical helpers for reading test source in five language families without a parser: blank
 * comments (and optionally string bodies) while keeping every offset and line number, and match
 * brackets. A commented-out assertion must never count, and a quote inside a string must not
 * fool a bracket matcher. Spec: specs/capabilities/test-strength.md
 */

export type SourceLanguage = 'js' | 'python' | 'go' | 'rust' | 'jvm';

export interface ScannedSource {
  /** Comments replaced by spaces; strings intact. Same length and newlines as the input. */
  clean: string;
  /** `clean` with string bodies also blanked (quotes kept): safe for bracket matching and keyword search. */
  skeleton: string;
  /** Offset of the first character of each line (index 0 is line 1). */
  lineStarts: number[];
}

interface Syntax {
  line: string[];
  block: boolean;
  nestedBlock: boolean;
  triple: boolean;
  backtick: 'template' | 'raw' | 'none';
  apos: 'string' | 'char' | 'rust';
  rustRaw: boolean;
  /** strings may continue past a newline */
  multilineStrings: boolean;
  /** `/.../` regular expression literals */
  regex: boolean;
}

const SYNTAX: Record<SourceLanguage, Syntax> = {
  js: { line: ['//'], block: true, nestedBlock: false, triple: false, backtick: 'template', apos: 'string', rustRaw: false, multilineStrings: false, regex: true },
  python: { line: ['#'], block: false, nestedBlock: false, triple: true, backtick: 'none', apos: 'string', rustRaw: false, multilineStrings: false, regex: false },
  go: { line: ['//'], block: true, nestedBlock: false, triple: false, backtick: 'raw', apos: 'char', rustRaw: false, multilineStrings: false, regex: false },
  rust: { line: ['//'], block: true, nestedBlock: true, triple: false, backtick: 'none', apos: 'rust', rustRaw: true, multilineStrings: true, regex: false },
  jvm: { line: ['//'], block: true, nestedBlock: false, triple: true, backtick: 'none', apos: 'char', rustRaw: false, multilineStrings: false, regex: false },
};

const RUST_CHAR = /'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]+\}|.)|[^\\'\n])'/y;
const RUST_RAW = /b?r(#*)"/y;

/** Replace every character except newlines with a space. */
const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

/** Index just past the end of a JS template literal that starts at `i` (a backtick), `${}` nesting included. */
function templateEnd(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') j += 2;
    else if (c === '`') return j + 1;
    else if (c === '$' && s[j + 1] === '{') j = exprEnd(s, j + 2);
    else j += 1;
  }
  return s.length;
}

function exprEnd(s: string, start: number): number {
  let depth = 1;
  let j = start;
  while (j < s.length) {
    const c = s[j];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return j + 1;
    } else if (c === '`') {
      j = templateEnd(s, j);
      continue;
    } else if (c === '"' || c === "'") {
      j += 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
    }
    j += 1;
  }
  return s.length;
}

const REGEX_AFTER_WORD = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|await|yield|else|do)$/;

/** Does a `/` at `i` open a regex literal (rather than divide)? Judged by the previous token. */
function regexAllowed(source: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /[ \t]/.test(source[j]!)) j -= 1;
  if (j < 0 || source[j] === '\n') return true;
  if ('(,=:[!&|?{;+-*%<>~^'.includes(source[j]!)) return true;
  return REGEX_AFTER_WORD.test(source.slice(Math.max(0, j - 10), j + 1));
}

/** Index just past the regex literal (flags included) starting at `i`, or -1 when the line holds no closing slash. */
function regexEnd(source: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < source.length && source[j] !== '\n') {
    const c = source[j];
    if (c === '\\') j += 2;
    else if (c === '[') {
      inClass = true;
      j += 1;
    } else if (c === ']') {
      inClass = false;
      j += 1;
    } else if (c === '/' && !inClass) {
      j += 1;
      while (j < source.length && /[a-z]/i.test(source[j]!)) j += 1;
      return j;
    } else j += 1;
  }
  return -1;
}

/** Scan `source` (LF line endings expected) and produce the comment-free views. */
export function scanSource(source: string, lang: SourceLanguage): ScannedSource {
  const syn = SYNTAX[lang];
  const n = source.length;
  const clean: string[] = [];
  const skel: string[] = [];
  const lineStarts = [0];
  for (let k = 0; k < n; k += 1) if (source[k] === '\n') lineStarts.push(k + 1);

  const comment = (from: number, to: number): void => {
    const b = blank(source.slice(from, to));
    clean.push(b);
    skel.push(b);
  };
  /** A string from `from` to `to`: the delimiters of width `open`/`close` stay in the skeleton. */
  const str = (from: number, to: number, open: number, close: number): void => {
    const text = source.slice(from, to);
    clean.push(text);
    if (text.length <= open + close) {
      skel.push(text);
      return;
    }
    skel.push(text.slice(0, open) + blank(text.slice(open, text.length - close)) + text.slice(text.length - close));
  };

  let i = 0;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    const lineHit = syn.line.find((p) => source.startsWith(p, i));
    if (lineHit) {
      let j = i;
      while (j < n && source[j] !== '\n') j += 1;
      comment(i, j);
      i = j;
      continue;
    }
    if (syn.block && c === '/' && next === '*') {
      let j = i + 2;
      let depth = 1;
      while (j < n && depth > 0) {
        if (source.startsWith('*/', j)) {
          depth -= 1;
          j += 2;
        } else if (syn.nestedBlock && source.startsWith('/*', j)) {
          depth += 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      comment(i, j);
      i = j;
      continue;
    }
    if (syn.triple && (source.startsWith('"""', i) || (lang === 'python' && source.startsWith("'''", i)))) {
      const q = source.slice(i, i + 3);
      const end = source.indexOf(q, i + 3);
      const stop = end < 0 ? n : end + 3;
      str(i, stop, 3, end < 0 ? 0 : 3);
      i = stop;
      continue;
    }
    if (syn.regex && c === '/' && regexAllowed(source, i)) {
      const stop = regexEnd(source, i);
      if (stop > 0) {
        str(i, stop, 1, 1);
        i = stop;
        continue;
      }
    }
    if (syn.rustRaw && (c === 'r' || c === 'b') && !/[\w]/.test(source[i - 1] ?? ' ')) {
      RUST_RAW.lastIndex = i;
      const m = RUST_RAW.exec(source);
      if (m) {
        const close = `"${m[1]}`;
        const end = source.indexOf(close, i + m[0].length);
        const stop = end < 0 ? n : end + close.length;
        str(i, stop, m[0].length, end < 0 ? 0 : close.length);
        i = stop;
        continue;
      }
    }
    if (c === '"' || (c === "'" && syn.apos !== 'rust')) {
      let j = i + 1;
      while (j < n && source[j] !== c && (syn.multilineStrings || source[j] !== '\n')) j += source[j] === '\\' ? 2 : 1;
      const stop = Math.min(n, source[j] === c ? j + 1 : j);
      str(i, stop, 1, source[j] === c ? 1 : 0);
      i = stop;
      continue;
    }
    if (c === "'" && syn.apos === 'rust') {
      RUST_CHAR.lastIndex = i;
      const m = RUST_CHAR.exec(source);
      if (m) {
        str(i, i + m[0].length, 1, 1);
        i += m[0].length;
        continue;
      }
    }
    if (c === '`' && syn.backtick !== 'none') {
      let stop: number;
      if (syn.backtick === 'template') {
        stop = templateEnd(source, i);
      } else {
        const end = source.indexOf('`', i + 1);
        stop = end < 0 ? n : end + 1;
      }
      str(i, stop, 1, source[stop - 1] === '`' && stop - i > 1 ? 1 : 0);
      i = stop;
      continue;
    }
    clean.push(c);
    skel.push(c);
    i += 1;
  }
  return { clean: clean.join(''), skeleton: skel.join(''), lineStarts };
}

/** 1-based line of `offset`. */
export function lineOf(lineStarts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Offset of the bracket closing the one at `open`, or -1 when it never closes. Use on a skeleton. */
export function matchClose(skeleton: string, open: number): number {
  const o = skeleton[open];
  const c = o ? PAIRS[o] : undefined;
  if (!c) return -1;
  let depth = 0;
  for (let i = open; i < skeleton.length; i += 1) {
    if (skeleton[i] === o) depth += 1;
    else if (skeleton[i] === c) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Ranges `[start, end)` of the top-level comma-separated parts between `from` and `to` of a skeleton. Empty parts are dropped. */
export function splitTopLevel(skeleton: string, from: number, to: number, sep = ','): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    const c = skeleton[i]!;
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (depth === 0 && c === sep) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, to]);
  return parts.filter(([a, b]) => skeleton.slice(a, b).trim() !== '');
}

/** Collapse whitespace and cut to `max` characters. */
export function brief(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}
