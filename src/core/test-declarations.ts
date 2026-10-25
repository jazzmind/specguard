/**
 * Leaf test declarations in test source files, and the claim-tag comment that
 * `spec tag` inserts above one.
 *
 * Only leaf tests (`it`/`test`, a Python `def test_`, a Go `func Test`, a Rust
 * `fn` after `#[test]`, a Java/Kotlin method carrying a JUnit 4/5 or TestNG
 * test annotation) are found, never `describe` blocks: a claim is proven
 * by a test, not by a suite. Spec: specs/capabilities/spec-authoring.md
 */
import { extractClaimRefs } from './claim-tags.js';

export interface TestDeclaration {
  /** 1-based line of the declaration. */
  line: number;
  title: string;
  /** Leading whitespace of the declaration line (for annotated tests, of the first annotation). */
  indent: string;
  /**
   * 1-based line a claim comment goes above, when it is not `line`: a Java/Kotlin
   * test's first annotation, which sits above the method signature.
   */
  anchor?: number;
  /** True when a claim tag is already on the declaration line or the line above it. */
  tagged: boolean;
}

// `test.describe`, `test.step`, hooks and the like share the `test.` prefix but are not tests.
const NOT_A_TEST = '(?:describe|step|beforeEach|afterEach|beforeAll|afterAll|use|configure|extend|serial|parallel)';
const JS_TEST = new RegExp(String.raw`^(\s*)(?:it|test|specify)(?:\.(?!${NOT_A_TEST}\b)\w+)*\s*\(\s*(['"`+'`'+String.raw`])((?:\\.|(?!\2).)*)\2`);
const PY_TEST = /^(\s*)(?:async\s+)?def\s+(test\w*)/;
const GO_TEST = /^(\s*)func\s+(Test\w*)/;
const RUST_TEST = /^(\s*)(?:async\s+)?fn\s+(\w+)/;

const JAVA_FILE = /\.(?:java|kt)$/;
const JAVA_TEST_ANNOTATION = /^(?:[\w.]*\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)$/;

/** Replace comments with spaces (newlines kept) so line numbers survive; strings and char literals are left intact. */
function blankJavaComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i += 1) out += source[i] === '\n' || source[i] === '\r' ? source[i] : ' ';
    } else if (c === '"' && source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      const stop = end < 0 ? n : end + 3;
      out += source.slice(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Consume annotations at the start of `line`; `depth` is the paren depth carried in from an annotation argument list that spans lines. */
function consumeAnnotations(line: string, depth: number, annotations: string[]): { depth: number; rest: string } {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (depth > 0) {
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
        i = j + 1;
        continue;
      }
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '@') {
      const name = /^@\s*(?:\w+\s*:\s*)?([\w.]+)/.exec(line.slice(i));
      if (!name) return { depth, rest: line.slice(i) };
      annotations.push(name[1]);
      i += name[0].length;
      const open = /^\s*\(/.exec(line.slice(i));
      if (open) {
        depth = 1;
        i += open[0].length;
      }
    } else {
      return { depth, rest: line.slice(i) };
    }
  }
  return { depth, rest: '' };
}

/** JUnit 5 / JUnit 4 / TestNG tests (Java and Kotlin): a method after a test annotation, any other annotations and comments in between. */
function scanJavaTests(source: string, file: string): TestDeclaration[] {
  const kotlin = /\.kt$/.test(file);
  const original = source.split(/\r?\n/);
  const cleaned = blankJavaComments(source).split(/\r?\n/);
  const out: TestDeclaration[] = [];
  let block: { start: number; text: string; annotations: string[]; depth: number } | null = null;
  cleaned.forEach((text, i) => {
    const trimmed = text.trim();
    if (!block) {
      if (!trimmed.startsWith('@') || /^@\s*interface\b/.test(trimmed)) return;
      block = { start: i, text: '', annotations: [], depth: 0 };
    } else if (block.depth === 0 && !trimmed) {
      return;
    }
    block.text += `${text}\n`;
    const { depth, rest } = consumeAnnotations(text, block.depth, block.annotations);
    block.depth = depth;
    if (depth > 0 || !rest.trim()) return;
    const done = block;
    block = null;
    if (!done.annotations.some((a) => JAVA_TEST_ANNOTATION.test(a))) return;
    const method = kotlin
      ? /\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(`[^`]+`|\w+)\s*\(/.exec(rest)
      : /(\w+)\s*\(/.exec(rest);
    if (!method) return;
    const display = /@\s*DisplayName\s*\(\s*(?:value\s*=\s*)?"((?:\\.|[^"\\])*)"/.exec(done.text.replace(/\r/g, ''));
    const title = display ? display[1].replace(/\\(.)/g, '$1') : method[1].replace(/^`|`$/g, '');
    const anchor = done.start + 1;
    const indent = /^\s*/.exec(original[done.start])?.[0] ?? '';
    // A tag counts when it sits in the annotation block or on a comment line of its own just above it.
    const above = (original[done.start - 1] ?? '').trim();
    const aboveIsComment = /^(?:\/\/|\/\*|\*)/.test(above);
    const inBlock = original.slice(done.start, i + 1).some((l) => extractClaimRefs(l).length > 0);
    const tagged = inBlock || (aboveIsComment && extractClaimRefs(above).length > 0);
    out.push({ line: i + 1, title, indent, tagged, ...(anchor === i + 1 ? {} : { anchor }) });
  });
  return out;
}

export function scanTestDeclarations(source: string, file: string): TestDeclaration[] {
  if (JAVA_FILE.test(file)) return scanJavaTests(source, file);
  const lines = source.split(/\r?\n/);
  const rust = /\.rs$/.test(file);
  const out: TestDeclaration[] = [];
  lines.forEach((text, i) => {
    let m = text.match(JS_TEST);
    let indent = m?.[1];
    let title = m?.[3];
    if (!m) {
      m = text.match(PY_TEST) ?? text.match(GO_TEST);
      indent = m?.[1];
      title = m?.[2];
    }
    if (!m && rust && /#\[(?:tokio::)?test/.test(lines[i - 1] ?? '')) {
      m = text.match(RUST_TEST);
      indent = m?.[1];
      title = m?.[2];
    }
    if (!m || title === undefined || indent === undefined) return;
    // The line above counts only when it is a comment of its own: a tag that ends another test's line belongs to that test.
    const prev = lines[i - 1] ?? '';
    const prevIsDeclaration = JS_TEST.test(prev) || PY_TEST.test(prev) || GO_TEST.test(prev);
    const tagged = extractClaimRefs(text).length > 0 || (!prevIsDeclaration && extractClaimRefs(prev).length > 0);
    out.push({ line: i + 1, title, indent, tagged });
  });
  return out;
}

/** The comment syntax of a test file. */
export function commentPrefix(file: string): string {
  return /\.py$/.test(file) ? '#' : '//';
}

/**
 * Insert `[claims: ...]` comments above the given declaration lines. Edits are
 * applied bottom-up so earlier line numbers stay valid; a line already tagged
 * is never touched. Returns the new text and how many comments were added.
 */
export function insertClaimTags(source: string, file: string, edits: Map<number, string[]>): { text: string; added: number } {
  const lines = source.split('\n');
  const declarations = new Map(scanTestDeclarations(source, file).map((d) => [d.line, d]));
  const prefix = commentPrefix(file);
  let added = 0;
  for (const line of [...edits.keys()].sort((a, b) => b - a)) {
    const decl = declarations.get(line);
    const refs = edits.get(line) ?? [];
    if (!decl || decl.tagged || refs.length === 0) continue;
    lines.splice((decl.anchor ?? line) - 1, 0, `${decl.indent}${prefix} [claims: ${[...new Set(refs)].join(', ')}]`);
    added += 1;
  }
  return { text: lines.join('\n'), added };
}
