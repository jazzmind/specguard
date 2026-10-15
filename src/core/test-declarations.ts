/**
 * Leaf test declarations in test source files, and the claim-tag comment that
 * `spec tag` inserts above one.
 *
 * Only leaf tests (`it`/`test`, a Python `def test_`, a Go `func Test`, a Rust
 * `fn` after `#[test]`) are found, never `describe` blocks: a claim is proven
 * by a test, not by a suite. Spec: specs/capabilities/spec-authoring.md
 */
import { extractClaimRefs } from './claim-tags.js';

export interface TestDeclaration {
  /** 1-based line of the declaration. */
  line: number;
  title: string;
  /** Leading whitespace of the declaration line. */
  indent: string;
  /** True when a claim tag is already on the declaration line or the line above it. */
  tagged: boolean;
}

// `test.describe`, `test.step`, hooks and the like share the `test.` prefix but are not tests.
const NOT_A_TEST = '(?:describe|step|beforeEach|afterEach|beforeAll|afterAll|use|configure|extend|serial|parallel)';
const JS_TEST = new RegExp(String.raw`^(\s*)(?:it|test|specify)(?:\.(?!${NOT_A_TEST}\b)\w+)*\s*\(\s*(['"`+'`'+String.raw`])((?:\\.|(?!\2).)*)\2`);
const PY_TEST = /^(\s*)(?:async\s+)?def\s+(test\w*)/;
const GO_TEST = /^(\s*)func\s+(Test\w*)/;
const RUST_TEST = /^(\s*)(?:async\s+)?fn\s+(\w+)/;

export function scanTestDeclarations(source: string, file: string): TestDeclaration[] {
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
    lines.splice(line - 1, 0, `${decl.indent}${prefix} [claims: ${[...new Set(refs)].join(', ')}]`);
    added += 1;
  }
  return { text: lines.join('\n'), added };
}
