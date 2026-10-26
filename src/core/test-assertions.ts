/**
 * Assertion sites in test bodies for JS/TS, Python, Go, Rust and Java/Kotlin, graded by how much
 * they pin down: 0 trivial, 1 existence / no-throw / error-check, 2 partial, 3 exact. Reading is
 * lexical (see source-scan.ts): it needs no compiler and fails soft. The grading is a static
 * heuristic over well-known assertion APIs; helpers are trusted by convention or configuration.
 * Spec: specs/capabilities/test-strength.md
 */
import { brief, lineOf, matchClose, splitTopLevel, type ScannedSource, type SourceLanguage } from './source-scan.js';

export type AssertionKind =
  | 'exact' | 'partial' | 'existence' | 'throws' | 'no-throw' | 'error-check'
  | 'snapshot' | 'mock-verify' | 'property' | 'fail-call' | 'helper' | 'trivial';
/** 0 trivial, 1 existence/no-throw/error-check, 2 partial/structural, 3 exact */
export type AssertionStrength = 0 | 1 | 2 | 3;
export interface AssertionSite {
  line: number;
  kind: AssertionKind;
  strength: AssertionStrength;
  /** trimmed, max 120 chars */
  text: string;
  helper?: string;
}

export interface AssertContext {
  lang: SourceLanguage;
  scan: ScannedSource;
  /** body offsets `[from, to)` */
  from: number;
  to: number;
  /** same-file helper name -> strength of its strongest site */
  helpers: ReadonlyMap<string, AssertionStrength>;
  /** every non-test function defined in the file, whether or not it asserts */
  defined: ReadonlySet<string>;
  /** a configured assertion helper (strength 3)? */
  isConfigHelper: (name: string) => boolean;
  /** Go: the `*testing.T` receiver name */
  recv?: string;
}

export interface SiteScan {
  sites: AssertionSite[];
  property: boolean;
  wildcards: number;
  /** Rust: `.unwrap()` / `.expect(` calls, which are not assertions */
  lenientCalls: number;
}

const LITERAL = /^(?:true|false|null|undefined|None|nil|True|False|-?\d+(?:\.\d+)?[lLfFdD]?|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`[^`$]*`)$/;
const isLiteral = (text: string): boolean => LITERAL.test(text.trim());
const same = (a: string, b: string): boolean => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CONVENTION_CAMEL = /^(?:expect|assert|verify|check|should|must|ensure)[A-Z_]\w*$/;
const CONVENTION_SNAKE = /^(?:assert|expect|verify|check|ensure)_\w+$/;
export const isConventionHelper = (name: string): boolean => CONVENTION_CAMEL.test(name) || CONVENTION_SNAKE.test(name);

/** Blank everything nested inside brackets, so operators can be searched at the top level only. */
function maskNested(skel: string): string {
  let depth = 0;
  let out = '';
  for (const c of skel) {
    if (c === '(' || c === '[' || c === '{') {
      out += depth === 0 ? c : ' ';
      depth += 1;
    } else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      out += depth === 0 ? c : ' ';
    } else {
      out += depth === 0 ? c : ' ';
    }
  }
  return out;
}

class Collector {
  readonly sites: AssertionSite[] = [];
  constructor(private readonly scan: ScannedSource) {}
  add(offset: number, end: number, kind: AssertionKind, strength: AssertionStrength, helper?: string): void {
    const site: AssertionSite = {
      line: lineOf(this.scan.lineStarts, offset),
      kind,
      strength,
      text: brief(this.scan.clean.slice(offset, Math.max(offset + 1, end))),
    };
    if (helper) site.helper = helper;
    this.sites.push(site);
  }
}

interface Call {
  /** offset of the call's name start */
  start: number;
  open: number;
  close: number;
  args: Array<{ clean: string; skel: string }>;
}

function callAt(scan: ScannedSource, open: number, start: number): Call | undefined {
  const close = matchClose(scan.skeleton, open);
  if (close < 0) return undefined;
  const args = splitTopLevel(scan.skeleton, open + 1, close).map(([a, b]) => ({
    clean: scan.clean.slice(a, b).trim(),
    skel: scan.skeleton.slice(a, b),
  }));
  return { start, open, close, args };
}

/** Run `re` (global) over the body and call `fn` with each match whose last character is an opening bracket. */
function eachCall(ctx: AssertContext, re: RegExp, fn: (m: RegExpExecArray, call: Call) => void): void {
  const { skeleton } = ctx.scan;
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  rx.lastIndex = ctx.from;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(skeleton)) !== null && m.index < ctx.to) {
    if (m[0].length === 0) {
      rx.lastIndex += 1;
      continue;
    }
    const open = m.index + m[0].length - 1;
    if (!'([{'.includes(skeleton[open] ?? '')) continue;
    const call = callAt(ctx.scan, open, m.index);
    if (call) fn(m, call);
  }
}

function countMatches(ctx: AssertContext, re: RegExp): number {
  const slice = ctx.scan.skeleton.slice(ctx.from, ctx.to);
  return [...slice.matchAll(new RegExp(re.source, 'g'))].length;
}

/** Calls to same-file helpers, configured helpers and convention-named helpers. */
function helperSites(ctx: AssertContext, c: Collector, reserved: ReadonlySet<string>, opts: { methodPrefix?: string; needsRecv?: boolean; reservedRe?: RegExp } = {}): void {
  const prefix = opts.methodPrefix ?? '';
  const re = new RegExp(String.raw`(?<![\w$.])${prefix}([A-Za-z_$][\w$]*)\s*\(`, 'g');
  const slice = ctx.scan.skeleton;
  re.lastIndex = ctx.from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null && m.index < ctx.to) {
    const name = m[1]!;
    if (reserved.has(name) || opts.reservedRe?.test(name)) continue;
    const before = slice.slice(Math.max(0, m.index - 12), m.index);
    if (/(?:\bfunction|\bfn|\bdef|\bfun|\bfunc)\s*$/.test(before)) continue; // a definition, not a call
    const open = m.index + m[0].length - 1;
    const call = callAt(ctx.scan, open, m.index);
    if (!call) continue;
    if (opts.needsRecv && ctx.recv && !new RegExp(String.raw`^${escapeRe(ctx.recv)}\b`).test(call.args[0]?.clean ?? '')) {
      if (!ctx.helpers.has(name) && !ctx.isConfigHelper(name)) continue;
    }
    if (ctx.isConfigHelper(name)) c.add(m.index, call.close + 1, 'helper', 3, name);
    else if (ctx.helpers.has(name)) c.add(m.index, call.close + 1, 'helper', ctx.helpers.get(name)!, name);
    else if (!ctx.defined.has(name) && isConventionHelper(name)) c.add(m.index, call.close + 1, 'helper', 2, name);
  }
}

// ---- JS / TS -----------------------------------------------------------

const JS_MODS = new Set([
  'not', 'resolves', 'rejects', 'to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of',
  'same', 'but', 'does', 'still', 'also', 'deep', 'nested', 'own', 'ordered', 'any', 'all', 'itself',
]);
const JS_EXACT = new Set(
  'toBe toEqual toStrictEqual toBeCloseTo toBeNull toBeUndefined toBeNaN toHaveLength toHaveBeenCalledWith toHaveBeenNthCalledWith toHaveBeenLastCalledWith toHaveBeenCalledTimes toHaveReturnedWith toHaveText toHaveValue toHaveURL toHaveTitle toHaveCount equal equals eq eql eqls closeTo lengthOf length null undefined NaN'.split(' '),
);
// Everything else (toContain, toMatch, chai include/match/a/an, jest-dom matchers) grades as partial.
const JS_EXIST = new Set('toBeDefined toBeTruthy toBeFalsy ok exist exists true false empty defined truthy falsy'.split(' '));
const JS_SNAPSHOT = new Set('toMatchSnapshot toMatchInlineSnapshot toThrowErrorMatchingSnapshot toThrowErrorMatchingInlineSnapshot toHaveScreenshot'.split(' '));
const JS_THROW = new Set(['toThrow', 'toThrowError', 'throw', 'throws', 'Throw']);

interface Chain {
  name: string;
  mods: Set<string>;
  args: string[];
  end: number;
}

function parseJsChain(scan: ScannedSource, from: number, limit: number): Chain | undefined {
  const { skeleton: s } = scan;
  const mods = new Set<string>();
  let p = from;
  for (;;) {
    while (p < limit && /\s/.test(s[p] ?? '')) p += 1;
    if (s[p] !== '.') return undefined;
    p += 1;
    while (p < limit && /\s/.test(s[p] ?? '')) p += 1;
    const id = /^[A-Za-z_$][\w$]*/.exec(s.slice(p, p + 80));
    if (!id) return undefined;
    const name = id[0];
    p += name.length;
    let q = p;
    while (q < limit && /\s/.test(s[q] ?? '')) q += 1;
    if (s[q] === '(') {
      const call = callAt(scan, q, p);
      if (!call) return undefined;
      if (name === 'a' || name === 'an' || !JS_MODS.has(name)) return { name, mods, args: call.args.map((a) => a.clean), end: call.close + 1 };
      mods.add(name);
      p = call.close + 1;
    } else if (JS_MODS.has(name)) {
      mods.add(name);
    } else {
      return { name, mods, args: [], end: p };
    }
  }
}

function classifyJs(chain: Chain, actual: string | undefined): { kind: AssertionKind; strength: AssertionStrength } {
  const { name, mods, args } = chain;
  if (actual !== undefined && isLiteral(actual)) return { kind: 'trivial', strength: 0 };
  if (JS_THROW.has(name)) {
    if (mods.has('not')) return { kind: 'no-throw', strength: 1 };
    return { kind: 'throws', strength: args.length > 0 ? 3 : 2 };
  }
  if (JS_SNAPSHOT.has(name)) return { kind: 'snapshot', strength: 2 };
  if (/^toHaveBeen|^toHaveReturned/.test(name)) {
    const exact = JS_EXACT.has(name);
    return { kind: 'mock-verify', strength: mods.has('not') ? 2 : exact ? 3 : 2 };
  }
  if (mods.has('not')) {
    if (/^(?:toBeNull|toBeUndefined|toBeNaN|null|undefined)$/.test(name) || JS_EXIST.has(name)) return { kind: 'existence', strength: 1 };
    return { kind: 'partial', strength: 2 };
  }
  if (JS_EXIST.has(name)) return { kind: 'existence', strength: 1 };
  if (JS_EXACT.has(name)) {
    if (args.length > 0 && actual !== undefined && same(args[0]!, actual)) return { kind: 'trivial', strength: 0 };
    return { kind: 'exact', strength: 3 };
  }
  return { kind: 'partial', strength: 2 };
}

const NODE_ASSERT_EXACT = new Set('strictEqual deepStrictEqual equal deepEqual isNull isUndefined isTrue isFalse'.split(' '));
const NODE_ASSERT_EXISTS = new Set('ok isOk exists isDefined isNotNull isNotEmpty isTruthy notOk'.split(' '));

function jsSites(ctx: AssertContext, c: Collector): { property: boolean } {
  const { scan } = ctx;
  let property = false;
  eachCall(ctx, /(?<![\w$.])expect\s*(?:\.\s*(?:soft|poll)\s*)?\(/, (m, call) => {
    const chain = parseJsChain(scan, call.close + 1, ctx.to);
    if (!chain) return;
    const { kind, strength } = classifyJs(chain, call.args[0]?.clean ?? '');
    c.add(m.index, chain.end, kind, strength);
  });
  eachCall(ctx, /(?<![\w$.])(?:expect|assert)\s*\.\s*fail\s*\(/, (m, call) => c.add(m.index, call.close + 1, 'fail-call', 2));
  eachCall(ctx, /(?<![\w$.])assert(?:\s*\.\s*(?!fail\b)(\w+))?\s*\(/, (m, call) => {
    const name = m[1] ?? 'ok';
    const a = call.args.map((x) => x.clean);
    let kind: AssertionKind = 'partial';
    let strength: AssertionStrength = 2;
    if (/^(?:throws|rejects|doesNotThrow|doesNotReject|throwsAsync)$/.test(name)) {
      if (/^doesNot/.test(name)) [kind, strength] = ['no-throw', 1];
      else [kind, strength] = ['throws', a.length >= 2 ? 3 : 2];
    } else if (NODE_ASSERT_EXISTS.has(name) || name === 'ok') {
      [kind, strength] = ['existence', 1];
      if (a[0] !== undefined && isLiteral(a[0])) [kind, strength] = ['trivial', 0];
    } else if (NODE_ASSERT_EXACT.has(name)) {
      [kind, strength] = /^is(?:True|False)$/.test(name) ? ['existence', 1] : ['exact', 3];
      if (a.length >= 2 && (same(a[0]!, a[1]!) || (isLiteral(a[0]!) && isLiteral(a[1]!)))) [kind, strength] = ['trivial', 0];
    }
    c.add(m.index, call.close + 1, kind, strength);
  });
  eachCall(ctx, /(?<![\w$.])t\s*\.\s*(is|not|deepEqual|notDeepEqual|like|regex|notRegex|throws|throwsAsync|notThrows|notThrowsAsync|true|truthy|false|falsy|pass|fail|snapshot)\s*\(/, (m, call) => {
    const name = m[1]!;
    const a = call.args.map((x) => x.clean);
    let kind: AssertionKind = 'partial';
    let strength: AssertionStrength = 2;
    if (name === 'is' || name === 'deepEqual') {
      [kind, strength] = a.length >= 2 && same(a[0]!, a[1]!) ? ['trivial', 0] : ['exact', 3];
    } else if (name === 'pass') [kind, strength] = ['trivial', 0];
    else if (name === 'fail') [kind, strength] = ['fail-call', 2];
    else if (name === 'snapshot') [kind, strength] = ['snapshot', 2];
    else if (/^notThrows/.test(name)) [kind, strength] = ['no-throw', 1];
    else if (/^throws/.test(name)) [kind, strength] = ['throws', 2];
    else if (/^(?:true|truthy|false|falsy)$/.test(name)) [kind, strength] = a[0] !== undefined && isLiteral(a[0]) ? ['trivial', 0] : ['existence', 1];
    c.add(m.index, call.close + 1, kind, strength);
  });
  // `x.should.equal(1)` chains
  const should = /\.\s*should\s*(?=\.)/g;
  should.lastIndex = ctx.from;
  let sm: RegExpExecArray | null;
  while ((sm = should.exec(scan.skeleton)) !== null && sm.index < ctx.to) {
    const chain = parseJsChain(scan, sm.index + sm[0].length, ctx.to);
    if (!chain) continue;
    const { kind, strength } = classifyJs(chain, undefined);
    c.add(sm.index, chain.end, kind, strength);
  }
  eachCall(ctx, /(?<![\w$.])(?:fc|jsc)\s*\.\s*(assert|check)\s*\(/, (m, call) => {
    property = true;
    c.add(m.index, call.close + 1, 'property', 3);
  });
  if (countMatches(ctx, /(?<![\w$.])(?:fc|jsc)\s*\.\s*property\s*\(/) > 0) property = true;
  helperSites(ctx, c, new Set(['expectTypeOf', 'assertType']), { methodPrefix: '(?:this\\s*\\.\\s*)?' });
  return { property };
}

// ---- Python ------------------------------------------------------------

const PY_EXACT = new Set(
  'assertEqual assertEquals assertListEqual assertDictEqual assertTupleEqual assertSetEqual assertSequenceEqual assertMultiLineEqual assertCountEqual assertAlmostEqual assertAlmostEquals assertIs assertRaisesRegex assertWarnsRegex'.split(' '),
);
const PY_PARTIAL = new Set(
  'assertNotEqual assertNotEquals assertIn assertNotIn assertGreater assertGreaterEqual assertLess assertLessEqual assertRegex assertNotRegex assertIsInstance assertNotIsInstance assertRaises assertWarns assertLogs assertNoLogs assertIsNone assertIsNot assertNotAlmostEqual'.split(' '),
);

function pySites(ctx: AssertContext, c: Collector): void {
  const { scan } = ctx;
  const { skeleton: s, clean } = scan;
  // `assert <expr>[, message]` statements
  const re = /(?<![\w.])assert\s+(?!=)/g;
  re.lastIndex = ctx.from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null && m.index < ctx.to) {
    const lineStart = s.lastIndexOf('\n', m.index) + 1;
    if (!/^[ \t;]*$/.test(s.slice(lineStart, m.index))) continue;
    let depth = 0;
    let end = m.index + m[0].length;
    for (; end < ctx.to; end += 1) {
      const ch = s[end]!;
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      else if (ch === '\n' && depth <= 0) break;
      else if (ch === ';' && depth === 0) break;
    }
    const start = m.index + m[0].length;
    const parts = splitTopLevel(s, start, end);
    const [a, b] = parts[0] ?? [start, end];
    const expr = clean.slice(a, b).trim();
    const mask = maskNested(s.slice(a, b));
    let kind: AssertionKind = 'existence';
    let strength: AssertionStrength = 1;
    if (isLiteral(expr)) {
      [kind, strength] = ['trivial', 0];
    } else if (/(?<![=!<>])==(?!=)/.test(mask)) {
      const sides = expr.split(/(?<![=!<>])==(?!=)/);
      [kind, strength] = sides.length === 2 && same(sides[0]!, sides[1]!) ? ['trivial', 0] : ['exact', 3];
    } else if (/\bis\s+(?:not\s+)?None\b/.test(mask)) {
      [kind, strength] = ['existence', 1];
    } else if (/!=|\bnot\s+in\b|\bin\b|\bis\b|<|>/.test(mask.replace(/->|>>|<<|=>/g, ' ')) || /\b(?:isinstance|re\.(?:match|search|fullmatch))\s*\(|\.(?:startswith|endswith)\s*\(/.test(s.slice(a, b))) {
      [kind, strength] = ['partial', 2];
    }
    c.add(m.index, end, kind, strength);
  }
  eachCall(ctx, /(?<![\w.])self\s*\.\s*(assert\w+|fail|assertRaises)\s*\(/, (m, call) => {
    const name = m[1]!;
    const args = call.args.map((x) => x.clean);
    if (ctx.helpers.has(name) || ctx.defined.has(name)) return; // a same-file method: counted as a helper below
    let kind: AssertionKind = 'partial';
    let strength: AssertionStrength = 2;
    if (name === 'fail') [kind, strength] = ['fail-call', 2];
    else if (name === 'assertTrue' || name === 'assertFalse') {
      [kind, strength] = /==|\.equals\(/.test(call.args[0]?.skel ?? '') ? ['exact', 3] : ['existence', 1];
      if (args[0] !== undefined && isLiteral(args[0])) [kind, strength] = ['trivial', 0];
    } else if (name === 'assertIsNotNone') [kind, strength] = ['existence', 1];
    else if (PY_EXACT.has(name)) {
      [kind, strength] = name.includes('Raises') || name.includes('Warns') ? ['throws', 3] : ['exact', 3];
      if (args.length >= 2 && /Equal|Is$/.test(name) && same(args[0]!, args[1]!)) [kind, strength] = ['trivial', 0];
    } else if (PY_PARTIAL.has(name)) {
      [kind, strength] = /^assertRaises|^assertWarns/.test(name) ? ['throws', 2] : ['partial', 2];
    } else if (!isConventionHelper(name) && !name.startsWith('assert')) return;
    c.add(m.index, call.close + 1, kind, strength);
  });
  eachCall(ctx, /(?<![\w.])pytest\s*\.\s*(raises|warns|deprecated_call)\s*\(/, (m, call) => {
    c.add(m.index, call.close + 1, 'throws', call.args.some((a) => /^match\s*=/.test(a.clean)) ? 3 : 2);
  });
  eachCall(ctx, /(?<![\w.])pytest\s*\.\s*fail\s*\(/, (m, call) => c.add(m.index, call.close + 1, 'fail-call', 2));
  eachCall(ctx, /(?<![\w.])assert_that\s*\(/, (m, call) => {
    if (call.args.length >= 2) {
      c.add(m.index, call.close + 1, /^(?:equal_to|is_\s*\(\s*equal_to)\(|^is_\(/.test(call.args[1]!.clean) ? 'exact' : 'partial', /^(?:equal_to|is_)\(/.test(call.args[1]!.clean) ? 3 : 2);
      return;
    }
    const chain = /^\s*\.\s*(\w+)\s*\(/.exec(s.slice(call.close + 1, call.close + 60));
    const name = chain?.[1] ?? '';
    if (/^is_equal_to$/.test(name)) c.add(m.index, call.close + 1, 'exact', 3);
    else if (/^(?:is_not_none|is_true|is_false|is_not_empty|is_none)$/.test(name)) c.add(m.index, call.close + 1, 'existence', 1);
    else c.add(m.index, call.close + 1, chain ? 'partial' : 'trivial', chain ? 2 : 0);
  });
  eachCall(ctx, /\.\s*(assert_called_once_with|assert_called_with|assert_any_call|assert_has_calls|assert_awaited_once_with|assert_awaited_with|assert_awaited_once|assert_awaited|assert_called_once|assert_called|assert_not_called|assert_not_awaited)\s*\(/, (m, call) => {
    c.add(m.index, call.close + 1, 'mock-verify', /_with$|any_call|has_calls/.test(m[1]!) ? 3 : 2);
  });
  eachCall(ctx, /(?<![\w])(?:(?:np|numpy|pd|pandas)\s*\.\s*testing|npt|pdt)\s*\.\s*assert_\w+\s*\(/, (m, call) => c.add(m.index, call.close + 1, 'exact', 3));
  helperSites(ctx, c, new Set(['assert_that']), { methodPrefix: '(?:self\\s*\\.\\s*|cls\\s*\\.\\s*)?' });
}

// ---- Go ----------------------------------------------------------------

const GO_TESTIFY_EXACT = new Set('Equal EqualValues Exactly JSONEq YAMLEq ElementsMatch Len EqualError ErrorIs ErrorAs ErrorContains InDelta InEpsilon Same Zero PanicsWithValue PanicsWithError'.split(' '));
const GO_TESTIFY_PARTIAL = new Set('Contains Subset Greater GreaterOrEqual Less LessOrEqual Regexp IsType Implements Error Panics Empty NotEqual NotContains NotSame NotZero'.split(' '));

/** The condition of the innermost enclosing `if` of `offset`, or undefined. */
function enclosingIf(skel: string, bodyStart: number, offset: number): string | undefined {
  let depth = 0;
  for (let i = offset - 1; i >= bodyStart; i -= 1) {
    const ch = skel[i];
    if (ch === '}') depth += 1;
    else if (ch === '{') {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      const lineStart = skel.lastIndexOf('\n', i) + 1;
      const header = skel.slice(lineStart, i);
      const m = /^\s*(?:\}\s*else\s+)?if\b(.*)$/.exec(header);
      if (m) {
        const cond = m[1]!;
        const semi = cond.lastIndexOf(';');
        return semi >= 0 ? cond.slice(semi + 1) : cond;
      }
    }
  }
  return undefined;
}

function goSites(ctx: AssertContext, c: Collector): void {
  const { scan } = ctx;
  const s = scan.skeleton;
  const recv = ctx.recv ?? 't';
  eachCall(ctx, new RegExp(String.raw`(?<![\w.])${escapeRe(recv)}\s*\.\s*(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(`), (m, call) => {
    const cond = enclosingIf(s, ctx.from, m.index);
    let kind: AssertionKind = 'fail-call';
    let strength: AssertionStrength = 2;
    if (cond !== undefined) {
      if (/\b(?:err|\w*Err\w*|\w*err\w*)\s*!=\s*nil/.test(cond)) [kind, strength] = ['error-check', 1];
      else if (/reflect\.DeepEqual|cmp\.Diff|\.Equal\s*\(|\bbytes\.Equal/.test(cond)) [kind, strength] = ['exact', 3];
      else if (/(?:==|!=)\s*nil\b|\bnil\s*(?:==|!=)|!\s*ok\b|!\s*found\b|\bok\b\s*==\s*false/.test(cond)) [kind, strength] = ['existence', 1];
      else if (/(?:==|!=)/.test(cond)) [kind, strength] = ['exact', 3];
    }
    c.add(m.index, call.close + 1, kind, strength);
  });
  eachCall(ctx, /(?<![\w.])(?:assert|require)\s*\.\s*(\w+)\s*\(/, (m, call) => {
    let name = m[1]!;
    const known = (n: string): boolean =>
      GO_TESTIFY_EXACT.has(n) || GO_TESTIFY_PARTIAL.has(n) || /^(?:True|False|NotNil|NotEmpty|NoError|Nil|NotPanics|Fail|FailNow)$/.test(n);
    if (!known(name) && name.endsWith('f') && known(name.slice(0, -1))) name = name.slice(0, -1);
    const args = call.args.slice(1).map((x) => x.clean);
    let kind: AssertionKind = 'partial';
    let strength: AssertionStrength = 2;
    if (GO_TESTIFY_EXACT.has(name)) {
      [kind, strength] = ['exact', 3];
      if (/^(?:Equal|EqualValues|Exactly)$/.test(name) && args.length >= 2 && same(args[0]!, args[1]!)) [kind, strength] = ['trivial', 0];
    } else if (name === 'True' || name === 'False') {
      [kind, strength] = /==/.test(call.args[1]?.skel ?? '') ? ['exact', 3] : ['existence', 1];
      if (args[0] !== undefined && isLiteral(args[0])) [kind, strength] = ['trivial', 0];
    } else if (name === 'NotNil' || name === 'NotEmpty') [kind, strength] = ['existence', 1];
    else if (name === 'NoError' || name === 'Nil') [kind, strength] = /err/i.test(args[0] ?? '') ? ['error-check', 1] : ['existence', 1];
    else if (name === 'NotPanics') [kind, strength] = ['no-throw', 1];
    else if (/^Panics/.test(name)) [kind, strength] = ['throws', name === 'Panics' ? 2 : 3];
    else if (name === 'Fail' || name === 'FailNow') [kind, strength] = ['fail-call', 2];
    else if (!GO_TESTIFY_PARTIAL.has(name) && !/^[A-Z]/.test(name)) return;
    c.add(m.index, call.close + 1, kind, strength);
  });
  eachCall(ctx, /(?<![\w.])(Expect|Eventually|Consistently)\s*\(/, (m, call) => {
    const next = /^\s*\.\s*(To|ToNot|NotTo|Should|ShouldNot)\s*\(/.exec(s.slice(call.close + 1, call.close + 40));
    if (!next) return;
    const open = call.close + 1 + next[0].length - 1;
    const inner = callAt(scan, open, call.close + 1);
    if (!inner) return;
    const negated = /Not/.test(next[1]!);
    const matcher = inner.args[0]?.clean ?? '';
    let kind: AssertionKind = 'partial';
    let strength: AssertionStrength = 2;
    if (/^(?:Equal|BeEquivalentTo|MatchJSON|MatchYAML|ConsistOf|HaveLen|BeIdenticalTo|BeNumerically\(\s*"=="|BeZero)\b/.test(matcher)) [kind, strength] = negated ? ['partial', 2] : ['exact', 3];
    else if (/^(?:Succeed|HaveOccurred|MatchError)\b/.test(matcher)) [kind, strength] = ['error-check', 1];
    else if (/^(?:BeNil|BeTrue|BeFalse|BeEmpty|Not\()/.test(matcher)) [kind, strength] = /err/i.test(call.args[0]?.clean ?? '') ? ['error-check', 1] : ['existence', 1];
    c.add(m.index, inner.close + 1, kind, strength);
  });
  if (/\bis\s*\.\s*New\s*\(/.test(scan.clean)) {
    eachCall(ctx, /(?<![\w.])is\s*\.\s*(Equal|NoErr|True|OK|Fail)\s*\(/, (m, call) => {
      const name = m[1]!;
      if (name === 'Equal') c.add(m.index, call.close + 1, same(call.args[0]?.clean ?? 'a', call.args[1]?.clean ?? 'b') ? 'trivial' : 'exact', same(call.args[0]?.clean ?? 'a', call.args[1]?.clean ?? 'b') ? 0 : 3);
      else if (name === 'NoErr') c.add(m.index, call.close + 1, 'error-check', 1);
      else if (name === 'Fail') c.add(m.index, call.close + 1, 'fail-call', 2);
      else c.add(m.index, call.close + 1, 'existence', 1);
    });
  }
  helperSites(ctx, c, new Set(['Expect', 'Eventually', 'Consistently']), { needsRecv: true });
}

// ---- Rust --------------------------------------------------------------

function rustSites(ctx: AssertContext, c: Collector): { property: boolean } {
  let property = false;
  eachCall(ctx, /(?<![\w])(debug_assert|prop_assert|assert)(_eq|_ne)?\s*!\s*[([{]/, (m, call) => {
    if (m[1] === 'prop_assert') property = true;
    const a = call.args.map((x) => x.clean);
    let kind: AssertionKind = 'exact';
    let strength: AssertionStrength = 3;
    if (m[2] === '_eq') {
      if (a.length >= 2 && (same(a[0]!, a[1]!) || (isLiteral(a[0]!) && isLiteral(a[1]!)))) [kind, strength] = ['trivial', 0];
    } else if (m[2] === '_ne') {
      [kind, strength] = ['partial', 2];
    } else {
      const cond = a[0] ?? '';
      const mask = maskNested(call.args[0]?.skel ?? '');
      if (cond === 'true' || cond === 'false' || isLiteral(cond)) [kind, strength] = ['trivial', 0];
      else if (/(?<![=!<>])==(?!=)/.test(mask)) {
        const sides = cond.split(/(?<![=!<>])==(?!=)/);
        [kind, strength] = sides.length === 2 && same(sides[0]!, sides[1]!) ? ['trivial', 0] : ['exact', 3];
      } else if (/\.is_ok\(\)/.test(cond)) [kind, strength] = ['error-check', 1];
      else if (/\.is_(?:some|none)\(\)/.test(cond)) [kind, strength] = ['existence', 1];
      else if (/matches!|\.is_err\(\)|\.contains\(|\.starts_with\(|\.ends_with\(|!=|<|>/.test(cond.replace(/->|=>/g, ' '))) [kind, strength] = ['partial', 2];
      else [kind, strength] = ['existence', 1];
    }
    c.add(m.index, call.close + 1, kind, strength);
  });
  eachCall(ctx, /(?<![\w])assert_(\w+)\s*!\s*[([{]/, (m, call) => {
    const name = m[1]!;
    if (/^(?:eq|ne)$/.test(name)) return;
    if (/snapshot$/.test(name)) c.add(m.index, call.close + 1, 'snapshot', 2);
    else if (/^(?:approx_eq|relative_eq|abs_diff_eq|ulps_eq|float_eq)$/.test(name)) c.add(m.index, call.close + 1, 'exact', 3);
    else c.add(m.index, call.close + 1, 'partial', 2);
  });
  eachCall(ctx, /(?<![\w])panic\s*!\s*[([{]/, (m, call) => c.add(m.index, call.close + 1, 'fail-call', 2));
  helperSites(ctx, c, new Set());
  return { property };
}

// ---- Java / Kotlin -----------------------------------------------------

const JUNIT_EXACT = new Set('assertEquals assertArrayEquals assertIterableEquals assertLinesMatch assertSame assertContentEquals'.split(' '));
const JUNIT_PARTIAL = new Set('assertNotEquals assertNotSame assertThrows assertThrowsExactly assertInstanceOf assertNull assertFailsWith assertFails assertContains assertIs assertIsNot'.split(' '));
const JUNIT_OTHER = new Set('assertTrue assertFalse assertNotNull assertDoesNotThrow assertAll assertTimeout assertTimeoutPreemptively assertThat'.split(' '));
const ASSERTJ_MODIFIERS = new Set(
  'as describedAs withFailMessage overridingErrorMessage usingRecursiveComparison usingComparator usingDefaultComparator usingElementComparator extracting ignoringFields ignoringActualNullFields ignoringAllOverriddenEquals comparingOnlyFields filteredOn using withRepresentation'.split(' '),
);
const ASSERTJ_EXACT = new Set(
  'isEqualTo isEqualByComparingTo isEqualToIgnoringCase isEqualToComparingFieldByField containsExactly containsExactlyInAnyOrder hasSize hasMessage hasToString isCloseTo isZero isOne hasFieldOrPropertyWithValue isEqualToIgnoringWhitespace isSameAs hasSameSizeAs containsSequence isNull'.split(' '),
);
const ASSERTJ_WEAK = new Set('isNotNull isNotEmpty isPresent isNotBlank isNotZero isNotEmpty isNotNegative isNotPositive'.split(' '));
const HAMCREST_EXACT = /^(?:is\s*\(\s*equalTo|equalTo|equalToIgnoringCase|closeTo|hasSize|containsInAnyOrder|contains)\s*\(|^is\s*\(\s*(?:["'\d-]|true|false|null)/;
const MOCKITO_MATCHER = /\b(?:any\w*|eq|argThat|isA|contains|startsWith|endsWith|matches|notNull|isNull|same|ArgumentMatchers\s*\.\s*\w+)\s*\(/;
const KOTEST_EXACT = new Set('shouldBe shouldBeEqualComparingTo shouldHaveSize shouldContainExactly shouldContainExactlyInAnyOrder shouldHaveLength shouldBeSameInstanceAs shouldHaveSingleElement shouldBeNull shouldBeZero shouldBeTrue shouldBeFalse'.split(' '));
const KOTEST_WEAK = new Set('shouldNotBeNull shouldNotBeEmpty shouldNotBeBlank shouldNotThrowAny shouldNotThrow'.split(' '));

/** `.name(args)` links after a call, as in AssertJ and Strikt chains. */
function parseCallChain(scan: ScannedSource, from: number): { names: string[]; args: string[][]; end: number } {
  const names: string[] = [];
  const args: string[][] = [];
  let p = from;
  const s = scan.skeleton;
  for (;;) {
    const m = /^\s*\.\s*(\w+)\s*(?:<[^()<>]*>)?\s*\(/.exec(s.slice(p, p + 200));
    if (!m) break;
    const open = p + m[0].length - 1;
    const call = callAt(scan, open, p);
    if (!call) break;
    names.push(m[1]!);
    args.push(call.args.map((a) => a.clean));
    p = call.close + 1;
  }
  return { names, args, end: p };
}

function jvmSites(ctx: AssertContext, c: Collector): void {
  const { scan } = ctx;
  const s = scan.skeleton;
  eachCall(ctx, /(?<![\w.])(?:(?:Assertions|Assert|MatcherAssert)\s*\.\s*)?(assert[A-Z]\w*|fail)\s*(?:<[^()<>]*>)?\s*[({]/, (m, call) => {
    const name = m[1]!;
    if (name.startsWith('assertThat') || name === 'assertThat') return;
    if (ctx.defined.has(name) && !JUNIT_EXACT.has(name) && !JUNIT_PARTIAL.has(name) && !JUNIT_OTHER.has(name)) return;
    const a = call.args.map((x) => x.clean);
    // JUnit 5 puts the message last, JUnit 4 first: judge the two value arguments by shape.
    const value = a.filter((x) => !/^".*"$/.test(x) || a.length <= 2);
    let kind: AssertionKind | undefined;
    let strength: AssertionStrength = 2;
    if (name === 'fail') [kind, strength] = ['fail-call', 2];
    else if (name === 'assertTrue' || name === 'assertFalse') {
      const arg = a.find((x) => !/^"/.test(x)) ?? a[0] ?? '';
      [kind, strength] = /==|\.equals\(/.test(arg) ? ['exact', 3] : ['existence', 1];
      if (isLiteral(arg)) [kind, strength] = ['trivial', 0];
    } else if (name === 'assertNotNull') [kind, strength] = ['existence', 1];
    else if (name === 'assertDoesNotThrow') [kind, strength] = ['no-throw', 1];
    else if (name === 'assertAll' || /^assertTimeout/.test(name)) return;
    else if (JUNIT_EXACT.has(name)) {
      [kind, strength] = ['exact', 3];
      if (value.length >= 2 && same(value[0]!, value[1]!)) [kind, strength] = ['trivial', 0];
    } else if (JUNIT_PARTIAL.has(name)) [kind, strength] = /^assertThrows|^assertFail/.test(name) ? ['throws', 2] : ['partial', 2];
    if (kind) c.add(m.index, call.close + 1, kind, strength);
  });
  eachCall(ctx, /(?<![\w.])(?:Assertions\s*\.\s*|BDDAssertions\s*\.\s*)?(assertThat\w*|expectThat)\s*(?:<[^()<>]*>)?\s*\(/, (m, call) => {
    const name = m[1]!;
    const chain = parseCallChain(scan, call.close + 1);
    if (name === 'assertThat' && call.args.length >= 2) {
      // Hamcrest: assertThat([reason,] actual, matcher)
      const matcher = call.args[call.args.length - 1]!.clean;
      const nullish = /^(?:notNullValue|not\s*\(\s*nullValue|nullValue)\b/.test(matcher);
      c.add(m.index, call.close + 1, nullish ? 'existence' : HAMCREST_EXACT.test(matcher) ? 'exact' : 'partial', nullish ? 1 : HAMCREST_EXACT.test(matcher) ? 3 : 2);
      return;
    }
    const end = Math.max(chain.end, call.close + 1);
    if (/^assertThat(?:Thrown|Exception|Code|NoException|Illegal|Null|Throw)/.test(name) || /^assertThat[A-Z]\w*Exception$/.test(name)) {
      const names = chain.names;
      if (names.some((n) => /^doesNotThrow/.test(n)) || name === 'assertThatNoException') c.add(m.index, end, 'no-throw', 1);
      else if (names.some((n) => /^(?:hasMessage|withMessage|hasStackTraceContaining)$/.test(n))) c.add(m.index, end, 'throws', 3);
      else if (names.length === 0 && name === 'assertThatCode') c.add(m.index, end, 'trivial', 0);
      else c.add(m.index, end, 'throws', 2);
      return;
    }
    const matchers = chain.names.filter((n) => !ASSERTJ_MODIFIERS.has(n));
    if (matchers.length === 0) {
      c.add(m.index, end, 'trivial', 0);
      return;
    }
    const actual = call.args[0]?.clean ?? '';
    let best: { kind: AssertionKind; strength: AssertionStrength } = { kind: 'partial', strength: 2 };
    let top: AssertionStrength = 0;
    matchers.forEach((n, idx) => {
      let cur: { kind: AssertionKind; strength: AssertionStrength };
      const cargs = chain.args[chain.names.indexOf(n)] ?? [];
      if (/^is(?:True|False)$/.test(n)) cur = /==|\.equals\(/.test(actual) ? { kind: 'exact', strength: 3 } : { kind: 'existence', strength: 1 };
      else if (ASSERTJ_EXACT.has(n)) cur = { kind: 'exact', strength: 3 };
      else if (ASSERTJ_WEAK.has(n)) cur = { kind: 'existence', strength: 1 };
      else cur = { kind: 'partial', strength: 2 };
      if (n === 'isEqualTo' && cargs[0] !== undefined && same(cargs[0], actual)) cur = { kind: 'trivial', strength: 0 };
      if (idx === 0 || cur.strength > top) {
        best = cur;
        top = cur.strength;
      }
    });
    if (isLiteral(actual) && best.kind !== 'trivial') best = { kind: 'trivial', strength: 0 };
    c.add(m.index, end, best.kind, best.strength);
  });
  eachCall(ctx, /(?<![\w.])verify\s*\(/, (m, call) => {
    const after = /^\s*\.\s*\w+\s*\(/.exec(s.slice(call.close + 1, call.close + 120));
    let end = call.close + 1;
    let args = '';
    if (after) {
      const inner = callAt(scan, call.close + after[0].length, call.close + 1);
      if (inner) {
        end = inner.close + 1;
        args = scan.clean.slice(inner.open + 1, inner.close);
      }
    }
    const loose = call.args.length > 1 || MOCKITO_MATCHER.test(args);
    c.add(m.index, end, 'mock-verify', loose ? 2 : 3);
  });
  eachCall(ctx, /(?<![\w.])verify(?:NoMoreInteractions|NoInteractions|ZeroInteractions)\s*\(/, (m, call) => c.add(m.index, call.close + 1, 'mock-verify', 2));
  const kotest = /(?<![\w])(should(?:Not)?[A-Z]\w*)\b/g;
  kotest.lastIndex = ctx.from;
  let km: RegExpExecArray | null;
  while ((km = kotest.exec(s)) !== null && km.index < ctx.to) {
    const name = km[1]!;
    const lineEnd = s.indexOf('\n', km.index);
    const text = scan.clean.slice(km.index, lineEnd < 0 ? ctx.to : Math.min(lineEnd, ctx.to));
    const lineStart = s.lastIndexOf('\n', km.index) + 1;
    const left = scan.clean.slice(lineStart, km.index).trim();
    let kind: AssertionKind = 'partial';
    let strength: AssertionStrength = 2;
    if (/^shouldThrow|^shouldNotThrow/.test(name)) [kind, strength] = name.startsWith('shouldNot') ? ['no-throw', 1] : ['throws', 2];
    else if (KOTEST_EXACT.has(name)) [kind, strength] = ['exact', 3];
    else if (KOTEST_WEAK.has(name)) [kind, strength] = ['existence', 1];
    if (name === 'shouldBe' && left !== '' && new RegExp(String.raw`^${escapeRe(left)}\b`).test(text.slice(name.length).trim())) [kind, strength] = ['trivial', 0];
    c.add(km.index, km.index + Math.max(text.length, name.length), kind, strength);
  }
  const known = new Set([...JUNIT_EXACT, ...JUNIT_PARTIAL, ...JUNIT_OTHER, 'expectThat', 'verify', 'fail']);
  helperSites(ctx, c, known, { methodPrefix: '(?:this\\s*\\.\\s*)?', reservedRe: /^(?:assertThat|should|verify(?:NoMoreInteractions|NoInteractions|ZeroInteractions))/ });
}

// ---- Annotations / attributes above a test -----------------------------

/** Sites declared outside the body: `@Test(expected = X.class)`, `#[should_panic]`; and whether the test is a property test. */
export function preludeScan(lang: SourceLanguage, prelude: string, line: number): { sites: AssertionSite[]; property: boolean } {
  const sites: AssertionSite[] = [];
  let property = false;
  if (lang === 'jvm') {
    if (/@\s*(?:[\w.]*\.)?Test\s*\([^)]*\bexpected\s*=/.test(prelude)) sites.push({ line, kind: 'throws', strength: 2, text: '@Test(expected = ...)' });
    if (/@\s*(?:[\w.]*\.)?Property\b/.test(prelude)) property = true;
  } else if (lang === 'rust') {
    const sp = /#\[\s*should_panic\s*(\([^\]]*\))?\s*\]/.exec(prelude);
    if (sp) sites.push({ line, kind: 'throws', strength: sp[1] && /expected\s*=/.test(sp[1]) ? 3 : 2, text: brief(sp[0]) });
    if (/#\[\s*quickcheck\s*\]/.test(prelude)) property = true;
  } else if (lang === 'python') {
    if (/(?:^|\n)\s*@\s*(?:hypothesis\s*\.\s*)?given\s*\(/.test(prelude)) property = true;
  }
  return { sites, property };
}

const WILDCARDS: Record<SourceLanguage, RegExp> = {
  js: /(?<![\w$])expect\s*\.\s*(?:any|anything|objectContaining|stringContaining)\s*\(/,
  python: /(?<![\w.])(?:mock\s*\.\s*)?ANY\b/,
  go: /(?<![\w.])(?:gomock\s*\.\s*)?(?:Any|AnyOf)\s*\(\s*\)|\bmock\.Anything\b|\bmock\.AnythingOfType\b/,
  rust: /(?<![\w])(?:predicate\s*::\s*always|any)\s*\(\s*\)/,
  jvm: /(?<![\w.])(?:any|anyString|anyInt|anyLong|anyList|anyMap|anyBoolean|anyDouble|anything)\s*\(/,
};

/** Find the assertion sites inside a body. */
export function findSites(ctx: AssertContext): SiteScan {
  const c = new Collector(ctx.scan);
  let property = false;
  let lenientCalls = 0;
  switch (ctx.lang) {
    case 'js':
      property = jsSites(ctx, c).property;
      break;
    case 'python':
      pySites(ctx, c);
      break;
    case 'go':
      goSites(ctx, c);
      break;
    case 'rust':
      property = rustSites(ctx, c).property;
      lenientCalls = countMatches(ctx, /\.\s*unwrap\s*\(\s*\)|\.\s*expect\s*\(/);
      break;
    case 'jvm':
      jvmSites(ctx, c);
      break;
  }
  c.sites.sort((a, b) => a.line - b.line);
  return { sites: c.sites, property, wildcards: countMatches(ctx, WILDCARDS[ctx.lang]), lenientCalls };
}
