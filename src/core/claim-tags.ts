/**
 * Claim tags: the deterministic link between a test and an acceptance claim.
 *
 * Forms accepted anywhere in a test title, tag, annotation, or source line:
 *   @claim:core/awards#award-once
 *   [claim: core/awards#award-once]
 *   [claims: core/awards#award-once, core/awards#no-dupes]
 *   [claims: core/awards#shipping-fee/ny-small]      (a row of the claim's examples table)
 *
 * Spec: specs/capabilities/conformance-testing.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseClaimRef } from './claims.js';

const REF_BODY = String.raw`(?:[A-Za-z0-9_-]+:)?[A-Za-z0-9_./-]*[A-Za-z0-9_]#[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)?`;
const AT_TAG = new RegExp(String.raw`@claim:(${REF_BODY})`, 'g');
const BRACKET = new RegExp(String.raw`\[claims?:\s*([^\]]+)\]`, 'gi');
const REF_ONLY = new RegExp(`^${REF_BODY}$`);

/** The exact tag string to place in a test title. */
export function claimTag(ref: string): string {
  return `@claim:${ref}`;
}

function normalize(ref: string): string | null {
  const trimmed = ref.trim().replace(/[.,;]+$/, '');
  if (!REF_ONLY.test(trimmed)) return null;
  const parsed = parseClaimRef(trimmed);
  if (!parsed) return null;
  const left = parsed.repo ? `${parsed.repo}:${parsed.specKey}` : parsed.specKey;
  return `${left}#${parsed.claimId}${parsed.exampleId ? `/${parsed.exampleId}` : ''}`;
}

/**
 * Rewrite every claim ref inside a claim tag (`@claim:` and `[claim(s): …]`).
 * `map` returns the replacement ref or undefined to leave a ref alone.
 * Text outside tags is never touched.
 */
export function rewriteClaimRefs(text: string, map: (ref: string) => string | undefined): { text: string; changed: number } {
  let changed = 0;
  const swap = (raw: string): string => {
    const ref = normalize(raw);
    const next = ref ? map(ref) : undefined;
    if (!next) return raw;
    changed += 1;
    return next;
  };
  let out = text.replace(AT_TAG, (_all, ref: string) => `@claim:${swap(ref)}`);
  out = out.replace(BRACKET, (all, body: string) => {
    const parts = body.split(',').map((part) => {
      const lead = part.match(/^\s*/)?.[0] ?? '';
      const tail = part.match(/\s*$/)?.[0] ?? '';
      const core = part.trim();
      return core ? `${lead}${swap(core)}${tail}` : part;
    });
    return all.replace(body, parts.join(','));
  });
  return { text: out, changed };
}

/** Every claim ref named in `text`, de-duplicated, in order of appearance. */
export function extractClaimRefs(text: string): string[] {
  const found: Array<{ index: number; ref: string }> = [];
  for (const match of text.matchAll(AT_TAG)) {
    const ref = normalize(match[1]);
    if (ref) found.push({ index: match.index ?? 0, ref });
  }
  for (const match of text.matchAll(BRACKET)) {
    for (const part of match[1].split(',')) {
      const ref = normalize(part);
      if (ref) found.push({ index: match.index ?? 0, ref });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return [...new Set(found.map((row) => row.ref))];
}

export interface ClaimTagHit {
  ref: string;
  file: string;
  line: number;
  /** Test title on the same line, when one can be read. */
  title?: string;
}

const TITLE_ON_LINE = /\b(?:it|test|describe|specify|scenario)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
const PY_DEF = /^\s*(?:async\s+)?def\s+(test\w*)/;
const GO_FUNC = /^\s*func\s+(Test\w*)/;
const RUST_FN = /^\s*(?:async\s+)?fn\s+(\w+)/;

/** Scan one source file's text for claim tags. */
export function scanSourceForClaimTags(source: string, file: string): ClaimTagHit[] {
  const hits: ClaimTagHit[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    const refs = extractClaimRefs(line);
    if (refs.length === 0) return;
    const title =
      line.match(TITLE_ON_LINE)?.[2] ??
      nextDeclaration(lines, index) ??
      undefined;
    for (const ref of refs) hits.push({ ref, file, line: index + 1, title });
  });
  return hits;
}

function nextDeclaration(lines: string[], from: number): string | undefined {
  for (let i = from; i < Math.min(lines.length, from + 4); i += 1) {
    const line = lines[i];
    const title = line.match(TITLE_ON_LINE)?.[2];
    if (title) return title;
    const decl = line.match(PY_DEF) ?? line.match(GO_FUNC) ?? line.match(RUST_FN);
    if (decl) return decl[1];
  }
  return undefined;
}

export interface ClaimTestEntry {
  file: string;
  line?: number;
  title?: string;
  /** `source` for a tag in a test file, `result` for a tag in a results file. */
  origin: 'source' | 'result';
  status?: 'pass' | 'fail' | 'skip';
}

export type ClaimTestIndex = Map<string, ClaimTestEntry[]>;

export interface IndexInput {
  /** Absolute paths of test source files. */
  testFiles?: string[];
  /** Normalized results (see test-results.ts) already parsed. */
  results?: Array<{ file: string; title: string; status: 'pass' | 'fail' | 'skip'; claims: string[] }>;
  /** Path made relative to this directory in the index. */
  rootDir?: string;
}

function relPosix(rootDir: string | undefined, abs: string): string {
  if (!rootDir) return abs.split('\\').join('/');
  const rel = abs.startsWith(rootDir) ? abs.slice(rootDir.length).replace(/^[\\/]+/, '') : abs;
  return rel.split('\\').join('/');
}

/** Build `claim ref -> tests` from test sources and parsed result rows. */
export function buildClaimTestIndex(input: IndexInput): ClaimTestIndex {
  const index: ClaimTestIndex = new Map();
  const push = (ref: string, entry: ClaimTestEntry) => {
    const list = index.get(ref) ?? [];
    list.push(entry);
    index.set(ref, list);
  };
  for (const abs of input.testFiles ?? []) {
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const hit of scanSourceForClaimTags(text, abs)) {
      push(hit.ref, { file: relPosix(input.rootDir, abs), line: hit.line, title: hit.title, origin: 'source' });
    }
  }
  for (const row of input.results ?? []) {
    for (const ref of row.claims) {
      push(ref, { file: row.file, title: row.title, origin: 'result', status: row.status });
    }
  }
  return index;
}

/** A title as a runner reports it: escapes in the source literal (`it('doesn\\'t')`) are resolved. */
function plainTitle(title: string): string {
  return title.replace(/\\(['"`\\])/g, '$1').trim();
}

/**
 * Give each result row the claims tagged on its test in the source file.
 *
 * A tag may sit in a comment above the test (`// [claims: ...]`) rather than in
 * its title, so a runner's report does not carry it. The row is matched to the
 * tagged declaration by file and title. Rows whose file cannot be read, or whose
 * title matches no tagged test, are left alone. Returns how many rows gained a claim.
 */
export function attachSourceClaimTags(rows: Array<{ file: string; title: string; claims: string[] }>, rootDir?: string): number {
  const byFile = new Map<string, Map<string, string[]>>();
  const tagsIn = (file: string): Map<string, string[]> => {
    let map = byFile.get(file);
    if (map) return map;
    map = new Map();
    try {
      const abs = rootDir && !path.isAbsolute(file) ? path.join(rootDir, file) : file;
      for (const hit of scanSourceForClaimTags(readFileSync(abs, 'utf8'), file)) {
        if (!hit.title) continue;
        const key = plainTitle(hit.title);
        map.set(key, [...new Set([...(map.get(key) ?? []), hit.ref])]);
      }
    } catch {
      /* unreadable or not a source file: nothing to attach */
    }
    byFile.set(file, map);
    return map;
  };
  let gained = 0;
  for (const row of rows) {
    const refs = tagsIn(row.file).get(plainTitle(row.title));
    if (!refs) continue;
    const before = row.claims.length;
    row.claims = [...new Set([...row.claims, ...refs])];
    if (row.claims.length > before) gained += 1;
  }
  return gained;
}

export interface TestTitle {
  file: string;
  line: number;
  title: string;
}

const PY_TITLE = /^\s*(?:async\s+)?def\s+(test\w*)/;
const GO_TITLE = /^\s*func\s+(Test\w*)/;

/** Test titles found in one source file (`it('..')`, `def test_x`, `func TestX`). */
export function scanTestTitles(source: string, file: string): TestTitle[] {
  const out: TestTitle[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const title = line.match(TITLE_ON_LINE)?.[2] ?? line.match(PY_TITLE)?.[1] ?? line.match(GO_TITLE)?.[1];
    if (title) out.push({ file, line: index + 1, title });
  });
  return out;
}
