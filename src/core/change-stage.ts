/**
 * The change protocol's state machine: spec -> tests -> red -> code -> green -> validated. Nothing here reads a
 * file or runs a command. The pipeline gathers facts (changed claims, approvals, tagged tests, hashes, the newest red
 * and green records, the CI verdict) and `computeStage` decides the stage from them, so a stage is detected from
 * what exists and never from what anyone says about it. The same facts feed the red-evidence predicates
 * (`judgeRed`) and the stage locks: once code differs from base, a red whose tests or specs were edited since is
 * invalid and the stage falls back to `tests`.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */
import { createHash } from 'node:crypto';

import type { ChangeKind, ChangeRecord } from './change-record.js';
import type { ChangedClaim, ClaimChange } from './change-claims.js';

export type ChangeStage = 'spec' | 'tests' | 'red' | 'code' | 'green' | 'validated';
export const STAGES: readonly ChangeStage[] = ['spec', 'tests', 'red', 'code', 'green', 'validated'];

export interface RedRecord {
  version: 1;
  changeId: string;
  runId: string;
  at: string;
  /** How the red tree was built: the working tree with owned code still at base, or a constructed tree. */
  mode: 'working-tree' | 'constructed';
  /** Hash over sorted `ref@hash` of the changed claims at red time. */
  claimsHash: string;
  /** sha256 over sorted (path, sha256(content)) of every test file tagged to a changed claim. */
  testsHash: string;
  /** Hash of the owned files of the change's capabilities in the tree the tests ran against. */
  ownedHash: string;
  /** Same hash computed at the base sha. Red is only valid when ownedHash === baseOwnedHash. */
  baseOwnedHash: string;
  tests: Array<{ id: string /* file::title */; claims: string[]; status: 'pass' | 'fail' | 'skip' | 'error' }>;
  origin: 'local' | 'ci';
}

export interface GreenRecord {
  version: 1;
  changeId: string;
  runId: string;
  at: string;
  claimsHash: string;
  testsHash: string;
  ownedHash: string;
  tests: RedRecord['tests'];
}

export type TestStrengthClass = 'strong' | 'weak' | 'skipped' | 'conditional' | 'unknown';

export interface StageInput {
  record: ChangeRecord;
  changed: ChangedClaim[];
  /** Local approvals including plan-derived ones, keyed by ref -> approved at the current hash? A missing key means no. */
  approved: Map<string, { method: string; by: string } | undefined>;
  /** Tests tagged to each changed ref (a row's tests also count for its claim), with strength class. */
  tagged: Map<string, Array<{ id: string; file: string; strength: TestStrengthClass }>>;
  current: { claimsHash: string; testsHash: string; ownedHash: string; baseOwnedHash: string };
  /** Owned files of the change's capabilities that differ from base (working tree included). */
  codeFiles: string[];
  red?: RedRecord;
  green?: GreenRecord;
  /** From the nearest noted commit whose inputs equal HEAD's (or HEAD's own note). */
  ci?: { commit: string; verdict: 'pass' | 'fail' | 'spike' };
  policy: { redAcceptsErrors: 'never' | 'added-only' | 'always' };
}

export type StageBlockCode =
  | 'NO_INTENT_CHANGE'
  | 'APPROVAL_PENDING'
  | 'TESTS_MISSING'
  | 'TESTS_NOT_MEANINGFUL'
  | 'RED_MISSING'
  | 'RED_INVALID_TESTS_EDITED'
  | 'RED_INVALID_SPEC_EDITED'
  | 'RED_NOT_RED'
  | 'RED_CODE_AHEAD'
  | 'NO_CODE_CHANGE'
  | 'GREEN_MISSING'
  | 'GREEN_FAILING'
  | 'GREEN_STALE'
  | 'NOT_VALIDATED'
  | 'VALIDATION_FAILED'
  | 'REFACTOR_CHANGES_INTENT'
  | 'SPIKE_CANNOT_VALIDATE';

export interface StageBlock {
  code: StageBlockCode;
  refs?: string[];
  message: string;
  /** One command or instruction that clears the block. */
  fix: string;
}

export interface ChangeStatus {
  id: string;
  kind: ChangeKind;
  /** First stage not yet satisfied; 'validated' when everything holds (then `done` includes 'validated'). */
  stage: ChangeStage;
  /** Stages satisfied, in order. */
  done: ChangeStage[];
  blocks: StageBlock[];
  /** One command: the next step (the first block's fix). */
  next: string;
  changed: ChangedClaim[];
  /** Test files whose edits would invalidate the recorded red (empty unless red is valid). */
  lockedTests: string[];
  codeFiles: string[];
  red: 'valid' | 'invalid' | 'none';
  closed?: ChangeRecord['closed'];
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Hash over sorted `ref@hash` of the changed claims (`-` for a removed one): what `RedRecord.claimsHash` holds. */
export function changedClaimsHash(changed: ChangedClaim[]): string {
  return sha(changed.map((c) => `${c.ref}@${c.hash ?? '-'}`).sort().join('\n'));
}

/** Hash over sorted (path, sha256(content)) of the test files: what `RedRecord.testsHash` holds. */
export function testFilesHash(files: Array<{ path: string; sha256: string }>): string {
  return sha(files.map((f) => `${f.path}\0${f.sha256}`).sort().join('\n'));
}

/** Test strengths that prove something: a skipped, conditional or weak test does not. `unknown` is given the benefit of the doubt. */
export function isMeaningfulStrength(strength: TestStrengthClass): boolean {
  return strength === 'strong' || strength === 'unknown';
}

/** Whether a red run's `error` result counts as red for a ref whose change is `change` under the configured policy. */
export function errorCountsAsRed(policy: StageInput['policy']['redAcceptsErrors'], change: ClaimChange): boolean {
  return policy === 'always' || (policy === 'added-only' && change === 'added');
}

/** Refs that need tests, red and approval: everything changed except what was removed. */
export function requiredRefs(changed: ChangedClaim[]): ChangedClaim[] {
  return changed.filter((c) => c.change !== 'removed');
}

type RedFacts = Pick<StageInput, 'record' | 'changed' | 'current' | 'codeFiles' | 'red' | 'policy'>;

export interface RedJudgement {
  /** `none`: no usable red record. `invalid`: one exists but does not hold. */
  state: 'valid' | 'invalid' | 'none';
  blocks: StageBlock[];
  /** Required refs with a failing test (or an accepted error) in the red run. */
  redRefs: string[];
  notRed: string[];
}

const LOCK_CODES: ReadonlySet<StageBlockCode> = new Set(['RED_INVALID_TESTS_EDITED', 'RED_INVALID_SPEC_EDITED']);

/**
 * The red-evidence rules as one predicate over facts. A red record holds when:
 * 1. it belongs to this change;
 * 2. its spec and test hashes equal the current ones (otherwise it is a stage lock when code exists, and just stale before);
 * 3. the owned code it ran against equalled the base's;
 * 4. every added or modified ref has a test in the run that failed (an `error` counts for an added ref under
 *    `added-only`, for every ref under `always`, for none under `never`). Tests in the run that cover no changed
 *    ref are ignored; a ref no run test covers is not red.
 * The results themselves must come from the runner's report file; that is the pipeline's rule, not checkable here.
 */
export function judgeRed(facts: RedFacts): RedJudgement {
  const { record, changed, current, codeFiles, red, policy } = facts;
  const fix = `specguard change red ${record.id}`;
  const missing = (message: string): RedJudgement => ({ state: 'none', redRefs: [], notRed: [], blocks: [{ code: 'RED_MISSING', message, fix }] });
  if (!red || red.changeId !== record.id) return missing('no red run is recorded: the changed requirements have not been seen failing');

  const blocks: StageBlock[] = [];
  const testsEdited = red.testsHash !== current.testsHash;
  const specEdited = red.claimsHash !== current.claimsHash;
  if (codeFiles.length > 0) {
    if (testsEdited) blocks.push({ code: 'RED_INVALID_TESTS_EDITED', message: 'the tagged tests changed after red was recorded, and code now exists, so that red proves nothing', fix });
    if (specEdited) blocks.push({ code: 'RED_INVALID_SPEC_EDITED', message: 'the changed requirements were edited after red was recorded, and code now exists, so that red proves nothing', fix });
  } else if (testsEdited || specEdited) {
    blocks.push({ code: 'RED_MISSING', message: 'the recorded red no longer matches the current spec or tests: record it again', fix });
  }
  if (red.ownedHash !== red.baseOwnedHash) {
    blocks.push({ code: 'RED_CODE_AHEAD', message: 'red ran with the owned code already different from base, so it shows nothing about the change', fix });
  }

  const redRefs: string[] = [];
  const notRed: string[] = [];
  for (const c of requiredRefs(changed)) {
    const results = red.tests.filter((t) => t.claims.includes(c.ref));
    const isRed = results.some((t) => t.status === 'fail' || (t.status === 'error' && errorCountsAsRed(policy.redAcceptsErrors, c.change)));
    (isRed ? redRefs : notRed).push(c.ref);
  }
  if (notRed.length > 0) {
    blocks.push({
      code: 'RED_NOT_RED',
      refs: notRed,
      message: `no failing test in the red run for ${notRed.join(', ')}: the test passes without the change, or errored where an error is not accepted`,
      fix,
    });
  }
  return { state: blocks.length === 0 ? 'valid' : 'invalid', blocks, redRefs, notRed };
}

export interface GreenJudgement {
  state: 'valid' | 'missing' | 'stale' | 'failing';
  blocks: StageBlock[];
}

/**
 * Green holds when the newest green record is this change's, its three hashes equal the current ones, and every
 * test tagged to a changed ref passed (skipped or absent counts as not passed). A refactor has no changed refs: every
 * test in its run must pass, and a run with no tests proves nothing.
 */
export function judgeGreen(facts: Pick<StageInput, 'record' | 'changed' | 'tagged' | 'current' | 'green'>): GreenJudgement {
  const { record, changed, tagged, current, green } = facts;
  const fix = `specguard change green ${record.id}`;
  if (!green || green.changeId !== record.id) {
    return { state: 'missing', blocks: [{ code: 'GREEN_MISSING', message: 'no green run is recorded', fix }] };
  }
  if (green.claimsHash !== current.claimsHash || green.testsHash !== current.testsHash || green.ownedHash !== current.ownedHash) {
    return { state: 'stale', blocks: [{ code: 'GREEN_STALE', message: 'the spec, tests or code changed since the green run', fix }] };
  }
  const status = new Map(green.tests.map((t) => [t.id, t.status]));
  if (record.kind === 'refactor') {
    const bad = green.tests.filter((t) => t.status !== 'pass');
    if (green.tests.length === 0 || bad.length > 0) {
      const refs = [...new Set(bad.flatMap((t) => t.claims))].sort();
      const message = green.tests.length === 0 ? 'the green run ran no claim tests' : `${bad.length} claim test(s) did not pass`;
      return { state: 'failing', blocks: [{ code: 'GREEN_FAILING', ...(refs.length ? { refs } : {}), message, fix }] };
    }
    return { state: 'valid', blocks: [] };
  }
  const failing = requiredRefs(changed)
    .filter((c) => (tagged.get(c.ref) ?? []).some((t) => status.get(t.id) !== 'pass'))
    .map((c) => c.ref);
  if (failing.length > 0) {
    return { state: 'failing', blocks: [{ code: 'GREEN_FAILING', refs: failing, message: `tests for ${failing.join(', ')} did not all pass in the green run`, fix }] };
  }
  return { state: 'valid', blocks: [] };
}

function specBlocks(i: StageInput): StageBlock[] {
  const { record, changed, approved } = i;
  if (record.kind === 'refactor') {
    if (changed.length === 0) return [];
    const refs = changed.map((c) => c.ref);
    return [{
      code: 'REFACTOR_CHANGES_INTENT',
      refs,
      message: `a refactor changes no requirement, but ${refs.join(', ')} changed`,
      fix: `revert the requirement edits, or open a feature change: specguard change start ${record.capabilities.join(' ')}`,
    }];
  }
  if (changed.length === 0) {
    return [{
      code: 'NO_INTENT_CHANGE',
      message: 'no requirement of the change\'s capabilities differs from base: state what should change first',
      fix: `edit the requirements in the spec of ${record.capabilities.join(', ')}`,
    }];
  }
  const pending = requiredRefs(changed).filter((c) => !approved.get(c.ref)).map((c) => c.ref);
  if (pending.length === 0) return [];
  return [{
    code: 'APPROVAL_PENDING',
    refs: pending,
    message: `a person has not approved ${pending.join(', ')} at the current wording`,
    fix: `specguard spec approve ${pending.join(' ')}`,
  }];
}

function testBlocks(i: StageInput): StageBlock[] {
  if (i.record.kind === 'refactor') return [];
  const missing: string[] = [];
  const weak: string[] = [];
  for (const c of requiredRefs(i.changed)) {
    const tests = i.tagged.get(c.ref) ?? [];
    if (tests.length === 0) missing.push(c.ref);
    else if (!tests.some((t) => isMeaningfulStrength(t.strength))) weak.push(c.ref);
  }
  const out: StageBlock[] = [];
  if (missing.length > 0) {
    out.push({
      code: 'TESTS_MISSING',
      refs: missing,
      message: `no test is tagged to ${missing.join(', ')}`,
      fix: `tag a test: add [claims: ${missing[0]}] above a test${missing.length > 1 ? ` (and the other ${missing.length - 1} ref(s))` : ''}`,
    });
  }
  if (weak.length > 0) {
    out.push({
      code: 'TESTS_NOT_MEANINGFUL',
      refs: weak,
      message: `only weak, skipped or conditional tests are tagged to ${weak.join(', ')}`,
      fix: `write a test that asserts the behaviour and tag it [claims: ${weak[0]}]`,
    });
  }
  return out;
}

/** The two checks of a stage lock; they apply only once code differs from base. */
function lockBlocks(i: StageInput): StageBlock[] {
  if (i.record.kind === 'refactor' || i.codeFiles.length === 0 || requiredRefs(i.changed).length === 0) return [];
  return judgeRed(i).blocks.filter((b) => LOCK_CODES.has(b.code));
}

function redBlocks(i: StageInput): { blocks: StageBlock[]; state: ChangeStatus['red'] } {
  if (i.record.kind === 'refactor') return { blocks: [], state: 'none' };
  const verdict = judgeRed(i);
  // A removal-only change has no ref to see failing: red is not required, but a recorded red still reports its state.
  if (requiredRefs(i.changed).length === 0) return { blocks: [], state: i.red ? verdict.state : 'none' };
  return { blocks: verdict.blocks.filter((b) => !LOCK_CODES.has(b.code)), state: verdict.state };
}

function validatedBlocks(i: StageInput): StageBlock[] {
  const { record, ci } = i;
  if (record.kind === 'spike') {
    return [{
      code: 'SPIKE_CANNOT_VALIDATE',
      message: 'a spike is exploration: it cannot be validated or merged as is',
      fix: `specguard change convert ${record.id} --to feature`,
    }];
  }
  if (ci?.verdict === 'pass') return [];
  if (ci?.verdict === 'fail') {
    return [{ code: 'VALIDATION_FAILED', message: `CI judged this change failing at ${ci.commit.slice(0, 8)}`, fix: `specguard change report ${record.id}` }];
  }
  const why = ci?.verdict === 'spike' ? 'CI judged this change a spike' : 'CI has not validated this commit';
  return [{ code: 'NOT_VALIDATED', message: why, fix: 'git push (CI validates the change)' }];
}

/**
 * Decide where a change stands. The stage is the first whose predicate fails; `blocks` are that stage's blocks, in
 * order, plus any stage-lock blocks (so an unapproved edit of a spec after red also says red is invalid). `next` is
 * the first block's fix.
 *
 * Refactor: spec holds only with no changed claim; tests and red do not apply. Spike: the same as a feature, never
 * validated. A feature whose changes are all removals needs no tests or red, but still code and green.
 */
export function computeStage(input: StageInput): ChangeStatus {
  const { record, changed, codeFiles } = input;
  const locks = lockBlocks(input);
  const red = redBlocks(input);
  const checks: Array<[ChangeStage, () => StageBlock[]]> = [
    ['spec', () => specBlocks(input)],
    ['tests', () => [...testBlocks(input), ...locks]],
    ['red', () => red.blocks],
    ['code', () => (codeFiles.length > 0 ? [] : [{
      code: 'NO_CODE_CHANGE' as const,
      message: 'no owned file of the change\'s capabilities differs from base',
      fix: `write the code for ${record.capabilities.join(', ')} until the tagged tests pass`,
    }])],
    ['green', () => judgeGreen(input).blocks],
    ['validated', () => validatedBlocks(input)],
  ];

  const done: ChangeStage[] = [];
  let stage: ChangeStage = 'validated';
  let blocks: StageBlock[] = [];
  for (const [name, check] of checks) {
    const found = check();
    if (found.length === 0) {
      done.push(name);
      continue;
    }
    stage = name;
    blocks = found;
    break;
  }
  if (done.length < STAGES.length && stage === 'spec') blocks = [...blocks, ...locks.filter((l) => !blocks.includes(l))];

  const valid = red.state === 'valid';
  const lockedTests = valid
    ? [...new Set(requiredRefs(changed).flatMap((c) => (input.tagged.get(c.ref) ?? []).map((t) => t.file)))].sort()
    : [];
  const next = blocks[0]?.fix ?? (record.closed ? 'nothing: the change is closed' : `specguard change done ${record.id}`);
  const status: ChangeStatus = {
    id: record.id,
    kind: record.kind,
    stage,
    done,
    blocks,
    next,
    changed,
    lockedTests,
    codeFiles,
    red: red.state,
  };
  if (record.closed) status.closed = record.closed;
  return status;
}
