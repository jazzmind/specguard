/**
 * Unrequested code: changed executable lines of owned files that no claim's tests reach. A line reached only by
 * another claim's tests is incidental (warn); a line reached by no test is unrequested (an error at `enforce`).
 * Pure: callers supply the diff, ownership and coverage evidence.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: signatures are frozen; the implementing slice fills in the bodies.
 */
import { fromRanges, toRanges, type CoverageEvidence, type FileEvidence, type LineRanges } from './coverage.js';
import type { ChangedFile } from './diff-lines.js';

export interface UnrequestedInput {
  /** base...head diff (diff-lines.ts). */
  changed: ChangedFile[];
  /** file -> capability ids. */
  ownedBy: Map<string, string[]>;
  /** Capabilities covered by open changes. */
  changeCaps: Set<string>;
  /** Coverage from running ONLY the changed refs' tests (scope 'claims'), when available. */
  changeCoverage?: CoverageEvidence;
  /** Capability-scoped coverage (all claim tests of the capability), when available. */
  capabilityCoverage?: Map<string, CoverageEvidence>;
  currentHashes: Record<string, string>;
}

export interface UnrequestedLines {
  file: string;
  capability: string;
  lines: LineRanges;
  class: 'unrequested' | 'incidental' | 'unknown';
}

export interface UnrequestedReport {
  lines: UnrequestedLines[];
  /** Owned files changed with no open change covering their capability. */
  withoutChange: Array<{ file: string; capabilities: string[] }>;
  /** False when the change run used file selection or line data was summarized. */
  claimable: boolean;
  diffCoverage: { changedExecutable: number; hitByChangeTests: number; pct: number | null };
}

/** Files that hold documents or data, never executable code (the same set coverage.ts leaves out). */
const NON_CODE = /\.(?:md|mdx|txt|json|ya?ml|toml|lock|svg|png|jpe?g|gif|ico|css|scss|html|csv)$/i;

const CLASS_ORDER: Record<UnrequestedLines['class'], number> = { unrequested: 0, incidental: 1, unknown: 2 };

/** Line data for `file` when the report holds it, is fresh against the current content, and kept line granularity. */
function freshLines(evidence: CoverageEvidence | undefined, file: string, currentHashes: Record<string, string>): FileEvidence | undefined {
  if (!evidence || evidence.granularity !== 'lines') return undefined;
  const ev = evidence.files[file];
  if (!ev) return undefined;
  const now = currentHashes[file];
  return now !== undefined && now === ev.hash ? ev : undefined;
}

const pct = (hit: number, total: number): number | null => (total === 0 ? null : Math.round((hit / total) * 1000) / 10);

/**
 * For each changed executable owned line: not hit by the change's tests but hit by the capability's tests is
 * incidental; hit by neither is unrequested; no fresh line data, or `selection: 'files'`, is unknown (advisory).
 *
 * A file is judged only when one of its owning capabilities is covered by an open change; the lines are reported
 * under the first such capability (by id). Without capability-scoped coverage a line the change tests miss cannot
 * be told from one other claims reach, so it is reported as unrequested (the stricter reading).
 */
export function findUnrequested(input: UnrequestedInput): UnrequestedReport {
  const { changeCoverage, capabilityCoverage, currentHashes } = input;
  const scope = changeCoverage?.scope;
  // Only a run of the changed claims' own tests, selected by test, says which code those claims reach.
  const evidenceClaimable = changeCoverage !== undefined && scope?.kind === 'claims' && scope.selection === 'tests' && changeCoverage.granularity === 'lines';

  const lines: UnrequestedLines[] = [];
  const withoutChange: UnrequestedReport['withoutChange'] = [];
  let changedExecutable = 0;
  let hitByChangeTests = 0;
  let anyUnknown = false;

  const files = [...input.changed].sort((a, b) => a.file.localeCompare(b.file));
  for (const cf of files) {
    if (cf.status === 'deleted' || cf.binary || NON_CODE.test(cf.file)) continue;
    const owners = [...new Set(input.ownedBy.get(cf.file) ?? [])].sort();
    if (owners.length === 0) continue;
    const judging = owners.filter((c) => input.changeCaps.has(c));
    if (judging.length === 0) {
      withoutChange.push({ file: cf.file, capabilities: owners });
      continue;
    }
    const capability = judging[0]!;
    const added = [...new Set(cf.added)].sort((a, b) => a - b);
    if (added.length === 0) continue;

    const ev = evidenceClaimable ? freshLines(changeCoverage, cf.file, currentHashes) : undefined;
    if (!ev) {
      // No judgement possible: the changed lines are reported unknown (only the executable ones when a report still says which).
      const stale = freshLines(changeCoverage, cf.file, currentHashes);
      const exec = stale ? new Set(fromRanges(stale.exec)) : undefined;
      const unknown = exec ? added.filter((n) => exec.has(n)) : added;
      if (unknown.length > 0) {
        lines.push({ file: cf.file, capability, lines: toRanges(unknown), class: 'unknown' });
        anyUnknown = true;
      }
      continue;
    }

    const exec = new Set(fromRanges(ev.exec));
    const hit = new Set(fromRanges(ev.hit));
    const executable = added.filter((n) => exec.has(n));
    const missed = executable.filter((n) => !hit.has(n));
    changedExecutable += executable.length;
    hitByChangeTests += executable.length - missed.length;
    if (missed.length === 0) continue;

    const reachedByCapability = new Set<number>();
    for (const cap of judging) {
      const cev = freshLines(capabilityCoverage?.get(cap), cf.file, currentHashes);
      if (cev) for (const n of fromRanges(cev.hit)) reachedByCapability.add(n);
    }
    const incidental = missed.filter((n) => reachedByCapability.has(n));
    const unrequested = missed.filter((n) => !reachedByCapability.has(n));
    if (unrequested.length > 0) lines.push({ file: cf.file, capability, lines: toRanges(unrequested), class: 'unrequested' });
    if (incidental.length > 0) lines.push({ file: cf.file, capability, lines: toRanges(incidental), class: 'incidental' });
  }

  lines.sort((a, b) => a.file.localeCompare(b.file) || CLASS_ORDER[a.class] - CLASS_ORDER[b.class] || a.capability.localeCompare(b.capability));
  return {
    lines,
    withoutChange,
    claimable: evidenceClaimable && !anyUnknown,
    diffCoverage: { changedExecutable, hitByChangeTests, pct: pct(hitByChangeTests, changedExecutable) },
  };
}
