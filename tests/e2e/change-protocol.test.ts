import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { changeStatuses, runChangeDone } from '../../src/pipelines/change.js';
import { runSpecApprove } from '../../src/pipelines/approve.js';
import type { RunRecord } from '../../src/pipelines/test-run.js';
import { SHIPPING_TITLE, addFreeShippingClaim, approveShop, gitCommit, writeShopCode } from '../helpers/change-fixture.js';
import {
  blockCodes,
  claudeEdit,
  codexPatch,
  e2eRepo,
  green,
  red,
  stageOf,
  startChange,
  writeShippingTest,
} from '../helpers/e2e-protocol.js';
import type { TmpRepo } from '../helpers/repo.js';

const CODE = 'src/shop/cart.ts';
const SHOP_SPEC = 'specs/capabilities/shop.md';
const read = (repo: TmpRepo, rel: string): string => readFileSync(path.join(repo.dir, rel), 'utf8');
const historyFiles = (repo: TmpRepo): string[] => readdirSync(path.join(repo.dir, 'specs', 'history'));

describe('the change protocol, end to end, through the real CLI pipelines and the real hook process [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#e2e-full-protocol, capabilities/spec-first-changes#e2e-hook-follows-red, capabilities/spec-first-changes#e2e-agent-cannot-approve, capabilities/spec-first-changes#e2e-locked-test-edit]
  it('walks spec, approval, tests, red, code, green and the stage lock, with the hook gating the code at every step', async () => {
    const repo = await e2eRepo({ shop: 'enforce' });

    // (a) no change is open: both hosts' edits to owned code are denied, with the one command that fixes it
    const noChange = claudeEdit(repo, CODE);
    expect([noChange.decision, noChange.code]).toEqual(['deny', 'DENY_NO_CHANGE']);
    expect(noChange.message).toContain('specguard change start shop');
    expect(codexPatch(repo, CODE)).toMatchObject({ decision: 'deny', code: 'DENY_NO_CHANGE' });

    // a change is started and records only intent
    const id = await startChange(repo);
    expect((await stageOf(repo, id)).stage).toBe('spec');
    expect(claudeEdit(repo, CODE)).toMatchObject({ decision: 'deny', code: 'DENY_NOT_APPROVED' });

    // the spec edit adds a requirement; nothing approved it, so the code stays closed
    addFreeShippingClaim(repo);
    let s = await stageOf(repo, id);
    expect([s.stage, ...blockCodes(s)]).toEqual(['spec', 'APPROVAL_PENDING']);
    const unapproved = claudeEdit(repo, CODE);
    expect([unapproved.decision, unapproved.code]).toEqual(['deny', 'DENY_NOT_APPROVED']);
    expect(unapproved.message).toContain('nobody approved');

    // an agent cannot approve: the command refuses, and nothing is written
    const before = historyFiles(repo);
    const refused = await runSpecApprove(await loadConfig(repo.dir), { targets: ['shop'], yes: true, by: 'bot', actor: { agent: true, tty: false } });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.messages.join('\n')).toContain('approvals must be given by a person');
    expect(historyFiles(repo)).toEqual(before);
    expect(blockCodes(await stageOf(repo, id))).toEqual(['APPROVAL_PENDING']);

    // a person approves; the hook now wants a failing test first
    await approveShop(repo);
    s = await stageOf(repo, id);
    expect([s.stage, ...blockCodes(s)]).toEqual(['tests', 'TESTS_MISSING']);
    const beforeRed = claudeEdit(repo, CODE);
    expect([beforeRed.decision, beforeRed.code]).toEqual(['deny', 'DENY_BEFORE_RED']);
    expect(beforeRed.message).toContain(`specguard change red ${id}`);

    // tests are written and tagged: still no code, because nobody has seen them fail
    writeShippingTest(repo);
    s = await stageOf(repo, id);
    expect([s.stage, ...blockCodes(s)]).toEqual(['red', 'RED_MISSING']);
    expect(claudeEdit(repo, CODE)).toMatchObject({ decision: 'deny', code: 'DENY_BEFORE_RED' });

    // `change red` records a failing run of exactly the changed requirement's tests (not auth's, not the baseline cart test)
    const redRun = await red(repo, id);
    expect(redRun.exitCode, redRun.messages.join('\n')).toBe(0);
    const record = JSON.parse(read(repo, `.specguard/runs/${id}-red.json`)) as RunRecord;
    expect(record.tests).toEqual([{ file: 'tests/shop.test.ts', title: SHIPPING_TITLE, refs: ['capabilities/shop#free-shipping'], verdict: 'fail' }]);

    // the hook reads the very file `change red` wrote: its verdicts are the run's, and it names the files red locks
    const pointer = JSON.parse(read(repo, `.specguard/cache/changes/${id}/red.json`));
    expect(pointer.tests).toEqual([{ id: `tests/shop.test.ts::${SHIPPING_TITLE}`, claims: ['capabilities/shop#free-shipping'], status: 'fail' }]);
    expect(pointer.lockedTests).toEqual(['tests/shop.test.ts']);
    expect(pointer.runId).toBe(record.runId);
    // the hook reads the very record `change red` wrote: it now allows the code, on both hosts
    s = await stageOf(repo, id);
    expect([s.stage, s.red, ...blockCodes(s)]).toEqual(['code', 'valid', 'NO_CODE_CHANGE']);
    expect(claudeEdit(repo, CODE)).toMatchObject({ decision: 'allow', code: 'ALLOW_CHANGE' });
    expect(codexPatch(repo, CODE)).toMatchObject({ decision: 'allow', code: 'ALLOW_CHANGE' });
    // the tests that red locked are now announced when edited, and the spec too
    expect(claudeEdit(repo, 'tests/shop.test.ts')).toMatchObject({ decision: 'allow', code: 'LOCK_TESTS' });
    expect(claudeEdit(repo, SHOP_SPEC)).toMatchObject({ decision: 'allow', code: 'LOCK_SPEC' });

    // the code edit, then green: the stage is validated locally and waits for CI
    writeShopCode(repo);
    const greenRun = await green(repo, id);
    expect(greenRun.exitCode, greenRun.messages.join('\n')).toBe(0);
    s = await stageOf(repo, id);
    expect(s.done).toEqual(['spec', 'tests', 'red', 'code', 'green']);
    expect([s.stage, ...blockCodes(s)]).toEqual(['validated', 'NOT_VALIDATED']);
    expect(s.next).toBe('git push (CI validates the change)');
    // nothing a person did not decide: `done` is refused until CI says so
    const notYet = await runChangeDone(await loadConfig(repo.dir), { id });
    expect(notYet.exitCode).not.toBe(0);

    // editing a locked test after red sends the change back, and the hook closes the code again until red is recorded anew
    repo.write('tests/shop.test.ts', `${read(repo, 'tests/shop.test.ts')}// a later, quieter assertion\n`);
    s = await stageOf(repo, id);
    expect([s.stage, s.red, ...blockCodes(s)]).toEqual(['tests', 'invalid', 'RED_INVALID_TESTS_EDITED']);
    const locked = claudeEdit(repo, CODE);
    expect([locked.decision, locked.code]).toEqual(['deny', 'DENY_BEFORE_RED']);
    expect(locked.message).toContain(`specguard change red ${id}`);

    // red is recorded again against the base code (a constructed tree: code exists), the working tree is untouched
    gitCommit(repo.dir, 'spec, approval, tests and code');
    const again = await red(repo, id);
    expect(again.exitCode, again.messages.join('\n')).toBe(0);
    expect(again.messages.join('\n')).toContain('constructed tree');
    expect(read(repo, CODE)).toContain('FREE_SHIPPING');
    expect(claudeEdit(repo, CODE)).toMatchObject({ decision: 'allow', code: 'ALLOW_CHANGE' });
    expect(blockCodes(await stageOf(repo, id))).toEqual(['GREEN_STALE']);
    expect((await green(repo, id)).exitCode).toBe(0);
    expect(blockCodes(await stageOf(repo, id))).toEqual(['NOT_VALIDATED']);
  }, 120_000);

  // [claims: capabilities/spec-first-changes#e2e-refactor-spike]
  it('lets a refactor edit its own capability at once and no other, and refuses a requirement edit under it', async () => {
    const repo = await e2eRepo({ shop: 'enforce', auth: 'enforce' });
    const id = await startChange(repo, { kind: 'refactor', why: 'tidy the cart' });

    // order does not matter for a refactor: no intent changes, so the code is open, but only its capability's code
    expect(claudeEdit(repo, CODE)).toMatchObject({ decision: 'allow', code: 'ALLOW_REFACTOR' });
    expect(claudeEdit(repo, 'src/auth/login.ts')).toMatchObject({ decision: 'deny', code: 'DENY_NO_CHANGE' });

    let s = await stageOf(repo, id);
    expect([s.stage, ...blockCodes(s)]).toEqual(['code', 'NO_CODE_CHANGE']);
    expect(s.done).toEqual(['spec', 'tests', 'red']);
    // there is nothing to see failing, so red is refused
    const noRed = await red(repo, id);
    expect(noRed.exitCode).not.toBe(0);
    expect(noRed.messages.join('\n')).toContain('is a refactor');

    // a behaviour-neutral edit, then green over every claim test of the capability
    repo.write(CODE, 'export const cart = 1; // renamed nothing, moved nothing\n');
    s = await stageOf(repo, id);
    expect([s.stage, ...blockCodes(s)]).toEqual(['green', 'GREEN_MISSING']);
    const run = await green(repo, id);
    expect(run.exitCode, run.messages.join('\n')).toBe(0);
    s = await stageOf(repo, id);
    expect([s.stage, ...blockCodes(s)]).toEqual(['validated', 'NOT_VALIDATED']);

    // a requirement edit turns it into something else: a refactor changes no intent
    addFreeShippingClaim(repo);
    s = await stageOf(repo, id);
    expect([s.stage, ...blockCodes(s)]).toEqual(['spec', 'REFACTOR_CHANGES_INTENT']);
    expect(s.next).toContain('specguard change start shop');
  }, 120_000);

  // [claims: capabilities/spec-first-changes#e2e-refactor-spike]
  it('lets a spike write code first, but a spike can never reach validated, not even with a passing CI verdict', async () => {
    const repo = await e2eRepo({ shop: 'enforce' });
    const id = await startChange(repo, { kind: 'spike', why: 'try free shipping' });

    const first = claudeEdit(repo, CODE);
    expect([first.decision, first.code]).toEqual(['allow', 'ALLOW_SPIKE']);
    expect(first.message).toContain('Spike');
    writeShopCode(repo);
    const s = await stageOf(repo, id);
    expect([s.kind, s.stage, ...blockCodes(s)]).toEqual(['spike', 'spec', 'NO_INTENT_CHANGE']);
    expect(s.codeFiles).toEqual([CODE]);

    // it grows a spec and tests after the fact: red is built against the base code, so the late tests still have to fail there
    addFreeShippingClaim(repo);
    await approveShop(repo);
    writeShippingTest(repo);
    gitCommit(repo.dir, 'spike work');
    expect((await red(repo, id)).exitCode).toBe(0);
    expect((await green(repo, id)).exitCode).toBe(0);

    const config = await loadConfig(repo.dir);
    const withCi = await changeStatuses(config, { id, ci: { commit: 'b'.repeat(40), verdict: 'pass' } });
    if (!withCi.ok) throw new Error(withCi.error);
    const spiked = withCi.changes[0]!;
    expect(spiked.done).not.toContain('validated');
    expect(blockCodes(spiked)).toEqual(['SPIKE_CANNOT_VALIDATE']);
    expect(spiked.next).toBe(`specguard change convert ${id} --to feature`);
    const done = await runChangeDone(config, { id, ci: { commit: 'b'.repeat(40), verdict: 'pass' } });
    expect(done.exitCode).not.toBe(0);
    expect(existsSync(path.join(repo.dir, '.specguard', 'changes', `${id}.json`))).toBe(true);
    expect(JSON.parse(read(repo, `.specguard/changes/${id}.json`)).closed).toBeUndefined();
  }, 120_000);
});
