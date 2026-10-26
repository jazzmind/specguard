/**
 * Unrequested code: changed executable lines of owned files that no claim's tests reach. A line reached only by
 * another claim's tests is incidental (warn); a line reached by no test is unrequested (an error at `enforce`).
 * Pure: callers supply the diff, ownership and coverage evidence.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: signatures are frozen; the implementing slice fills in the bodies.
 */
import type { CoverageEvidence, LineRanges } from './coverage.js';
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

/**
 * For each changed executable owned line: not hit by the change's tests but hit by the capability's tests is
 * incidental; hit by neither is unrequested; no fresh line data, or `selection: 'files'`, is unknown (advisory).
 */
export function findUnrequested(_input: UnrequestedInput): UnrequestedReport {
  throw new Error('not implemented: findUnrequested');
}
