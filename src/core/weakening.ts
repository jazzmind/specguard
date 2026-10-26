/**
 * Weakening between two versions of a project: what an agent can loosen, outside the test files, to make
 * a claim look proven without proving it more. Covers spec policy (`layers:`, `assurance:` and `evidence:`
 * frontmatter, which sit outside the claim hash, so approvals cannot catch a change there), the config
 * thresholds, test-environment branches in source, mutation-testing exclusions and rewritten snapshots.
 * Pure: callers supply parsed specs, parsed config and the parsed diff. The test-file rules live in
 * test-strength.ts. Spec: specs/capabilities/test-strength.md
 */
import { claimHashOf } from './claim-hash.js';
import type { ChangedFile } from './diff-lines.js';
import { requiredLayersFor, type TestLayer } from './test-layers.js';
import { ASSURANCE_LEVELS, type ParsedSpec } from './types.js';

export type WeakeningKind =
  | 'test-removed' | 'tag-removed' | 'skip-added' | 'conditional-added' | 'focus-added'
  | 'assertions-removed' | 'assertion-weakened' | 'wildcard-added' | 'became-weak'
  | 'snapshot-rewritten' | 'mutation-disable-added' | 'test-env-branch'
  | 'policy-layer-removed' | 'policy-assurance-lowered' | 'policy-evidence-relaxed' | 'policy-example-removed'
  | 'policy-enforce-lowered'
  | 'config-weakened';

export interface WeakeningFinding {
  kind: WeakeningKind;
  severity: 'error' | 'warn';
  file: string;
  line?: number;
  test?: string;
  /** affected claim refs */
  claims: string[];
  before?: string;
  after?: string;
  message: string;
}

const CONFIG_FILE = '.specguard/config.json';

// ---- spec policy --------------------------------------------------------

/**
 * Policy relaxed between two versions of one capability spec. Each finding is an intent change that no
 * claim hash covers: a required layer dropped, assurance lowered, evidence moved to a human or an agent,
 * or an example row deleted while the claim text stayed the same. New and deleted specs are not judged.
 */
export function diffSpecPolicy(before: ParsedSpec | undefined, after: ParsedSpec | undefined, projectLayers: TestLayer[]): WeakeningFinding[] {
  if (!before || !after) return [];
  const findings: WeakeningFinding[] = [];
  const file = after.filePath;
  const afterById = new Map(after.claims.filter((c) => c.id).map((c) => [c.id!, c]));
  for (const claim of before.claims) {
    const id = claim.id;
    const next = id ? afterById.get(id) : undefined;
    if (!id || !next) continue; // a removed claim is a change of intent, which the claim hash and approvals cover
    const ref = `${after.specKey}#${id}`;

    const layersBefore = requiredLayersFor(id, before.meta.layers, projectLayers);
    const layersAfter = requiredLayersFor(id, after.meta.layers, projectLayers);
    const dropped = layersBefore.filter((l) => !layersAfter.includes(l));
    if (dropped.length > 0) {
      findings.push({
        kind: 'policy-layer-removed',
        severity: 'error',
        file,
        claims: [ref],
        before: layersBefore.join(', '),
        after: layersAfter.join(', ') || 'none',
        message: `${ref}: required layer ${dropped.join(', ')} was removed, so less evidence now counts as proof`,
      });
    }

    const level = (spec: ParsedSpec): number => {
      const v = spec.meta.assurance?.claims[id] ?? spec.meta.assurance?.default;
      return v ? ASSURANCE_LEVELS.indexOf(v) : 0;
    };
    const assuranceBefore = level(before);
    const assuranceAfter = level(after);
    if (assuranceAfter < assuranceBefore) {
      findings.push({
        kind: 'policy-assurance-lowered',
        severity: 'error',
        file,
        claims: [ref],
        before: ASSURANCE_LEVELS[assuranceBefore],
        after: ASSURANCE_LEVELS[assuranceAfter],
        message: `${ref}: required assurance was lowered from ${ASSURANCE_LEVELS[assuranceBefore]} to ${ASSURANCE_LEVELS[assuranceAfter]}`,
      });
    }

    const evBefore = before.meta.evidence?.[id];
    const evAfter = after.meta.evidence?.[id];
    if (evAfter && (!evBefore || evBefore.kind !== evAfter.kind || evBefore.verifier !== evAfter.verifier)) {
      const fmt = (e: { kind: string; verifier: string } | undefined): string => (e ? `${e.kind}: ${e.verifier || '(no verifier)'}` : 'automated tests');
      findings.push({
        kind: 'policy-evidence-relaxed',
        severity: 'error',
        file,
        claims: [ref],
        before: fmt(evBefore),
        after: fmt(evAfter),
        message: evBefore
          ? `${ref}: evidence changed from ${fmt(evBefore)} to ${fmt(evAfter)}`
          : `${ref}: the claim no longer needs automated proof; it is now ${fmt(evAfter)}`,
      });
    }

    const rowsAfter = new Set((next.examples?.rows ?? []).map((r) => r.id));
    const sameClaim = claimHashOf(before, id) !== undefined && claimHashOf(before, id) === claimHashOf(after, id);
    if (sameClaim) {
      for (const row of claim.examples?.rows ?? []) {
        if (rowsAfter.has(row.id)) continue;
        findings.push({
          kind: 'policy-example-removed',
          severity: 'error',
          file,
          line: row.line,
          claims: [`${ref}/${row.id}`],
          before: row.id,
          message: `${ref}: example row "${row.id}" was deleted while the claim text is unchanged`,
        });
      }
    }
  }
  return findings;
}

// ---- config -------------------------------------------------------------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const key = (v: unknown): string => JSON.stringify(v);
const LADDER: Record<string, number> = { off: 0, warn: 1, error: 2, fail: 2 };

/**
 * Config loosened between two versions of the parsed `.specguard/config.json`: a `proof.require*` flag
 * turned off, fewer required layers, a lower threshold, wider testability allow/waive lists or a lowered
 * rule severity, or test-strength gates and helpers loosened. Tightening is never reported.
 */
export function diffConfigPolicy(before: unknown, after: unknown): WeakeningFinding[] {
  const b = obj(before);
  const a = obj(after);
  const findings: WeakeningFinding[] = [];
  const add = (what: string, was: string, now: string): void => {
    findings.push({ kind: 'config-weakened', severity: 'error', file: CONFIG_FILE, claims: [], before: was, after: now, message: `${CONFIG_FILE}: ${what} (${was} -> ${now})` });
  };

  const pb = obj(b.proof);
  const pa = obj(a.proof);
  for (const k of Object.keys(pb)) {
    if (/^require/.test(k) && pb[k] === true && pa[k] !== true) add(`proof.${k} was turned off`, 'true', String(pa[k] ?? 'unset'));
  }
  const reqBefore = list(pb.requiredLayers).map(String);
  const reqAfter = list(pa.requiredLayers).map(String);
  const shrunk = reqBefore.filter((l) => !reqAfter.includes(l));
  if (shrunk.length > 0) add(`proof.requiredLayers no longer requires ${shrunk.join(', ')}`, reqBefore.join(', '), reqAfter.join(', ') || 'none');
  const enforceBefore = LADDER[String(pb.enforceLayers ?? 'warn')] ?? 1;
  const enforceAfter = LADDER[String(pa.enforceLayers ?? 'warn')] ?? 1;
  if (pb.enforceLayers !== undefined && enforceAfter < enforceBefore) add('proof.enforceLayers was relaxed', String(pb.enforceLayers), String(pa.enforceLayers ?? 'warn'));

  const lowered = (what: string, was: unknown, now: unknown): void => {
    const x = num(was);
    if (x === undefined) return;
    const y = num(now);
    if (y === undefined || y < x) add(`${what} was lowered`, String(x), y === undefined ? 'unset' : String(y));
  };
  lowered('proof.minDiffCoverage', pb.minDiffCoverage, pa.minDiffCoverage);
  lowered('mutation.minScore', obj(b.mutation).minScore, obj(a.mutation).minScore);
  lowered('mutation.minKilled', obj(b.mutation).minKilled, obj(a.mutation).minKilled);

  const tb = obj(b.testability);
  const ta = obj(a.testability);
  const allowBefore = new Set(list(tb.allow).map(key));
  const grownAllow = list(ta.allow).filter((x) => !allowBefore.has(key(x)));
  if (grownAllow.length > 0) add(`testability.allow grew by ${grownAllow.map(String).join(', ')}`, String(allowBefore.size), String(allowBefore.size + grownAllow.length));
  const waiveBefore = obj(tb.waive);
  const waiveAfter = obj(ta.waive);
  for (const [ref, rules] of Object.entries(waiveAfter)) {
    const had = new Set(list(waiveBefore[ref]).map(String));
    const extra = list(rules).map(String).filter((r) => !had.has(r));
    if (extra.length > 0) add(`testability.waive widened for ${ref}: ${extra.join(', ')}`, [...had].join(', ') || 'none', list(rules).map(String).join(', '));
  }
  const rb = obj(tb.rules);
  const ra = obj(ta.rules);
  for (const [rule, sev] of Object.entries(rb)) {
    const was = LADDER[String(sev)];
    const now = LADDER[String(ra[rule] ?? 'error')];
    if (was !== undefined && now !== undefined && now < was) add(`testability rule ${rule} was lowered`, String(sev), String(ra[rule] ?? 'default'));
  }

  const sb = obj(b.testStrength);
  const sa = obj(a.testStrength);
  const helpersBefore = new Set(list(sb.assertHelpers).map(String));
  const newHelpers = list(sa.assertHelpers).map(String).filter((h) => !helpersBefore.has(h));
  if (newHelpers.length > 0) add(`testStrength.assertHelpers grew by ${newHelpers.join(', ')}, so those calls now count as assertions`, String(helpersBefore.size), String(helpersBefore.size + newHelpers.length));
  const condAfter = new Set(list(sa.conditional).map(String));
  const dropped = list(sb.conditional).map(String).filter((c) => !condAfter.has(c));
  if (dropped.length > 0) add(`testStrength.conditional dropped ${dropped.join(', ')}, so those gated tests are no longer flagged`, String(list(sb.conditional).length), String(condAfter.size));
  if (sb.snapshotIsWeak !== false && sa.snapshotIsWeak === false) add('testStrength.snapshotIsWeak was turned off', String(sb.snapshotIsWeak ?? 'true'), 'false');
  return findings;
}

// ---- source and diff ----------------------------------------------------

const TEST_ENV = [
  /process\.env\.(?:NODE_ENV|VITEST|JEST_WORKER_ID)/,
  /import\.meta\.env\.(?:MODE|VITEST)/,
  /\bisTest(?:Env)?\b/,
  /PYTEST_CURRENT_TEST/,
  /["']pytest["']\s+in\s+sys\.modules/,
  /testing\.Testing\(\)/,
  /cfg!\(test\)/,
  /System\.getProperty\("test/,
  /@Profile\("test"\)/,
];
const CFG_TEST_ATTR = /#\[cfg\(test\)\]/;
const MUTATION_DISABLE = /Stryker\s+disable|\b(?:excludedMethods|excludedClasses|avoidCallsTo)\b/;

/**
 * Lines added to non-test source that branch on "am I under test", and added mutation-testing exclusions
 * (anywhere). A `#[cfg(test)]` directly followed by `mod` is the normal Rust test module and is skipped.
 */
export function scanAddedSource(changed: ChangedFile[], isTestFile: (f: string) => boolean): WeakeningFinding[] {
  const findings: WeakeningFinding[] = [];
  for (const f of changed) {
    if (f.binary || f.status === 'deleted') continue;
    const byLine = new Map(f.addedText.map((l) => [l.line, l.text]));
    for (const { line, text } of f.addedText) {
      if (MUTATION_DISABLE.test(text)) {
        findings.push({
          kind: 'mutation-disable-added',
          severity: 'warn',
          file: f.file,
          line,
          claims: [],
          after: text.trim(),
          message: `${f.file}:${line}: mutation testing is switched off here, so surviving mutants go unreported`,
        });
      }
      if (isTestFile(f.file)) continue;
      let hit = TEST_ENV.some((re) => re.test(text));
      if (!hit && CFG_TEST_ATTR.test(text)) {
        const following = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\b/;
        hit = !following.test(text.slice(text.search(CFG_TEST_ATTR) + 14)) && !following.test(byLine.get(line + 1) ?? '');
      }
      if (hit) {
        findings.push({
          kind: 'test-env-branch',
          severity: 'warn',
          file: f.file,
          line,
          claims: [],
          after: text.trim(),
          message: `${f.file}:${line}: source branches on the test environment, so tests may not exercise the production path`,
        });
      }
    }
  }
  return findings;
}

const SNAPSHOT_FILE = /(?:\.snap|\.snap\.new)$|(?:^|\/)__snapshots__\/|-snapshots\//;

/** A snapshot file that was rewritten: a regenerated snapshot records whatever the code now does. */
export function snapshotRewrites(changed: ChangedFile[]): WeakeningFinding[] {
  const findings: WeakeningFinding[] = [];
  for (const f of changed) {
    if (!SNAPSHOT_FILE.test(f.file)) continue;
    const pending = /\.snap\.new$/.test(f.file);
    if (!pending && (f.status === 'added' || f.status === 'deleted')) continue;
    if (!pending && !f.binary && f.removed.length === 0 && f.added.length === 0 && f.status !== 'renamed') continue;
    findings.push({
      kind: 'snapshot-rewritten',
      severity: 'warn',
      file: f.file,
      claims: [],
      message: `${f.file}: snapshot ${pending ? 'update is pending' : 'was rewritten'}; review it as a change of expected behaviour`,
    });
  }
  return findings;
}
