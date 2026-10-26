/**
 * Migration planning: from facts about a repository (spec format, tracked generated state, ignore block, notes
 * refspec, workflow) to the ordered steps that bring it to the current layout. Pure: `migrate` gathers the facts,
 * applies the steps and rolls them back; this module only decides what is to do, and so is the whole of `migrate`'s
 * dry run.
 *
 * Spec: specs/capabilities/platform-foundation.md
 * Contract: signatures are frozen; the implementing slice fills in the bodies.
 */

export const REPO_FORMATS = ['none', 'v0.1', 'v0.2-0.3', 'v0.6'] as const;
export type RepoFormat = (typeof REPO_FORMATS)[number];

export interface RepoFacts {
  hasConfig: boolean;
  /** Spec files without `kind:` frontmatter (outside _archive). */
  v1Specs: string[];
  v2Specs: string[];
  tracked: { proofs: boolean; trace: boolean; publishSnapshot: boolean };
  gitignoreBlock: 'missing' | 'outdated' | 'current';
  hasApprovals: boolean;
  notes: { localRef: boolean; fetchRefspec: boolean };
  workflow: { path?: string; generatedBySpecguard: boolean; hasProve: boolean };
  /** `git status --porcelain` paths. */
  dirty: string[];
  ledgerRows: number;
  ledgerOriginCi: number;
}

export const MIGRATE_STEP_IDS = [
  // v0.1 only
  'archive-v1', 'draft', 'tag', 'drop-v1-ledger',
  'gitignore', 'untrack-ledger', 'untrack-trace', 'provisional-rows',
  'config', 'notes-fetch', 'workflow', 'hooks',
  // printed only
  'as-built-approval',
  'first-ci-note',
] as const;
export type MigrateStepId = (typeof MIGRATE_STEP_IDS)[number];

/** `person` = a command the person must run; `agent` = needs the host agent (exit 12, resumable). */
export const MIGRATE_STEP_STATES = ['todo', 'done', 'skip', 'person', 'agent'] as const;

export interface MigrateStep {
  id: MigrateStepId;
  state: (typeof MIGRATE_STEP_STATES)[number];
  description: string;
  /** Exact shell, for person/agent steps and the dry-run listing. */
  commands?: string[];
  changes?: Array<{ path: string; op: 'create' | 'edit' | 'move' | 'untrack' | 'delete' }>;
}

/**
 * v1Specs > 0 and v2Specs == 0 -> v0.1; v2 specs and (tracked proofs or trace, or an outdated ignore block) -> v0.2-0.3;
 * v2 specs and all current -> v0.6; no specs of either kind -> none (the design leaves `hasConfig` without a stated role here).
 */
export function detectFormat(_f: RepoFacts): RepoFormat {
  throw new Error('not implemented: detectFormat');
}

export function planMigration(_f: RepoFacts, _opts: { consolidate: boolean; fetchNotes: boolean; workflow: boolean }): MigrateStep[] {
  throw new Error('not implemented: planMigration');
}
