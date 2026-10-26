/**
 * The agent edit guard's decision table. The hook entry reads the tool call and the ownership index, classifies each
 * path the tool would write, and asks this module whether to allow, deny or ask. Pure: no file, git or process access,
 * so the same table runs in the hook bundle, the CLI and the tests, in well under a millisecond.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: signatures are frozen; the implementing slice fills in the bodies.
 */
import type { ChangeKind } from '../core/change-record.js';
import type { EnforceLevel } from '../core/types.js';

export const HOOK_INDEX_VERSION = 1;

/** Longest message the agent sees (deny) or receives as additional context (allow). */
export const HOOK_MESSAGE_MAX = 300;

/**
 * The ownership index (`.specguard/cache/hook-index.json`). Declared here, with the decision table that reads it, so
 * the decision module stays free of the graph and git code that builds it (`src/hooks/index-build.ts`).
 */
export interface HookIndex {
  version: 1;
  builtAt: string;
  /** Cheap staleness key: (path, mtimeMs, size) of every spec file, config, .specguard/changes/*, cache/changes/<id>/red.json. */
  fingerprint: string;
  /** Repo-relative. */
  specsRoot: string;
  /** Repo-relative. */
  historyDir: string;
  /** Union of app test globs. */
  testGlobs: string[];
  /** Exact owned files -> capability ids (from spec-graph ownedFiles). */
  owned: Record<string, string[]>;
  /** For files not yet existing (Write): capability source globs. */
  capabilities: Array<{ id: string; specFile: string; enforce: EnforceLevel; sources: string[] }>;
  openChanges: Array<{
    id: string;
    kind: ChangeKind;
    capabilities: string[];
    /** Test files tagged to the change's changed refs (the stage lock set). */
    lockedTests: string[];
    /** Validity at build time; the entry re-checks it live. */
    red?: { testsHash: string; claimsHash: string; valid: boolean };
    approvedAll: boolean;
  }>;
}

export type PathClass =
  | { kind: 'owned'; capabilities: string[] }
  | { kind: 'test'; /** Change ids. */ lockedBy: string[] }
  | { kind: 'spec'; capability?: string }
  | { kind: 'history'; approvalLike: boolean }
  | { kind: 'change-record'; closed: boolean }
  | { kind: 'specguard-config' }
  | { kind: 'workflow' }
  | { kind: 'other' };

export interface HookEvent {
  event: 'PreToolUse' | 'PostToolUse';
  tool: string;
  /** Repo-relative POSIX paths the tool would write (Edit/Write/MultiEdit/NotebookEdit/apply_patch), [] for Bash. */
  paths: string[];
  /** For Write/Edit: new content (to spot `kind: approval` in history files). */
  newText?: string;
  bash?: string;
  agent: 'claude' | 'codex';
  subagent?: string;
}

export const HOOK_CODES = [
  'OUTSIDE_REPO', 'NOT_SPECGUARD', 'FREE', 'OBSERVED', 'WARN_NO_CHANGE', 'WARN_BEFORE_RED',
  'DENY_NO_CHANGE', 'DENY_BEFORE_RED', 'DENY_NOT_APPROVED', 'ALLOW_CHANGE', 'ALLOW_REFACTOR', 'ALLOW_SPIKE',
  'LOCK_TESTS', 'LOCK_SPEC', 'DENY_APPROVAL_WRITE', 'DENY_RECORD_EDIT', 'DENY_BASH_APPROVE', 'DENY_BASH_NOTES',
  'NOTE_POLICY_FILE', 'ERROR_OPEN', 'ERROR_CLOSED',
] as const;
export type HookCode = (typeof HOOK_CODES)[number];

export const HOOK_DECISIONS = ['allow', 'deny', 'ask'] as const;

export interface HookLogEntry {
  ts: string;
  session?: string;
  agent?: string;
  tool: string;
  paths: string[];
  caps: string[];
  level: EnforceLevel | null;
  decision: HookDecision['decision'];
  code: HookCode;
  change?: string;
}

export interface HookDecision {
  decision: (typeof HOOK_DECISIONS)[number];
  /** Shown to the agent (deny) or as additionalContext (allow). Max HOOK_MESSAGE_MAX chars. */
  message?: string;
  log: HookLogEntry;
}

/** One repo-relative POSIX path -> its class, from the index. `matchGlob` is injected (picomatch in the bundle). */
export function classify(_path: string, _index: HookIndex, _matchGlob: (glob: string, path: string) => boolean): PathClass {
  throw new Error('not implemented: classify');
}

/** With several paths each is decided and the strictest wins. `live.redValid` is change id -> red still valid, checked by the entry at call time. */
export function decide(_ev: HookEvent, _classes: PathClass[], _index: HookIndex, _live: { redValid: Map<string, boolean> }): HookDecision {
  throw new Error('not implemented: decide');
}
