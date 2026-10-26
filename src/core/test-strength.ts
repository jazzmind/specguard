/**
 * Test strength: is a test real evidence for the claim it is tagged with? A tagged test that is
 * skipped, gated behind a flag, asserts nothing or only that something exists proves little, so
 * "a test passed" is not enough. This module reads test source statically (no run needed) and
 * grades each test strong, weak, skipped or conditional, rolls that up to a claim per required
 * layer, and compares two versions of a test file to catch an agent weakening tests to make
 * them pass. Pure: callers supply source text. Spec: specs/capabilities/test-strength.md
 */
import { extractClaimRefs } from './claim-tags.js';
import { brief, lineOf, matchClose, scanSource, type ScannedSource, type SourceLanguage } from './source-scan.js';
import {
  findSites,
  preludeScan,
  type AssertContext,
  type AssertionKind,
  type AssertionSite,
  type AssertionStrength,
} from './test-assertions.js';
import { scanTestDeclarations, type TestDeclaration } from './test-declarations.js';
import type { TestLayer } from './test-layers.js';
import type { TestStatus } from './test-results.js';
import type { TestStrengthSettings } from './types.js';
import type { WeakeningFinding } from './weakening.js';

export type { AssertionKind, AssertionSite, AssertionStrength };

export type TestLanguage = SourceLanguage;

/** .js .jsx .ts .tsx .mjs .cjs .mts .cts | .py | .go | .rs | .java .kt .kts */
export function testLanguageOf(file: string): TestLanguage | undefined {
  if (/\.(?:[cm]?[jt]sx?)$/i.test(file)) return 'js';
  if (/\.py$/i.test(file)) return 'python';
  if (/\.go$/i.test(file)) return 'go';
  if (/\.rs$/i.test(file)) return 'rust';
  if (/\.(?:java|kts?)$/i.test(file)) return 'jvm';
  return undefined;
}

export interface TestRef {
  file: string;
  line: number;
  title: string;
}
export type StrengthClass = 'strong' | 'weak' | 'skipped' | 'conditional' | 'unknown';
export type StrengthReason =
  // skipped
  | 'skip-static' | 'todo' | 'enclosing-skip' | 'focus-elsewhere' | 'skip-in-body' | 'disabled-annotation' | 'skip-result'
  // conditional
  | 'conditional-builtin' | 'conditional-config' | 'assumption' | 'build-tag'
  // weak
  | 'no-assertion' | 'trivial-assertion' | 'existence-only' | 'no-throw-only' | 'error-check-only' | 'snapshot-only'
  // unknown
  | 'unsupported-language' | 'unparsable-body';

export interface TestStrength {
  test: TestRef;
  /** `other` for a file extension this module cannot read: the test is `unknown`. */
  language: TestLanguage | 'other';
  class: StrengthClass;
  reasons: StrengthReason[];
  assertions: AssertionSite[];
  /** fc.assert/fc.property, Hypothesis @given, jqwik @Property, proptest!/quickcheck */
  property: boolean;
  /** patterns that made it conditional */
  conditions: string[];
  /** first and last line of the body */
  body: [number, number];
  /** claim refs tagged on this test */
  claims: string[];
  /** wildcard matchers (expect.any, anything(), mock.ANY, any()), used by the weakening rules */
  wildcards: number;
}

export interface TestStrengthConfig {
  /** regexes (source text) marking a test as flag/env-gated; matched against decorators/annotations + declaration line + body, and against the first 30 lines of the file */
  conditional: string[];
  /** function names (exact, or ending in * as a prefix wildcard) that assert; strength 3 */
  assertHelpers: string[];
  /** default true */
  snapshotIsWeak: boolean;
}

/**
 * Merge the project `testStrength` block with an app's `test.conditional` into a ready config.
 * Throws on a gate pattern that is not a valid regular expression, so a typo cannot silently disable a gate.
 */
export function resolveStrengthConfig(project?: TestStrengthSettings, app?: { conditional?: string[] }): TestStrengthConfig {
  const conditional = [...new Set([...(project?.conditional ?? []), ...(app?.conditional ?? [])])];
  for (const source of conditional) {
    try {
      new RegExp(source);
    } catch (err) {
      throw new Error(`testStrength.conditional: invalid regular expression ${JSON.stringify(source)}: ${(err as Error).message}`, { cause: err });
    }
  }
  return {
    conditional,
    assertHelpers: [...new Set(project?.assertHelpers ?? [])],
    snapshotIsWeak: project?.snapshotIsWeak ?? true,
  };
}

const FILE_HEAD_LINES = 30;

// ---- function and body discovery ---------------------------------------

interface Range {
  from: number;
  to: number;
}

/** Body of a function whose name starts at `nameOffset`: `{...}`, a Kotlin `= expr`, or nothing for `;`. undefined when unbalanced. */
function signatureBody(scan: ScannedSource, lang: TestLanguage, nameOffset: number): Range | undefined {
  const s = scan.skeleton;
  const open = s.indexOf('(', nameOffset);
  if (open < 0) return undefined;
  const close = matchClose(s, open);
  if (close < 0) return undefined;
  for (let p = close + 1; p < s.length; p += 1) {
    const ch = s[p];
    if (ch === '{') {
      const end = matchClose(s, p);
      return end < 0 ? undefined : { from: p + 1, to: end };
    }
    if (ch === ';') return { from: p, to: p };
    if (lang === 'jvm' && ch === '=' && s[p + 1] !== '=') {
      let depth = 0;
      let q = p + 1;
      for (; q < s.length; q += 1) {
        const c = s[q]!;
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (c === '\n' && depth <= 0 && !/^\s*[.?]/.test(s.slice(q + 1, q + 40))) break;
      }
      return { from: p + 1, to: q };
    }
  }
  return undefined;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Body of a Python `def` that starts on `defLine` (1-based): the signature's end through the last more-indented line. */
function pythonBody(scan: ScannedSource, defLine: number): (Range & { startLine: number; endLine: number }) | undefined {
  const lines = scan.skeleton.split('\n');
  const base = indentOf(lines[defLine - 1] ?? '');
  let depth = 0;
  let sigEnd = -1;
  for (let i = defLine - 1; i < lines.length && i < defLine + 40; i += 1) {
    for (const ch of lines[i]!) {
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    }
    if (depth <= 0 && lines[i]!.trimEnd().length > 0 && /:\s*$|:\s+\S/.test(lines[i]!.replace(/->\s*[^:]*$/, ''))) {
      sigEnd = i;
      break;
    }
  }
  if (sigEnd < 0) return undefined;
  let last = sigEnd;
  for (let i = sigEnd + 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '') continue;
    if (indentOf(lines[i]!) <= base) break;
    last = i;
  }
  const sigText = lines[sigEnd]!;
  const colon = sigText.lastIndexOf(':');
  const inline = sigText.slice(colon + 1).trim() !== '';
  const from = scan.lineStarts[sigEnd]! + (inline ? colon + 1 : sigText.length);
  const to = scan.lineStarts[last]! + lines[last]!.length;
  return { from, to: Math.max(from, to), startLine: sigEnd + 1, endLine: last + 1 };
}

interface FunctionDef {
  name: string;
  from: number;
  to: number;
  /** Go: the `*testing.T` parameter name */
  recv?: string;
}

const NOT_FUNCTIONS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'describe', 'context', 'suite', 'it', 'test', 'specify', 'expect', 'assert', 'else', 'with', 'new', 'throw', 'await', 'synchronized', 'when', 'try']);

/** Non-test functions of a file with their bodies. */
function collectFunctions(scan: ScannedSource, lang: TestLanguage, testLines: ReadonlySet<number>): FunctionDef[] {
  const s = scan.skeleton;
  const out: FunctionDef[] = [];
  const push = (name: string, range: Range | undefined, recv?: string): void => {
    if (range && range.to >= range.from) out.push({ name, ...range, ...(recv ? { recv } : {}) });
  };
  const lineAt = (offset: number): number => lineOf(scan.lineStarts, offset);
  const arrowBody = (from: number): Range | undefined => {
    let p = from;
    while (/\s/.test(s[p] ?? '')) p += 1;
    if (s[p] === '{') {
      const end = matchClose(s, p);
      return end < 0 ? undefined : { from: p + 1, to: end };
    }
    let depth = 0;
    let q = p;
    for (; q < s.length; q += 1) {
      const c = s[q]!;
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if ((c === ';' || c === '\n') && depth === 0) break;
    }
    return { from: p, to: q };
  };
  if (lang === 'js') {
    for (const m of s.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) push(m[1]!, signatureBody(scan, lang, m.index! + m[0].length - 1));
    for (const m of s.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?=function\b|\(|[A-Za-z_$][\w$]*\s*=>)/g)) {
      const at = m.index! + m[0].length;
      const rest = s.slice(at);
      if (/^function\b/.test(rest)) {
        push(m[1]!, signatureBody(scan, lang, at));
      } else if (rest.startsWith('(')) {
        const close = matchClose(s, at);
        const arrow = close < 0 ? null : /^\s*(?::[^=>{;\n]+)?=>/.exec(s.slice(close + 1, close + 200));
        if (arrow) push(m[1]!, arrowBody(close + 1 + arrow[0].length));
      } else {
        const arrow = /^[A-Za-z_$][\w$]*\s*=>/.exec(rest);
        if (arrow) push(m[1]!, arrowBody(at + arrow[0].length));
      }
    }
    for (const m of s.matchAll(/^[ \t]*(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\s*\(/gm)) {
      const name = m[1]!;
      if (NOT_FUNCTIONS.has(name)) continue;
      const open = m.index! + m[0].length - 1;
      const close = matchClose(s, open);
      if (close < 0) continue;
      const brace = /^\s*(?::\s*[^{;=]+)?\{/.exec(s.slice(close + 1, close + 200));
      if (!brace) continue;
      const bo = close + brace[0].length;
      const end = matchClose(s, bo);
      if (end > 0) push(name, { from: bo + 1, to: end });
    }
  } else if (lang === 'python') {
    for (const m of s.matchAll(/^[ \t]*(?:async\s+)?def\s+(\w+)\s*\(/gm)) {
      const name = m[1]!;
      if (testLines.has(lineAt(m.index!)) || /^test/i.test(name)) continue;
      const body = pythonBody(scan, lineAt(m.index!));
      if (body) push(name, body);
    }
  } else if (lang === 'go') {
    for (const m of s.matchAll(/^func\s+(?:\([^)]*\)\s*)?(\w+)\s*(?:\[[^\]]*\])?\(/gm)) {
      const name = m[1]!;
      if (/^(?:Test|Benchmark|Fuzz|Example)/.test(name)) continue;
      const open = m.index! + m[0].length - 1;
      const close = matchClose(s, open);
      const recv = close < 0 ? undefined : /(\w+)\s+\*?testing\.(?:T|B|TB|F)\b/.exec(s.slice(open, close))?.[1];
      push(name, signatureBody(scan, lang, m.index! + m[0].length - 1), recv);
    }
  } else if (lang === 'rust') {
    for (const m of s.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/gm)) {
      if (testLines.has(lineAt(m.index!))) continue;
      push(m[1]!, signatureBody(scan, lang, m.index! + m[0].length));
    }
  } else {
    for (const m of s.matchAll(/\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(`[^`]+`|\w+)\s*\(/g)) {
      if (testLines.has(lineAt(m.index!))) continue;
      push(m[1]!.replace(/`/g, ''), signatureBody(scan, lang, m.index! + m[0].length - 1));
    }
    const java =
      /^[ \t]*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)*(?:<[^>]+>\s+)?([\w<>[\],.?]+)\s+(\w+)\s*\(/gm;
    for (const m of s.matchAll(java)) {
      if (NOT_FUNCTIONS.has(m[1]!) || NOT_FUNCTIONS.has(m[2]!) || m[1] === 'fun') continue;
      if (testLines.has(lineAt(m.index!))) continue;
      push(m[2]!, signatureBody(scan, lang, m.index! + m[0].length - 1));
    }
  }
  return out;
}

// ---- prelude: decorators, attributes and annotations above a test -------

/** Lines above `declLine` that belong to its decorators/attributes (and the comments between), as text. */
function preludeAbove(scan: ScannedSource, orig: string[], declLine: number, marker: RegExp): { text: string; firstLine: number } {
  const skel = scan.skeleton.split('\n');
  const clean = scan.clean.split('\n');
  const kept: string[] = [];
  let bal = 0;
  let first = declLine;
  for (let i = declLine - 2; i >= 0; i -= 1) {
    const t = (skel[i] ?? '').trim();
    if (t === '') {
      if ((orig[i] ?? '').trim() !== '') continue; // a comment line: look through it
      break;
    }
    const opens = (t.match(/[([]/g) ?? []).length;
    const closes = (t.match(/[)\]]/g) ?? []).length;
    const closing = bal === 0 && /^[)\]]/.test(t);
    if (bal > 0 || closing || marker.test(t)) {
      kept.push((clean[i] ?? '').trim());
      bal += closes - opens;
      if (bal < 0) bal = 0;
      first = i + 1;
    } else {
      break;
    }
  }
  return { text: kept.reverse().join('\n'), firstLine: first };
}

// ---- skip and conditional rules ----------------------------------------

interface Gate {
  skipped: StrengthReason[];
  conditional: StrengthReason[];
  conditions: string[];
}

const newGate = (): Gate => ({ skipped: [], conditional: [], conditions: [] });
const addUnique = <T>(list: T[], v: T): void => {
  if (!list.includes(v)) list.push(v);
};

interface JsBlock {
  open: number;
  close: number;
  skip: boolean;
  only: boolean;
  conditional: boolean;
}

function jsDescribeBlocks(scan: ScannedSource): JsBlock[] {
  const out: JsBlock[] = [];
  const re = /(?<![\w$.])(?:(?:test|it)\s*\.\s*)?([xf]?)(?:describe|context|suite)((?:\s*\.\s*\w+(?:\((?:[^()]|\([^()]*\))*\))?)*)\s*\(/g;
  for (const m of scan.skeleton.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const close = matchClose(scan.skeleton, open);
    if (close < 0) continue;
    const mods = [...(m[2] ?? '').matchAll(/\.\s*(\w+)/g)].map((x) => x[1]!);
    out.push({
      open,
      close,
      skip: m[1] === 'x' || mods.some((x) => x === 'skip' || x === 'todo' || x === 'fixme'),
      only: m[1] === 'f' || mods.includes('only'),
      conditional: mods.some((x) => x === 'skipIf' || x === 'runIf'),
    });
  }
  return out;
}

const JS_IN_BODY_SKIP = /(?<![\w$.])(?:test|testInfo|ctx|context|this|t)\s*\.\s*(?:skip|fixme)\s*\(/g;

function jsGate(scan: ScannedSource, decl: TestDeclaration, body: Range | undefined, blocks: JsBlock[], focused: ReadonlySet<number>, anyFocus: boolean, declOffset: number): Gate {
  const g = newGate();
  const lineText = scan.skeleton.split('\n')[decl.line - 1] ?? '';
  const head = /^\s*([xf]?)(?:it|test|specify)((?:\.\s*\w+(?:\((?:[^()]|\([^()]*\))*\))?)*)/.exec(lineText);
  const mods = [...(head?.[2] ?? '').matchAll(/\.\s*(\w+)/g)].map((x) => x[1]!);
  if (head?.[1] === 'x') addUnique(g.skipped, 'skip-static');
  if (mods.includes('skip') || mods.includes('fixme')) addUnique(g.skipped, 'skip-static');
  if (mods.includes('todo')) addUnique(g.skipped, 'todo');
  if (mods.includes('skipIf') || mods.includes('runIf')) {
    addUnique(g.conditional, 'conditional-builtin');
    g.conditions.push(`${mods.includes('skipIf') ? 'skipIf' : 'runIf'}(...)`);
  }
  for (const b of blocks) {
    if (declOffset < b.open || declOffset > b.close) continue;
    if (b.skip) addUnique(g.skipped, 'enclosing-skip');
    if (b.conditional) {
      addUnique(g.conditional, 'conditional-builtin');
      g.conditions.push('describe.skipIf/runIf(...)');
    }
  }
  if (anyFocus && !focused.has(decl.line)) addUnique(g.skipped, 'focus-elsewhere');
  if (body) {
    const text = scan.skeleton.slice(body.from, body.to);
    const cb = /=>\s*\{|function\s*\w*\s*\([^)]*\)\s*\{/.exec(text);
    const startAt = cb ? cb.index + cb[0].length : (/=>/.exec(text)?.index ?? -1) + 2;
    const firstStmt = startAt > 1 ? text.slice(startAt).trimStart() : '';
    const firstOffset = body.from + startAt + (text.slice(startAt).length - firstStmt.length);
    const first = /^(?:test|testInfo|ctx|context|this|t)\s*\.\s*(?:skip|fixme)\s*\(/.exec(firstStmt);
    if (first) {
      const open = firstOffset + first[0].length - 1;
      const close = matchClose(scan.skeleton, open);
      const inner = close < 0 ? '' : scan.clean.slice(open + 1, close).trim();
      if (inner === '' || /^true\b/.test(inner)) addUnique(g.skipped, 'skip-in-body');
      else {
        addUnique(g.conditional, 'conditional-builtin');
        g.conditions.push(`skip(${brief(inner, 40)})`);
      }
    }
    for (const m of text.matchAll(JS_IN_BODY_SKIP)) {
      if (first && body.from + m.index! === firstOffset) continue;
      addUnique(g.conditional, 'conditional-builtin');
      g.conditions.push('skip() inside the test');
    }
  }
  return g;
}

function pythonGate(scan: ScannedSource, orig: string[], decl: TestDeclaration, body: Range | undefined): Gate {
  const g = newGate();
  const skel = scan.skeleton.split('\n');
  const texts: string[] = [];
  const defLine = skel[decl.line - 1] ?? '';
  texts.push(preludeAbove(scan, orig, decl.line, /^@/).text);
  // enclosing classes, innermost first
  let indent = indentOf(defLine);
  for (let i = decl.line - 2; i >= 0 && indent > 0; i -= 1) {
    const l = skel[i] ?? '';
    if (l.trim() === '') continue;
    const ci = indentOf(l);
    if (ci < indent && /^\s*class\s+\w+/.test(l)) {
      texts.push(preludeAbove(scan, orig, i + 1, /^@/).text);
      indent = ci;
    } else if (ci < indent) {
      indent = ci;
    }
  }
  const decorators = texts.join('\n');
  const skipRe = /@\s*(?:pytest\s*\.\s*mark\s*\.\s*skip(?!if)\b|(?:unittest\s*\.\s*)?skip\s*\(|pytest\s*\.\s*mark\s*\.\s*xfail\b|unittest\s*\.\s*expectedFailure\b)/;
  if (skipRe.test(decorators)) addUnique(g.skipped, 'skip-static');
  const condRe = /@\s*(?:pytest\s*\.\s*mark\s*\.\s*skipif\b|(?:unittest\s*\.\s*)?skip(?:If|Unless)\s*\()/;
  if (condRe.test(decorators)) {
    addUnique(g.conditional, 'conditional-builtin');
    g.conditions.push('skipif');
  }
  // module-level `pytestmark = ...`
  for (const m of scan.skeleton.matchAll(/^pytestmark\s*=\s*([^\n]*(?:\n[ \t]+[^\n]*)*)/gm)) {
    if (/\bskip\b(?!if)|\bxfail\b/.test(m[1]!)) addUnique(g.skipped, 'skip-static');
    else if (/\bskipif\b/.test(m[1]!)) {
      addUnique(g.conditional, 'conditional-builtin');
      g.conditions.push('pytestmark skipif');
    }
  }
  if (/^pytest\s*\.\s*skip\s*\([^)]*allow_module_level\s*=\s*True/m.test(scan.skeleton)) addUnique(g.skipped, 'skip-static');
  if (body) {
    const text = scan.skeleton.slice(body.from, body.to);
    const trimmed = text.trimStart();
    const firstRe = /^(?:pytest\s*\.\s*skip|self\s*\.\s*skipTest|unittest\s*\.\s*SkipTest|pytest\s*\.\s*xfail)\s*\(/;
    const first = firstRe.test(trimmed);
    if (first) addUnique(g.skipped, 'skip-in-body');
    const rest = first ? trimmed.replace(firstRe, '(') : text;
    if (/(?<![\w.])(?:pytest\s*\.\s*skip|self\s*\.\s*skipTest|pytest\s*\.\s*xfail)\s*\(/.test(rest)) {
      addUnique(g.conditional, 'conditional-builtin');
      g.conditions.push('skip() inside the test');
    }
    if (/pytest\s*\.\s*importorskip\s*\(/.test(text)) {
      addUnique(g.conditional, 'conditional-builtin');
      g.conditions.push('importorskip');
    }
  }
  return g;
}

function goGate(scan: ScannedSource, orig: string[], body: Range | undefined, recv: string): Gate {
  const g = newGate();
  if (orig.slice(0, FILE_HEAD_LINES).some((l) => /^\s*\/\/\s*(?:go:build|\+build)\b/.test(l))) {
    addUnique(g.conditional, 'build-tag');
    g.conditions.push('build tag');
  }
  if (body) {
    const text = scan.skeleton.slice(body.from, body.to);
    const skipRe = new RegExp(String.raw`(?<![\w.])${recv.replace(/[^\w]/g, '')}\s*\.\s*(?:Skip|Skipf|SkipNow)\s*\(`, 'g');
    const trimmed = text.trimStart();
    const first = new RegExp(String.raw`^${recv.replace(/[^\w]/g, '')}\s*\.\s*(?:Skip|Skipf|SkipNow)\s*\(`).exec(trimmed);
    if (first) addUnique(g.skipped, 'skip-static');
    const offset = first ? text.length - trimmed.length : -1;
    for (const m of text.matchAll(skipRe)) {
      if (m.index === offset) continue;
      addUnique(g.conditional, 'conditional-builtin');
      g.conditions.push(`${recv}.Skip inside the test`);
    }
    if (/\btesting\s*\.\s*Short\s*\(\s*\)/.test(text)) {
      addUnique(g.conditional, 'conditional-builtin');
      g.conditions.push('testing.Short()');
    }
  }
  return g;
}

function rustGate(attrs: string): Gate {
  const g = newGate();
  if (/#\[\s*ignore\b/.test(attrs)) addUnique(g.skipped, 'skip-static');
  if (/#\[\s*cfg_attr\s*\([^\]]*\bignore\b/.test(attrs)) {
    addUnique(g.conditional, 'conditional-builtin');
    g.conditions.push('cfg_attr(..., ignore)');
  }
  for (const m of attrs.matchAll(/#\[\s*cfg\s*\(([^\]]*)\)\s*\]/g)) {
    if (m[1]!.trim() === 'test') continue;
    addUnique(g.conditional, 'conditional-builtin');
    g.conditions.push(`cfg(${brief(m[1]!, 40)})`);
  }
  return g;
}

const simpleName = (n: string): string => n.replace(/^.*\./, '');

function jvmGate(scan: ScannedSource, orig: string[], decl: TestDeclaration, body: Range | undefined, classes: Array<{ from: number; to: number; line: number }>, declOffset: number): Gate {
  const g = newGate();
  const consider = (name: string, args: string): void => {
    const n = simpleName(name);
    if (n === 'Disabled' || n === 'Ignore') addUnique(g.skipped, 'disabled-annotation');
    else if (n === 'Test' && /\benabled\s*=\s*false\b/.test(args)) addUnique(g.skipped, 'disabled-annotation');
    else if (/^(?:Enabled|Disabled)(?:If|On|For|In|Un)\w*$/.test(n)) {
      addUnique(g.conditional, 'conditional-builtin');
      g.conditions.push(`@${n}`);
    }
  };
  decl.annotations?.forEach((a) => consider(a, decl.annotationArgs?.[a] ?? ''));
  for (const c of classes) {
    if (declOffset < c.from || declOffset > c.to) continue;
    const pre = preludeAbove(scan, orig, c.line, /^@/).text + '\n' + (scan.clean.split('\n')[c.line - 1] ?? '').split(/\b(?:class|object|interface)\b/)[0];
    for (const m of pre.matchAll(/@\s*([\w.]+)\s*(?:\(((?:[^()]|\([^()]*\))*)\))?/g)) consider(m[1]!, m[2] ?? '');
  }
  if (body && /(?<![\w])(?:(?:Assumptions?)\s*\.\s*)?assume[A-Z]\w*\s*\(/.test(scan.skeleton.slice(body.from, body.to))) {
    addUnique(g.conditional, 'assumption');
    g.conditions.push('assume*()');
  }
  return g;
}

// ---- analysis -----------------------------------------------------------

const GO_RECV = /\(\s*(\w+)\s+\*?testing\.[TBF]/;

function matchesHelper(name: string, helpers: readonly string[]): boolean {
  return helpers.some((h) => (h.endsWith('*') ? name.startsWith(h.slice(0, -1)) : name === h));
}

function classifySites(sites: AssertionSite[], snapshotIsWeak: boolean, lenient: number): { weak: StrengthReason | undefined; extra: StrengthReason[] } {
  const live = snapshotIsWeak ? sites.filter((s) => s.kind !== 'snapshot') : sites;
  if (sites.length === 0) return { weak: 'no-assertion', extra: lenient > 0 ? ['no-throw-only'] : [] };
  if (live.length === 0) return { weak: 'snapshot-only', extra: [] };
  if (live.every((s) => s.strength === 0)) return { weak: 'trivial-assertion', extra: [] };
  const max = Math.max(...live.map((s) => s.strength));
  if (max > 1) return { weak: undefined, extra: [] };
  const kinds = new Set(live.filter((s) => s.strength > 0).map((s) => s.kind));
  if ([...kinds].every((k) => k === 'existence')) return { weak: 'existence-only', extra: [] };
  if ([...kinds].every((k) => k === 'existence' || k === 'no-throw')) return { weak: 'no-throw-only', extra: [] };
  if (kinds.has('error-check') && [...kinds].every((k) => k === 'existence' || k === 'error-check' || k === 'no-throw')) return { weak: 'error-check-only', extra: [] };
  return { weak: 'existence-only', extra: [] };
}

function claimsOf(orig: string[], decl: TestDeclaration, firstAbove: number): string[] {
  const refs: string[] = [];
  const from = Math.min(firstAbove, decl.anchor ?? decl.line);
  for (let l = from; l <= decl.line; l += 1) refs.push(...extractClaimRefs(orig[l - 1] ?? ''));
  for (let l = from - 1; l >= 1; l -= 1) {
    const t = (orig[l - 1] ?? '').trim();
    if (/^(?:\/\/|#|\/\*|\*)/.test(t)) refs.push(...extractClaimRefs(t));
    else break;
  }
  return [...new Set(refs)];
}

/** Grade every test declared in one test file. */
export function analyzeTestFile(source: string, file: string, cfg: TestStrengthConfig): TestStrength[] {
  const language = testLanguageOf(file);
  const text = source.replace(/\r\n/g, '\n');
  const orig = text.split('\n');
  const decls = scanTestDeclarations(text, file);
  const claimsFallback = (d: TestDeclaration): string[] => claimsOf(orig, d, d.line);
  if (!language) {
    return decls.map((d) => ({
      test: { file, line: d.line, title: d.title },
      language: 'other' as const,
      class: 'unknown' as const,
      reasons: ['unsupported-language' as const],
      assertions: [],
      property: false,
      conditions: [],
      body: [d.line, d.line] as [number, number],
      claims: claimsFallback(d),
      wildcards: 0,
    }));
  }

  const scan = scanSource(text, language);
  const cleanLines = scan.clean.split('\n');
  const live = decls.filter((d) => (cleanLines[d.line - 1] ?? '').trim() !== '');
  const testLines = new Set(live.flatMap((d) => [d.line, ...(d.anchor ? [d.anchor] : [])]));
  const configRes = cfg.conditional.map((c) => new RegExp(c));
  const functions = collectFunctions(scan, language, testLines);
  const defined = new Set(functions.map((f) => f.name));
  const isConfigHelper = (name: string): boolean => matchesHelper(name, cfg.assertHelpers);

  // Same-file helpers: names whose bodies assert, to a fixpoint of depth 3.
  let helpers = new Map<string, AssertionStrength>();
  for (let round = 0; round < 3; round += 1) {
    const next = new Map<string, AssertionStrength>();
    for (const f of functions) {
      const ctx: AssertContext = { lang: language, scan, from: f.from, to: f.to, helpers, defined, isConfigHelper, ...(f.recv ? { recv: f.recv } : {}) };
      const sites = findSites(ctx).sites;
      if (sites.length === 0) continue;
      const max = Math.max(...sites.map((s) => s.strength)) as AssertionStrength;
      next.set(f.name, Math.max(next.get(f.name) ?? 0, max) as AssertionStrength);
    }
    helpers = next;
  }

  // JS blocks and focus
  const blocks = language === 'js' ? jsDescribeBlocks(scan) : [];
  const jsHeads = new Map<number, { call: Range | undefined; focus: boolean }>();
  if (language === 'js') {
    for (const d of live) {
      const start = scan.lineStarts[d.line - 1]!;
      const m = /^\s*([xf]?)(?:it|test|specify)((?:\s*\.\s*\w+(?:\((?:[^()]|\([^()]*\))*\))?)*)\s*\(/.exec(scan.skeleton.slice(start, start + 400));
      let call: Range | undefined;
      if (m) {
        const open = start + m[0].length - 1;
        const close = matchClose(scan.skeleton, open);
        if (close >= 0) call = { from: open + 1, to: close };
      }
      const mods = [...(m?.[2] ?? '').matchAll(/\.\s*(\w+)/g)].map((x) => x[1]!);
      jsHeads.set(d.line, { call, focus: m?.[1] === 'f' || mods.includes('only') });
    }
  }
  const focused = new Set<number>();
  if (language === 'js') {
    for (const d of live) {
      const off = scan.lineStarts[d.line - 1]!;
      if (jsHeads.get(d.line)?.focus || blocks.some((b) => b.only && off > b.open && off < b.close)) focused.add(d.line);
    }
  }
  const anyFocus = focused.size > 0;

  // JVM class ranges
  const classes: Array<{ from: number; to: number; line: number }> = [];
  if (language === 'jvm') {
    for (const m of scan.skeleton.matchAll(/\b(?:class|object|interface)\s+\w+[^{;=]*\{/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchClose(scan.skeleton, open);
      if (close > 0) classes.push({ from: open, to: close, line: lineOf(scan.lineStarts, m.index!) });
    }
  }
  const proptestBlocks: Range[] = [];
  if (language === 'rust') {
    for (const m of scan.skeleton.matchAll(/\bproptest\s*!\s*\{/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchClose(scan.skeleton, open);
      if (close > 0) proptestBlocks.push({ from: open, to: close });
    }
  }

  return live.map((d): TestStrength => {
    const declOffset = scan.lineStarts[d.line - 1]!;
    const startLine = d.line;
    let body: Range | undefined;
    let bodyLines: [number, number] = [d.line, d.line];
    let unparsable = false;
    let prelude = '';
    let firstAbove = d.line;
    let recv = 't';
    switch (language) {
      case 'js': {
        body = jsHeads.get(d.line)?.call;
        break;
      }
      case 'python': {
        const pb = pythonBody(scan, d.line);
        body = pb;
        if (pb) bodyLines = [pb.startLine, pb.endLine];
        const above = preludeAbove(scan, orig, d.line, /^@/);
        prelude = above.text;
        firstAbove = above.firstLine;
        break;
      }
      case 'go': {
        const sig = (scan.skeleton.split('\n')[d.line - 1] ?? '');
        recv = GO_RECV.exec(sig)?.[1] ?? 't';
        body = signatureBody(scan, language, declOffset + Math.max(0, sig.indexOf(d.title)));
        break;
      }
      case 'rust': {
        const above = preludeAbove(scan, orig, d.line, /^#\[/);
        prelude = above.text;
        firstAbove = above.firstLine;
        const sig = scan.skeleton.split('\n')[d.line - 1] ?? '';
        body = signatureBody(scan, language, declOffset + Math.max(0, sig.indexOf(`fn ${d.title}`)));
        break;
      }
      case 'jvm': {
        const sig = scan.skeleton.split('\n')[d.line - 1] ?? '';
        const name = d.method ?? d.title;
        const at = Math.max(sig.indexOf(`\`${name}\``) >= 0 ? sig.indexOf(`\`${name}\``) : sig.indexOf(name), 0);
        body = signatureBody(scan, language, declOffset + at);
        prelude = (d.annotations ?? []).map((a) => `@${a}${d.annotationArgs && a in d.annotationArgs ? `(${d.annotationArgs[a]})` : ''}`).join('\n');
        break;
      }
    }
    const bodyless = language === 'js' && /^\s*[xf]?(?:it|test|specify)\s*\.\s*todo\b/.test(scan.skeleton.slice(declOffset, declOffset + 80));
    if (!body && !bodyless) unparsable = true;
    if (body && language !== 'python') bodyLines = [lineOf(scan.lineStarts, body.from), lineOf(scan.lineStarts, Math.max(body.from, body.to))];
    if (language === 'js' && body === undefined) bodyLines = [d.line, d.line];

    let gate: Gate;
    switch (language) {
      case 'js':
        gate = jsGate(scan, d, body, blocks, focused, anyFocus, declOffset);
        break;
      case 'python':
        gate = pythonGate(scan, orig, d, body);
        break;
      case 'go':
        gate = goGate(scan, orig, body, recv);
        break;
      case 'rust':
        gate = rustGate(prelude);
        break;
      default:
        gate = jvmGate(scan, orig, d, body, classes, declOffset);
    }
    // configured gates: decorators/annotations + declaration line + body, and the head of the file
    const gateText = [prelude, cleanLines[d.line - 1] ?? '', body ? scan.clean.slice(body.from, body.to) : ''].join('\n');
    const headText = orig.slice(0, FILE_HEAD_LINES).join('\n');
    for (const re of configRes) {
      if (re.test(gateText) || re.test(headText)) {
        addUnique(gate.conditional, 'conditional-config');
        gate.conditions.push(re.source);
      }
    }

    const claims = claimsOf(orig, d, firstAbove);
    const base = { test: { file, line: startLine, title: d.title } as TestRef, language, claims, body: bodyLines };
    if (gate.skipped.length > 0) {
      return { ...base, class: 'skipped', reasons: gate.skipped, assertions: [], property: false, conditions: [], wildcards: 0 };
    }

    let sites: AssertionSite[] = [];
    let property = false;
    let wildcards = 0;
    let lenient = 0;
    if (body) {
      const ctx: AssertContext = { lang: language, scan, from: body.from, to: body.to, helpers, defined, isConfigHelper, recv };
      const found = findSites(ctx);
      sites = found.sites;
      property = found.property;
      wildcards = found.wildcards;
      lenient = found.lenientCalls;
    }
    const pre = preludeScan(language, language === 'rust' ? prelude : prelude, d.line);
    sites = [...pre.sites, ...sites];
    property = property || pre.property;
    if (language === 'rust' && proptestBlocks.some((b) => declOffset > b.from && declOffset < b.to)) property = true;

    if (gate.conditional.length > 0) {
      return { ...base, class: 'conditional', reasons: gate.conditional, assertions: sites, property, conditions: [...new Set(gate.conditions)], wildcards };
    }
    if (unparsable) {
      return { ...base, class: 'unknown', reasons: ['unparsable-body'], assertions: sites, property, conditions: [], wildcards };
    }
    const verdict = classifySites(sites, cfg.snapshotIsWeak, lenient);
    if (verdict.weak) {
      return { ...base, class: 'weak', reasons: [verdict.weak, ...verdict.extra], assertions: sites, property, conditions: [], wildcards };
    }
    return { ...base, class: 'strong', reasons: [], assertions: sites, property, conditions: [], wildcards };
  });
}

/**
 * A test whose result in the proving run is `skip` is skipped whatever the source says: it catches runtime
 * skips that static reading missed. A test that is statically skipped keeps its reasons.
 */
export function applyResultStatus(s: TestStrength, status: TestStatus | undefined): TestStrength {
  if (status !== 'skip' || s.class === 'skipped') return s;
  return { ...s, class: 'skipped', reasons: ['skip-result'] };
}

// ---- claim level --------------------------------------------------------

export interface LayerStrength {
  strong: TestRef[];
  weak: TestRef[];
  skipped: TestRef[];
  conditional: TestRef[];
  unknown: TestRef[];
}
export type ClaimStrengthReason = 'NO_TAGGED_TESTS' | 'ALL_SKIPPED' | 'CONDITIONAL_ONLY' | 'WEAK_ONLY' | 'LAYER_NOT_MEANINGFUL' | 'STRENGTH_UNKNOWN';
export interface ClaimStrength {
  ref: string;
  meaningful: boolean | 'unknown';
  /** `any` when no layer is required */
  perLayer: Partial<Record<TestLayer | 'any', LayerStrength>>;
  reasons: Array<{ code: ClaimStrengthReason; layer?: TestLayer }>;
  /** at least one strong property test */
  property: boolean;
}

const emptyLayer = (): LayerStrength => ({ strong: [], weak: [], skipped: [], conditional: [], unknown: [] });
function bucket(into: LayerStrength, t: TestStrength): void {
  const key: keyof LayerStrength = t.class === 'strong' ? 'strong' : t.class;
  into[key].push(t.test);
}

/**
 * Is a claim meaningfully tested? With no required layer, one strong tagged test is enough. With required
 * layers, each one (except `functional`, which `verify` produces and the ledger judges) needs its own strong
 * test, so a strong unit test cannot hide a weak e2e test the spec asks for.
 */
export function claimStrength(ref: string, tests: Array<{ strength: TestStrength; layer: TestLayer }>, required: readonly TestLayer[]): ClaimStrength {
  const layers = [...new Set(required)].filter((l) => l !== 'functional');
  const perLayer: ClaimStrength['perLayer'] = {};
  const all = emptyLayer();
  for (const t of tests) bucket(all, t.strength);
  const property = tests.some((t) => t.strength.class === 'strong' && t.strength.property);
  const reasons: ClaimStrength['reasons'] = [];

  const missing: Array<TestLayer | 'any'> = [];
  if (layers.length === 0) {
    perLayer.any = all;
    if (all.strong.length === 0) missing.push('any');
  } else {
    for (const layer of layers) {
      const lane = emptyLayer();
      for (const t of tests) if (t.layer === layer) bucket(lane, t.strength);
      perLayer[layer] = lane;
      if (lane.strong.length === 0) missing.push(layer);
    }
  }
  if (missing.length === 0) return { ref, meaningful: true, perLayer, reasons, property };

  if (tests.length === 0) {
    reasons.push({ code: 'NO_TAGGED_TESTS' });
    return { ref, meaningful: false, perLayer, reasons, property };
  }
  const live = tests.filter((t) => t.strength.class !== 'skipped');
  const unskipped = live.filter((t) => t.strength.class !== 'conditional');
  const remaining = unskipped.filter((t) => t.strength.class !== 'weak');
  if (all.strong.length === 0) {
    if (live.length === 0) reasons.push({ code: 'ALL_SKIPPED' });
    else if (unskipped.length === 0) reasons.push({ code: 'CONDITIONAL_ONLY' });
    else if (remaining.length === 0) reasons.push({ code: 'WEAK_ONLY' });
    else if (remaining.every((t) => t.strength.class === 'unknown')) {
      return { ref, meaningful: 'unknown', perLayer, reasons: [{ code: 'STRENGTH_UNKNOWN' }], property };
    }
  }
  for (const layer of missing) if (layer !== 'any') reasons.push({ code: 'LAYER_NOT_MEANINGFUL', layer });
  return { ref, meaningful: false, perLayer, reasons, property };
}

// ---- weakening between two versions of a test file ----------------------

const sitesAtLeast = (t: TestStrength, r: number): number => t.assertions.filter((a) => a.strength >= r).length;

/** Does the file focus tests (`.only`, `fit`, `fdescribe`)? JS only: other runners have no such marker in source. */
export function hasFocusMarkers(source: string, file: string): boolean {
  if (testLanguageOf(file) !== 'js') return false;
  const { skeleton } = scanSource(source.replace(/\r\n/g, '\n'), 'js');
  return /\.\s*only\s*\(|(?<![\w$.])(?:fit|ftest|fdescribe|fspecify|fcontext)\s*\(/.test(skeleton);
}

/**
 * Compare two versions of one test file and report where proof got weaker for a live claim: a tagged
 * test removed or untagged, skipped, gated, focused away from, weakened to fewer or looser assertions,
 * or loaded with wildcard matchers. Tests are paired by title (in order when titles repeat). Only tests
 * that carried a live claim are judged, so ordinary refactoring of untagged tests stays quiet.
 */
export function diffTestFile(
  before: string | undefined,
  after: string | undefined,
  file: string,
  cfg: TestStrengthConfig,
  liveClaims: ReadonlySet<string>,
): WeakeningFinding[] {
  if (before === undefined) return [];
  const was = analyzeTestFile(before, file, cfg);
  const now = after === undefined ? [] : analyzeTestFile(after, file, cfg);
  const findings: WeakeningFinding[] = [];
  const liveOf = (t: TestStrength): string[] => t.claims.filter((c) => liveClaims.has(c));

  const pool = new Map<string, TestStrength[]>();
  for (const t of now) pool.set(t.test.title, [...(pool.get(t.test.title) ?? []), t]);
  const used = new Set<TestStrength>();
  const pairs: Array<[TestStrength, TestStrength | undefined]> = [];
  for (const t of was) {
    const partner = pool.get(t.test.title)?.shift();
    if (partner) used.add(partner);
    pairs.push([t, partner]);
  }
  const added = now.filter((t) => !used.has(t));

  const focusNow = after !== undefined && hasFocusMarkers(after, file);
  const focusBefore = hasFocusMarkers(before, file);
  if (focusNow && !focusBefore) {
    const hidden = now.filter((t) => t.reasons.includes('focus-elsewhere'));
    findings.push({
      kind: 'focus-added',
      severity: 'error',
      file,
      claims: [...new Set(hidden.flatMap(liveOf))],
      message: `${file}: a focused test (.only, fit, fdescribe) was added, so ${hidden.length} other test(s) no longer run`,
    });
  }

  for (const [b, a] of pairs) {
    const live = liveOf(b);
    if (live.length === 0) continue;
    if (!a) {
      const renamed = added.some((t) => live.every((c) => t.claims.includes(c)));
      findings.push({
        kind: 'test-removed',
        severity: renamed ? 'warn' : 'error',
        file,
        line: b.test.line,
        test: b.test.title,
        claims: live,
        message: renamed
          ? `${file}: tagged test "${b.test.title}" is gone, but an added test carries the same tags (a rename?)`
          : `${file}: tagged test "${b.test.title}" was removed while its claims are still live`,
      });
      continue;
    }
    const lost = live.filter((c) => !a.claims.includes(c));
    if (lost.length > 0) {
      findings.push({
        kind: 'tag-removed',
        severity: 'error',
        file,
        line: a.test.line,
        test: a.test.title,
        claims: lost,
        before: lost.join(', '),
        message: `${file}: test "${a.test.title}" no longer carries ${lost.join(', ')}, which is still a live claim`,
      });
    }
    const cls = (t: TestStrength): string => `${t.class}${t.reasons.length > 0 ? ` (${t.reasons.join(', ')})` : ''}`;
    if (a.class === 'skipped' && b.class !== 'skipped' && !a.reasons.includes('focus-elsewhere')) {
      findings.push({ kind: 'skip-added', severity: 'error', file, line: a.test.line, test: a.test.title, claims: live, before: cls(b), after: cls(a), message: `${file}: test "${a.test.title}" is now skipped: ${a.reasons.join(', ')}` });
    } else if (a.class === 'conditional' && b.class !== 'conditional' && b.class !== 'skipped') {
      findings.push({ kind: 'conditional-added', severity: 'error', file, line: a.test.line, test: a.test.title, claims: live, before: cls(b), after: cls(a), message: `${file}: test "${a.test.title}" now only runs under a condition: ${a.conditions.join('; ') || a.reasons.join(', ')}` });
    }
    if (b.class === 'strong' && a.class === 'weak') {
      findings.push({ kind: 'became-weak', severity: 'error', file, line: a.test.line, test: a.test.title, claims: live, before: cls(b), after: cls(a), message: `${file}: test "${a.test.title}" went from strong to weak: ${a.reasons.join(', ')}` });
    }
    if (a.class !== 'skipped' && b.class !== 'skipped') {
      const nb = sitesAtLeast(b, 2);
      const na = sitesAtLeast(a, 2);
      if (na < nb) {
        findings.push({ kind: 'assertions-removed', severity: 'error', file, line: a.test.line, test: a.test.title, claims: live, before: `${nb} assertion(s)`, after: `${na} assertion(s)`, message: `${file}: test "${a.test.title}" has fewer meaningful assertions (${nb} -> ${na})` });
      } else if ([2, 3].some((r) => sitesAtLeast(a, r) < sitesAtLeast(b, r))) {
        findings.push({ kind: 'assertion-weakened', severity: 'error', file, line: a.test.line, test: a.test.title, claims: live, before: `${sitesAtLeast(b, 3)} exact, ${nb} total`, after: `${sitesAtLeast(a, 3)} exact, ${na} total`, message: `${file}: test "${a.test.title}" asserts less precisely than before` });
      }
      if (a.wildcards > b.wildcards) {
        findings.push({ kind: 'wildcard-added', severity: 'warn', file, line: a.test.line, test: a.test.title, claims: live, before: String(b.wildcards), after: String(a.wildcards), message: `${file}: test "${a.test.title}" gained wildcard matchers (${b.wildcards} -> ${a.wildcards}), which match anything` });
      }
    }
  }
  return findings;
}
