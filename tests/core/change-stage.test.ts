import { describe, expect, it } from 'vitest';

import type { ChangedClaim } from '../../src/core/change-claims.js';
import type { ChangeRecord } from '../../src/core/change-record.js';
import { derivePlanApprovals } from '../../src/core/change-record.js';
import {
  STAGES,
  changedClaimsHash,
  computeStage,
  errorCountsAsRed,
  isMeaningfulStrength,
  judgeGreen,
  judgeRed,
  testFilesHash,
  type ChangeStatus,
  type GreenRecord,
  type RedRecord,
  type StageBlockCode,
  type StageInput,
  type TestStrengthClass,
} from '../../src/core/change-stage.js';
import type { HistoryEntry } from '../../src/core/history.js';

const FEE = 'capabilities/cart#fee';
const TOTAL = 'capabilities/cart#total';
const H = { claims: 'c'.repeat(64), tests: 't'.repeat(64), owned: 'o'.repeat(64), base: 'b'.repeat(64) };

const record = (over: Partial<ChangeRecord> = {}): ChangeRecord => ({
  version: 1, id: '20261025-free-shipping-a1b2', kind: 'feature', capabilities: ['cart'], createdAt: '2026-10-25T10:00:00.000Z',
  createdBy: 'Ada', baseRef: 'origin/main', plans: [], ...over,
});

const claim = (ref: string, change: ChangedClaim['change'], over: Partial<ChangedClaim> = {}): ChangedClaim => ({
  ref, capability: 'cart', change, ...(change === 'removed' ? { baseHash: 'f'.repeat(64) } : { hash: 'e'.repeat(64) }), ...over,
});

const test = (id: string, strength: TestStrengthClass = 'strong', file = 'tests/cart.test.ts') => ({ id: `${file}::${id}`, file, strength });

const redRecord = (over: Partial<RedRecord> = {}): RedRecord => ({
  version: 1, changeId: record().id, runId: 'r1', at: '2026-10-25T11:00:00.000Z', mode: 'working-tree', claimsHash: H.claims, testsHash: H.tests,
  ownedHash: H.base, baseOwnedHash: H.base,
  tests: [
    { id: 'tests/cart.test.ts::fee', claims: [FEE], status: 'fail' },
    { id: 'tests/cart.test.ts::total', claims: [TOTAL], status: 'fail' },
  ],
  origin: 'local', ...over,
});

const greenRecord = (over: Partial<GreenRecord> = {}): GreenRecord => ({
  version: 1, changeId: record().id, runId: 'g1', at: '2026-10-25T12:00:00.000Z', claimsHash: H.claims, testsHash: H.tests, ownedHash: H.owned,
  tests: [
    { id: 'tests/cart.test.ts::fee', claims: [FEE], status: 'pass' },
    { id: 'tests/cart.test.ts::total', claims: [TOTAL], status: 'pass' },
  ],
  ...over,
});

const approvedBy = (refs: string[]): StageInput['approved'] => new Map(refs.map((r) => [r, { method: 'command', by: 'Ada' }]));

/** A feature change that is fully proven and validated; every case below spoils one fact. */
function input(over: Partial<StageInput> = {}): StageInput {
  return {
    record: record(),
    changed: [claim(FEE, 'modified', { parts: ['text'] }), claim(TOTAL, 'added')],
    approved: approvedBy([FEE, TOTAL]),
    tagged: new Map([[FEE, [test('fee')]], [TOTAL, [test('total')]]]),
    current: { claimsHash: H.claims, testsHash: H.tests, ownedHash: H.owned, baseOwnedHash: H.base },
    codeFiles: ['src/cart.ts'],
    red: redRecord(),
    green: greenRecord(),
    ci: { commit: 'a'.repeat(40), verdict: 'pass' },
    policy: { redAcceptsErrors: 'added-only' },
    ...over,
  };
}

const codes = (s: ChangeStatus): StageBlockCode[] => s.blocks.map((b) => b.code);

describe('stage detection from facts [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('a fully proven and CI-validated feature is validated with nothing left, and done lists every stage in order', () => {
    const s = computeStage(input());
    expect(s).toMatchObject({ stage: 'validated', blocks: [], red: 'valid', id: record().id, kind: 'feature' });
    expect(s.done).toEqual([...STAGES]);
    expect(s.next).toBe(`specguard change done ${record().id}`);
    expect(s.lockedTests).toEqual(['tests/cart.test.ts']);
    expect(s.codeFiles).toEqual(['src/cart.ts']);
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('feature with no changed claims -> spec, NO_INTENT_CHANGE', () => {
    const s = computeStage(input({ changed: [], tagged: new Map(), red: undefined, green: undefined, ci: undefined }));
    expect(s.stage).toBe('spec');
    expect(codes(s)).toEqual(['NO_INTENT_CHANGE']);
    expect(s.done).toEqual([]);
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('unapproved changed claim -> spec, APPROVAL_PENDING with the spec approve fix naming only the pending refs', () => {
    const s = computeStage(input({ approved: approvedBy([FEE]) }));
    expect(s.stage).toBe('spec');
    expect(s.blocks[0]).toMatchObject({ code: 'APPROVAL_PENDING', refs: [TOTAL], fix: `specguard spec approve ${TOTAL}` });
    expect(s.next).toBe(`specguard spec approve ${TOTAL}`);
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('an approval entry that is undefined, or for another ref, does not approve', () => {
    const s = computeStage(input({ approved: new Map([[FEE, undefined], ['capabilities/cart#other', { method: 'command', by: 'Ada' }]]) }));
    expect(s.blocks[0].refs).toEqual([FEE, TOTAL]);
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('plan-derived approval satisfies spec', () => {
    const plan: HistoryEntry = { id: '2026-10-25-free-shipping', date: '2026-10-25', kind: 'plan', author: 'Grace', affects: ['cart'], file: '/x.md', body: '' };
    const rec = record({ plans: [plan.id] });
    const changed = input().changed;
    const derived = derivePlanApprovals(rec, [plan], changed);
    const approved: StageInput['approved'] = new Map(derived.map((a) => [a.claim, { method: a.method, by: a.by }]));
    const s = computeStage(input({ record: rec, approved, red: undefined, green: undefined, ci: undefined, codeFiles: [] }));
    expect(s.stage).toBe('red');
    expect(s.done).toEqual(['spec', 'tests']);
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('a removed claim needs no approval, test or red; only added and modified refs do', () => {
    const changed = [claim('capabilities/cart#old', 'removed'), claim(FEE, 'modified')];
    const s = computeStage(input({ changed, approved: approvedBy([FEE]), tagged: new Map([[FEE, [test('fee')]]]), red: redRecord({ tests: [{ id: 'tests/cart.test.ts::fee', claims: [FEE], status: 'fail' }] }) }));
    expect(s.stage).toBe('validated');
    expect(computeStage(input({ changed: [claim('capabilities/cart#old', 'removed')], approved: new Map(), tagged: new Map(), red: undefined, green: greenRecord({ tests: [] }) })).stage).toBe('validated');
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('changed claim without tagged test -> tests, TESTS_MISSING with a tag fix', () => {
    const s = computeStage(input({ tagged: new Map([[FEE, [test('fee')]]]) }));
    expect(s.stage).toBe('tests');
    expect(s.blocks[0]).toMatchObject({ code: 'TESTS_MISSING', refs: [TOTAL] });
    expect(s.blocks[0].fix).toContain(`[claims: ${TOTAL}]`);
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it.each<TestStrengthClass>(['weak', 'skipped', 'conditional'])('only %s tests -> tests, TESTS_NOT_MEANINGFUL', (strength) => {
    const s = computeStage(input({ tagged: new Map([[FEE, [test('fee')]], [TOTAL, [test('total', strength), test('total-2', strength)]]]) }));
    expect(s.stage).toBe('tests');
    expect(s.blocks[0]).toMatchObject({ code: 'TESTS_NOT_MEANINGFUL', refs: [TOTAL] });
    expect(isMeaningfulStrength(strength)).toBe(false);
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('one strong or unknown test among weak ones is enough', () => {
    for (const good of ['strong', 'unknown'] as const) {
      const tagged = new Map([[FEE, [test('fee')]], [TOTAL, [test('a', 'weak'), test('b', good)]]]);
      // the tests stage holds; green still wants every tagged test, the weak one included, to have passed
      expect(computeStage(input({ tagged })).done).toEqual(expect.arrayContaining(['spec', 'tests', 'red', 'code']));
      expect(isMeaningfulStrength(good)).toBe(true);
    }
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('no red -> red, RED_MISSING', () => {
    const s = computeStage(input({ red: undefined, green: undefined, ci: undefined, codeFiles: [] }));
    expect(s.stage).toBe('red');
    expect(codes(s)).toEqual(['RED_MISSING']);
    expect(s.red).toBe('none');
    expect(s.next).toBe(`specguard change red ${record().id}`);
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('valid red, no code -> code, NO_CODE_CHANGE; red is valid and its test files are locked', () => {
    const s = computeStage(input({ codeFiles: [], green: undefined, ci: undefined }));
    expect(s.stage).toBe('code');
    expect(codes(s)).toEqual(['NO_CODE_CHANGE']);
    expect(s.red).toBe('valid');
    expect(s.done).toEqual(['spec', 'tests', 'red']);
    expect(s.lockedTests).toEqual(['tests/cart.test.ts']);
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('code, no green -> green, GREEN_MISSING; next is change green', () => {
    const s = computeStage(input({ green: undefined, ci: undefined }));
    expect(s.stage).toBe('green');
    expect(codes(s)).toEqual(['GREEN_MISSING']);
    expect(s.next).toBe(`specguard change green ${record().id}`);
  });

  // [claims: capabilities/spec-first-changes#green-acceptance]
  it('green stale after a code, test or spec edit -> GREEN_STALE', () => {
    const cases: Array<Partial<StageInput['current']>> = [{ ownedHash: 'x'.repeat(64) }, { testsHash: 'x'.repeat(64) }, { claimsHash: 'x'.repeat(64) }];
    // the test and spec edits also stale red, so keep red matching by moving red's hashes along with them
    for (const current of cases) {
      const merged = { ...input().current, ...current };
      const s = computeStage(input({ current: merged, red: redRecord({ claimsHash: merged.claimsHash, testsHash: merged.testsHash }), ci: undefined }));
      expect(s.stage, JSON.stringify(current)).toBe('green');
      expect(codes(s)).toEqual(['GREEN_STALE']);
    }
  });

  // [claims: capabilities/spec-first-changes#green-acceptance]
  it('green failing: a tagged test failed, was skipped or did not run -> GREEN_FAILING with the refs', () => {
    for (const status of ['fail', 'skip', 'error'] as const) {
      const green = greenRecord({ tests: [{ id: 'tests/cart.test.ts::fee', claims: [FEE], status }, { id: 'tests/cart.test.ts::total', claims: [TOTAL], status: 'pass' }] });
      const s = computeStage(input({ green, ci: undefined }));
      expect(s.stage, status).toBe('green');
      expect(s.blocks[0]).toMatchObject({ code: 'GREEN_FAILING', refs: [FEE] });
    }
    const missing = judgeGreen(input({ green: greenRecord({ tests: [{ id: 'tests/cart.test.ts::fee', claims: [FEE], status: 'pass' }] }) }));
    expect(missing).toMatchObject({ state: 'failing', blocks: [{ code: 'GREEN_FAILING', refs: [TOTAL] }] });
  });

  // [claims: capabilities/spec-first-changes#green-acceptance]
  it('a green record of another change, or an extra failing test that covers no changed ref, does not decide', () => {
    expect(judgeGreen(input({ green: greenRecord({ changeId: '20261025-other-0000' }) })).state).toBe('missing');
    const extra = greenRecord({ tests: [...greenRecord().tests, { id: 'tests/other.test.ts::x', claims: ['capabilities/cart#other'], status: 'fail' }] });
    expect(judgeGreen(input({ green: extra })).state).toBe('valid');
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('green ok, no ci -> validated pending NOT_VALIDATED, with git push as the next step', () => {
    const s = computeStage(input({ ci: undefined }));
    expect(s.stage).toBe('validated');
    expect(codes(s)).toEqual(['NOT_VALIDATED']);
    expect(s.done).toEqual(['spec', 'tests', 'red', 'code', 'green']);
    expect(s.next).toMatch(/^git push/);
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('ci pass -> stage validated and done; ci fail -> VALIDATION_FAILED; a spike verdict does not validate a feature', () => {
    expect(computeStage(input()).done).toContain('validated');
    const failed = computeStage(input({ ci: { commit: 'b'.repeat(40), verdict: 'fail' } }));
    expect(codes(failed)).toEqual(['VALIDATION_FAILED']);
    expect(failed.blocks[0].message).toContain('bbbbbbbb');
    expect(failed.next).toBe(`specguard change report ${record().id}`);
    const spike = computeStage(input({ ci: { commit: 'c'.repeat(40), verdict: 'spike' } }));
    expect(codes(spike)).toEqual(['NOT_VALIDATED']);
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('editing the record cannot advance a stage: the record only supplies kind, capabilities and the id', () => {
    const rec = { ...record(), done: ['spec', 'tests', 'red', 'code', 'green', 'validated'], stage: 'validated' } as unknown as ChangeRecord;
    const s = computeStage(input({ record: rec, changed: [], tagged: new Map(), red: undefined, green: undefined, ci: undefined }));
    expect(s.stage).toBe('spec');
  });

  // [claims: capabilities/spec-first-changes#stages-detected-from-facts]
  it('next is one command matching the first block, for every blocking state', () => {
    const base = input();
    const scenarios: StageInput[] = [
      input({ changed: [] }),
      input({ approved: new Map() }),
      input({ tagged: new Map() }),
      input({ tagged: new Map([[FEE, [test('f', 'weak')]], [TOTAL, [test('t')]]]) }),
      input({ red: undefined }),
      input({ red: redRecord({ tests: [] }) }),
      input({ red: redRecord({ testsHash: 'x'.repeat(64) }) }),
      input({ codeFiles: [] }),
      input({ green: undefined }),
      input({ green: greenRecord({ ownedHash: 'x'.repeat(64) }) }),
      input({ ci: undefined }),
      input({ ci: { commit: 'a'.repeat(40), verdict: 'fail' } }),
      input({ record: record({ kind: 'refactor' }) }),
      input({ record: record({ kind: 'spike' }) }),
    ];
    expect(computeStage(base).next).toBe(`specguard change done ${record().id}`);
    for (const s of scenarios) {
      const out = computeStage(s);
      expect(out.blocks.length).toBeGreaterThan(0);
      expect(out.next).toBe(out.blocks[0].fix);
      expect(out.next).not.toContain('\n');
      expect(out.blocks.every((b) => b.message.length > 0 && b.fix.length > 0)).toBe(true);
    }
  });

  // [claims: capabilities/spec-first-changes#parallel-and-abandoned]
  it('a closed change keeps its closed fields in the status, and a closed change has nothing to do next', () => {
    const closed = { at: '2026-10-26T00:00:00.000Z', by: 'Ada', reason: 'abandoned' as const, note: 'superseded' };
    const open = computeStage(input({ record: record({ closed }), changed: [], tagged: new Map() }));
    expect(open.closed).toEqual(closed);
    const done = computeStage(input({ record: record({ closed: { ...closed, reason: 'done' } }) }));
    expect(done.next).toMatch(/^nothing/);
    expect(computeStage(input()).closed).toBeUndefined();
  });

  // [claims: capabilities/spec-first-changes#parallel-and-abandoned]
  it('two changes on one branch see the same changed claims and are judged separately by their own run records', () => {
    const other = record({ id: '20261025-other-ffff' });
    const a = computeStage(input());
    const b = computeStage(input({ record: other }));
    expect(b.changed).toEqual(a.changed);
    expect(a.stage).toBe('validated');
    expect(b.stage).toBe('red'); // the red and green records belong to the first change
    expect(codes(b)).toEqual(['RED_MISSING']);
  });
});

describe('stage locks [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#stage-locks]
  it('tests edited after red with code present -> back to tests, RED_INVALID_TESTS_EDITED, red invalid', () => {
    const current = { ...input().current, testsHash: 'x'.repeat(64) };
    const s = computeStage(input({ current, green: undefined, ci: undefined }));
    expect(s.stage).toBe('tests');
    expect(codes(s)).toEqual(['RED_INVALID_TESTS_EDITED']);
    expect(s.red).toBe('invalid');
    expect(s.done).toEqual(['spec']);
    expect(s.next).toBe(`specguard change red ${record().id}`);
    expect(s.lockedTests).toEqual([]);
  });

  // [claims: capabilities/spec-first-changes#stage-locks]
  it('spec edited after red (and approved again) -> RED_INVALID_SPEC_EDITED', () => {
    const current = { ...input().current, claimsHash: 'x'.repeat(64) };
    const s = computeStage(input({ current, green: undefined, ci: undefined }));
    expect(s.stage).toBe('tests');
    expect(codes(s)).toEqual(['RED_INVALID_SPEC_EDITED']);
    expect(s.red).toBe('invalid');
  });

  // [claims: capabilities/spec-first-changes#stage-locks]
  it('both edited -> both lock blocks; an edit that is also unapproved reports the approval first, then the lock', () => {
    const current = { ...input().current, claimsHash: 'x'.repeat(64), testsHash: 'y'.repeat(64) };
    expect(codes(computeStage(input({ current })))).toEqual(['RED_INVALID_TESTS_EDITED', 'RED_INVALID_SPEC_EDITED']);
    const s = computeStage(input({ current, approved: new Map() }));
    expect(s.stage).toBe('spec');
    expect(codes(s)).toEqual(['APPROVAL_PENDING', 'RED_INVALID_TESTS_EDITED', 'RED_INVALID_SPEC_EDITED']);
    expect(s.next).toMatch(/^specguard spec approve /);
  });

  // [claims: capabilities/spec-first-changes#stage-locks]
  it('before any code exists an edited test only makes the recorded red stale: stage red, RED_MISSING, red invalid', () => {
    const current = { ...input().current, testsHash: 'x'.repeat(64) };
    const s = computeStage(input({ current, codeFiles: [], green: undefined, ci: undefined }));
    expect(s.stage).toBe('red');
    expect(codes(s)).toEqual(['RED_MISSING']);
    expect(s.blocks[0].message).toContain('record it again');
    expect(s.red).toBe('invalid');
  });

  // [claims: capabilities/spec-first-changes#stage-locks]
  it('re-recording red against current hashes lifts the lock, in a constructed tree', () => {
    const current = { ...input().current, testsHash: 'x'.repeat(64) };
    const rerecorded = redRecord({ testsHash: current.testsHash, mode: 'constructed' });
    const s = computeStage(input({ current, red: rerecorded, green: greenRecord({ testsHash: current.testsHash }) }));
    expect(s.stage).toBe('validated');
    expect(s.red).toBe('valid');
  });

  // [claims: capabilities/spec-first-changes#stage-locks]
  it('locked tests list every file tagged to a changed ref, once, sorted, only while red is valid', () => {
    const tagged = new Map([[FEE, [test('fee', 'strong', 'tests/b.test.ts'), test('fee2', 'strong', 'tests/a.test.ts')]], [TOTAL, [test('total', 'strong', 'tests/a.test.ts')]]]);
    const red = redRecord({ tests: [{ id: 'tests/b.test.ts::fee', claims: [FEE], status: 'fail' }, { id: 'x', claims: [TOTAL], status: 'fail' }] });
    const s = computeStage(input({ tagged, red, green: undefined, ci: undefined, codeFiles: [] }));
    expect(s.lockedTests).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });
});

describe('red evidence rules [spec-first-changes]', () => {
  const facts = (over: Partial<StageInput> = {}): Parameters<typeof judgeRed>[0] => input(over);

  // [claims: capabilities/spec-first-changes#red-acceptance]
  it('red with a passing test for a ref -> RED_NOT_RED naming that ref only', () => {
    const red = redRecord({ tests: [{ id: 'tests/cart.test.ts::fee', claims: [FEE], status: 'pass' }, { id: 'tests/cart.test.ts::total', claims: [TOTAL], status: 'fail' }] });
    const s = computeStage(input({ red, codeFiles: [], green: undefined, ci: undefined }));
    expect(s.stage).toBe('red');
    expect(s.blocks[0]).toMatchObject({ code: 'RED_NOT_RED', refs: [FEE] });
    expect(s.red).toBe('invalid');
  });

  // [claims: capabilities/spec-first-changes#red-acceptance]
  it('red error accepted for added claim, refused for modified claim under added-only', () => {
    const red = redRecord({ tests: [{ id: 'a', claims: [FEE], status: 'error' }, { id: 'b', claims: [TOTAL], status: 'error' }] });
    const out = judgeRed(facts({ red, codeFiles: [] }));
    expect(out.redRefs).toEqual([TOTAL]);
    expect(out.notRed).toEqual([FEE]);
    expect(out.state).toBe('invalid');
  });

  // [claims: capabilities/spec-first-changes#red-acceptance]
  it.each([
    ['never', 'modified', false], ['never', 'added', false],
    ['added-only', 'modified', false], ['added-only', 'added', true],
    ['always', 'modified', true], ['always', 'added', true],
  ] as const)('policy %s with a %s ref: error counts as red = %s', (policy, change, accepted) => {
    expect(errorCountsAsRed(policy, change)).toBe(accepted);
    const ref = change === 'added' ? TOTAL : FEE;
    const out = judgeRed(facts({ policy: { redAcceptsErrors: policy }, red: redRecord({ tests: [{ id: 'a', claims: [FEE, TOTAL], status: 'error' }] }) }));
    expect(out.redRefs.includes(ref)).toBe(accepted);
  });

  // [claims: capabilities/spec-first-changes#red-acceptance]
  it('a skipped result is never red, and one failing test is enough even beside passing ones', () => {
    const skipOnly = judgeRed(facts({ red: redRecord({ tests: [{ id: 'a', claims: [FEE, TOTAL], status: 'skip' }] }) }));
    expect(skipOnly.notRed).toEqual([FEE, TOTAL]);
    const mixed = judgeRed(facts({
      red: redRecord({ tests: [{ id: 'a', claims: [FEE, TOTAL], status: 'pass' }, { id: 'b', claims: [FEE, TOTAL], status: 'fail' }] }),
    }));
    expect(mixed).toMatchObject({ state: 'valid', redRefs: [FEE, TOTAL], notRed: [] });
  });

  // [claims: capabilities/spec-first-changes#red-acceptance]
  it('extra tests in the run are ignored, and a ref no run test covers is not red', () => {
    const red = redRecord({ tests: [{ id: 'extra', claims: ['capabilities/cart#unrelated'], status: 'fail' }, { id: 'a', claims: [FEE], status: 'fail' }] });
    const out = judgeRed(facts({ red }));
    expect(out.redRefs).toEqual([FEE]);
    expect(out.notRed).toEqual([TOTAL]);
  });

  // [claims: capabilities/spec-first-changes#red-acceptance]
  it('a row ref is red through a failing test tagged to the row', () => {
    const row = `${FEE}/ak-any`;
    const changed = [claim(FEE, 'modified', { parts: ['rows-added'] }), claim(row, 'added')];
    const red = redRecord({ tests: [{ id: 'a', claims: [FEE, row], status: 'fail' }] });
    expect(judgeRed(facts({ changed, red })).redRefs).toEqual([FEE, row]);
    const rowPasses = redRecord({ tests: [{ id: 'a', claims: [FEE], status: 'fail' }, { id: 'b', claims: [row], status: 'pass' }] });
    expect(judgeRed(facts({ changed, red: rowPasses })).notRed).toEqual([row]);
  });

  // [claims: capabilities/spec-first-changes#red-acceptance]
  it('red recorded with code ahead -> RED_CODE_AHEAD, whichever mode recorded it', () => {
    for (const mode of ['working-tree', 'constructed'] as const) {
      const s = computeStage(input({ red: redRecord({ ownedHash: H.owned, mode }), codeFiles: [], green: undefined, ci: undefined }));
      expect(s.stage, mode).toBe('red');
      expect(codes(s), mode).toEqual(['RED_CODE_AHEAD']);
      expect(s.red).toBe('invalid');
    }
  });

  // [claims: capabilities/spec-first-changes#red-acceptance]
  it('a red record that belongs to another change is no red at all', () => {
    const out = judgeRed(facts({ red: redRecord({ changeId: '20261025-other-0000' }) }));
    expect(out).toMatchObject({ state: 'none', blocks: [{ code: 'RED_MISSING' }] });
  });

  // [claims: capabilities/spec-first-changes#red-acceptance]
  it('reports every reason red fails at once: edited tests, code ahead and an unfailing ref', () => {
    const red = redRecord({ ownedHash: H.owned, tests: [] });
    const out = judgeRed(facts({ red, current: { ...input().current, testsHash: 'x'.repeat(64) } }));
    expect(out.blocks.map((b) => b.code)).toEqual(['RED_INVALID_TESTS_EDITED', 'RED_CODE_AHEAD', 'RED_NOT_RED']);
  });

  // [claims: capabilities/spec-first-changes#red-acceptance]
  it('changed-claims and test-file hashes ignore input order and distinguish content', () => {
    const a = [claim(FEE, 'modified'), claim(TOTAL, 'added')];
    expect(changedClaimsHash(a)).toBe(changedClaimsHash([...a].reverse()));
    expect(changedClaimsHash(a)).not.toBe(changedClaimsHash([claim(FEE, 'modified', { hash: '1'.repeat(64) }), claim(TOTAL, 'added')]));
    expect(changedClaimsHash([claim(FEE, 'removed')])).not.toBe(changedClaimsHash([claim(FEE, 'modified')]));
    const f = [{ path: 'a.ts', sha256: '1' }, { path: 'b.ts', sha256: '2' }];
    expect(testFilesHash(f)).toBe(testFilesHash([...f].reverse()));
    expect(testFilesHash(f)).not.toBe(testFilesHash([{ path: 'a.ts', sha256: '2' }, { path: 'b.ts', sha256: '1' }]));
    expect(changedClaimsHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('refactor and spike [spec-first-changes]', () => {
  const refactor = (over: Partial<StageInput> = {}): StageInput =>
    input({
      record: record({ kind: 'refactor' }), changed: [], approved: new Map(), tagged: new Map(), red: undefined,
      green: greenRecord({ tests: [{ id: 'tests/cart.test.ts::a', claims: [FEE], status: 'pass' }] }), ...over,
    });

  // [claims: capabilities/spec-first-changes#refactor-rules]
  it('refactor with changed claim -> REFACTOR_CHANGES_INTENT', () => {
    const s = computeStage(refactor({ changed: [claim(FEE, 'modified')] }));
    expect(s.stage).toBe('spec');
    expect(s.blocks[0]).toMatchObject({ code: 'REFACTOR_CHANGES_INTENT', refs: [FEE] });
    expect(s.blocks[0].fix).toContain('specguard change start cart');
  });

  // [claims: capabilities/spec-first-changes#refactor-rules]
  it('refactor skips spec/tests/red: with no changed claim, no tests and no red it asks only for code', () => {
    const s = computeStage(refactor({ codeFiles: [], green: undefined, ci: undefined }));
    expect(s.done).toEqual(['spec', 'tests', 'red']);
    expect(s.stage).toBe('code');
    expect(codes(s)).toEqual(['NO_CODE_CHANGE']);
    expect(s.red).toBe('none');
    expect(s.lockedTests).toEqual([]);
  });

  // [claims: capabilities/spec-first-changes#refactor-rules]
  it('refactor is satisfied by code, a green run of all the capability claim tests, and a CI pass', () => {
    expect(computeStage(refactor({ green: undefined, ci: undefined })).stage).toBe('green');
    expect(computeStage(refactor({ ci: undefined }))).toMatchObject({ stage: 'validated', blocks: [{ code: 'NOT_VALIDATED' }] });
    const s = computeStage(refactor());
    expect(s).toMatchObject({ stage: 'validated', blocks: [] });
    expect(s.done).toEqual([...STAGES]);
  });

  // [claims: capabilities/spec-first-changes#refactor-rules]
  it('refactor green fails on any claim test that did not pass, on a run with no tests, and when stale', () => {
    const failing = refactor({ green: greenRecord({ tests: [{ id: 'a', claims: [FEE], status: 'pass' }, { id: 'b', claims: [TOTAL], status: 'fail' }] }) });
    expect(computeStage(failing).blocks[0]).toMatchObject({ code: 'GREEN_FAILING', refs: [TOTAL] });
    expect(computeStage(refactor({ green: greenRecord({ tests: [] }) })).blocks[0]).toMatchObject({ code: 'GREEN_FAILING', message: expect.stringContaining('no claim tests') });
    expect(computeStage(refactor({ green: greenRecord({ ownedHash: 'x'.repeat(64) }) })).blocks[0].code).toBe('GREEN_STALE');
  });

  // [claims: capabilities/spec-first-changes#spike-rules]
  it('spike never validates: everything else proven, CI pass, still SPIKE_CANNOT_VALIDATE with convert as the next step', () => {
    const s = computeStage(input({ record: record({ kind: 'spike' }) }));
    expect(s.stage).toBe('validated');
    expect(codes(s)).toEqual(['SPIKE_CANNOT_VALIDATE']);
    expect(s.done).toEqual(['spec', 'tests', 'red', 'code', 'green']);
    expect(s.next).toBe(`specguard change convert ${record().id} --to feature`);
  });

  // [claims: capabilities/spec-first-changes#spike-rules]
  it('spike needs the same spec, tests and red as a feature, although its code may already exist', () => {
    const rec = record({ kind: 'spike' });
    expect(computeStage(input({ record: rec, changed: [], tagged: new Map() })).blocks[0].code).toBe('NO_INTENT_CHANGE');
    expect(computeStage(input({ record: rec, approved: new Map() })).blocks[0].code).toBe('APPROVAL_PENDING');
    expect(computeStage(input({ record: rec, tagged: new Map() })).blocks[0].code).toBe('TESTS_MISSING');
    // code first, then tests written afterwards, red recorded in a constructed tree
    const constructed = computeStage(input({ record: rec, red: redRecord({ mode: 'constructed' }), green: undefined, ci: undefined }));
    expect(constructed.stage).toBe('green');
    expect(constructed.red).toBe('valid');
    expect(computeStage(input({ record: rec, red: undefined, green: undefined, ci: undefined })).blocks[0].code).toBe('RED_MISSING');
  });

  // [claims: capabilities/spec-first-changes#spike-rules]
  it('a spike converted to a feature is judged as a feature and can validate', () => {
    const converted = record({ kind: 'feature', convertedFrom: { kind: 'spike', at: '2026-10-25T13:00:00.000Z', by: 'Ada' } });
    expect(computeStage(input({ record: converted })).stage).toBe('validated');
    expect(computeStage(input({ record: converted })).blocks).toEqual([]);
  });
});
