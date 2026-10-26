import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { CHANGES_DIR, parseChangeRecord } from '../../src/core/change-record.js';
import {
  buildChangePacket,
  changeStatuses,
  runChangeAbandon,
  runChangeConvert,
  runChangeDone,
  runChangeList,
  runChangeStart,
  runChangeStatus,
  type ChangeStatusEntry,
} from '../../src/pipelines/change.js';
import { runChangeGreen, runChangeRed } from '../../src/pipelines/change-run.js';
import { capturePlan } from '../../src/pipelines/history.js';
import {
  CART_TOTALS,
  FREE_SHIPPING,
  addFreeShippingClaim,
  approveShop,
  changeRepo,
  commentTag,
  gitCommit,
  read,
  shopTestSource,
  writeShopCode,
  writeShopTests,
} from '../helpers/change-fixture.js';
import type { TmpRepo } from '../helpers/repo.js';

const NOW = new Date('2026-10-26T10:00:00.000Z');
const random = () => 'a1b2';

const start = async (repo: TmpRepo, opts: Partial<Parameters<typeof runChangeStart>[1]> = {}) =>
  runChangeStart(await loadConfig(repo.dir), { capabilities: ['shop'], why: 'free shipping', now: NOW, random, ...opts });

/** Start a change and return its id (the record the command wrote). */
async function begin(repo: TmpRepo, opts: Partial<Parameters<typeof runChangeStart>[1]> = {}): Promise<string> {
  const r = await start(repo, opts);
  expect(r.exitCode, r.messages.join('\n')).toBe(0);
  return r.items[0]!.key;
}

async function statusOf(repo: TmpRepo, id?: string): Promise<ChangeStatusEntry> {
  const got = await changeStatuses(await loadConfig(repo.dir), { id });
  if (!got.ok) throw new Error(got.error);
  expect(got.errors).toEqual([]);
  return got.changes[0]!;
}

const codes = (s: ChangeStatusEntry): string[] => s.blocks.map((b) => b.code);
const recordFile = (repo: TmpRepo, id: string): string => path.join(repo.dir, CHANGES_DIR, `${id}.json`);

describe('change start [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#change-start-record]
  it('writes one record of declared intent and refuses an unknown capability, writing nothing', async () => {
    const repo = changeRepo();
    const refused = await start(repo, { capabilities: ['shopp'] });
    expect(refused.exitCode).toBe(1);
    expect(refused.messages.join('\n')).toContain('no capability named shopp; known: auth, shop');
    expect(existsSync(path.join(repo.dir, CHANGES_DIR))).toBe(false);

    const id = await begin(repo);
    expect(id).toBe('20261026-free-shipping-a1b2');
    expect(readdirSync(path.join(repo.dir, CHANGES_DIR))).toEqual([`${id}.json`]);
    const parsed = parseChangeRecord(read(repo, `${CHANGES_DIR}/${id}.json`), 'record');
    expect(parsed.ok && parsed.record).toMatchObject({ kind: 'feature', capabilities: ['shop'], why: 'free shipping', plans: [] });
    // nothing but declared intent: no stage, no run ids
    expect(Object.keys(JSON.parse(read(repo, `${CHANGES_DIR}/${id}.json`))).sort()).toEqual(['baseRef', 'branch', 'capabilities', 'createdAt', 'createdBy', 'id', 'kind', 'plans', 'startSha', 'version', 'why']);
    expect((await start(repo, { capabilities: [] })).exitCode).toBe(1);
    expect((await start(repo, { plan: 'no-such-entry' })).messages.join('\n')).toContain('no history entry');
  });

  // [claims: capabilities/spec-first-changes#change-base-pinned]
  it('pins the base commit when the branch is the base ref, so later commits do not hide the change', async () => {
    const repo = changeRepo();
    const id = await begin(repo);
    const record = JSON.parse(read(repo, `${CHANGES_DIR}/${id}.json`));
    expect(record.baseRef).toBe(record.startSha);
    addFreeShippingClaim(repo);
    gitCommit(repo.dir, 'spec edit');
    expect((await statusOf(repo, id)).changed.map((c) => c.ref)).toEqual([FREE_SHIPPING]);
    // an explicit base that does not resolve fails instead of falling back
    const bad = await runChangeStatus(await loadConfig(repo.dir), { id, base: 'no-such-ref' });
    expect(bad.exitCode).toBe(1);
    expect(bad.messages.join('\n')).toContain('does not resolve');
  });
});

describe('change status [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#change-stages-detected-live]
  it('detects spec -> approval -> tests -> red -> code -> green from real edits', async () => {
    const repo = changeRepo();
    const id = await begin(repo);

    let s = await statusOf(repo, id);
    expect(s.stage).toBe('spec');
    expect(codes(s)).toEqual(['NO_INTENT_CHANGE']);

    addFreeShippingClaim(repo);
    s = await statusOf(repo, id);
    expect(s.stage).toBe('spec');
    expect(codes(s)).toEqual(['APPROVAL_PENDING']);
    expect(s.next).toBe(`specguard spec approve ${FREE_SHIPPING}`);
    expect(s.changed.map((c) => [c.ref, c.change])).toEqual([[FREE_SHIPPING, 'added']]);

    await approveShop(repo);
    s = await statusOf(repo, id);
    expect([s.stage, ...codes(s)]).toEqual(['tests', 'TESTS_MISSING']);

    writeShopTests(repo);
    s = await statusOf(repo, id);
    expect([s.stage, ...codes(s)]).toEqual(['red', 'RED_MISSING']);
    expect(s.next).toBe(`specguard change red ${id}`);

    const red = await runChangeRed(await loadConfig(repo.dir), { id });
    expect(red.exitCode, red.messages.join('\n')).toBe(0);
    s = await statusOf(repo, id);
    expect([s.stage, ...codes(s)]).toEqual(['code', 'NO_CODE_CHANGE']);
    expect(s.red).toBe('valid');
    expect(s.lockedTests).toEqual(['tests/shop.test.ts']);

    writeShopCode(repo);
    s = await statusOf(repo, id);
    expect([s.stage, ...codes(s)]).toEqual(['green', 'GREEN_MISSING']);
    expect(s.codeFiles).toEqual(['src/shop/cart.ts']);

    const green = await runChangeGreen(await loadConfig(repo.dir), { id });
    expect(green.exitCode, green.messages.join('\n')).toBe(0);
    s = await statusOf(repo, id);
    expect(s.done).toEqual(['spec', 'tests', 'red', 'code', 'green']);
    expect([s.stage, ...codes(s)]).toEqual(['validated', 'NOT_VALIDATED']);
    expect(s.next).toBe('git push (CI validates the change)');

    // a later code edit makes the green run stale
    writeShopCode(repo);
    repo.write('src/shop/cart.ts', `${read(repo, 'src/shop/cart.ts')}export const extra = 1;\n`);
    s = await statusOf(repo, id);
    expect([s.stage, ...codes(s)]).toEqual(['green', 'GREEN_STALE']);
  }, 60_000);

  // [claims: capabilities/spec-first-changes#change-stages-detected-live]
  it('sends the change back when a locked test is edited after red, until red is recorded again against base code', async () => {
    const repo = changeRepo();
    const id = await begin(repo);
    addFreeShippingClaim(repo);
    await approveShop(repo);
    writeShopTests(repo);
    gitCommit(repo.dir, 'spec, approval and tests');
    expect((await runChangeRed(await loadConfig(repo.dir), { id })).exitCode).toBe(0);
    writeShopCode(repo);
    expect((await statusOf(repo, id)).stage).toBe('green');

    repo.write('tests/shop.test.ts', shopTestSource('// loosened later'));
    const s = await statusOf(repo, id);
    expect(s.stage).toBe('tests');
    expect(codes(s)).toEqual(['RED_INVALID_TESTS_EDITED']);
    expect(s.red).toBe('invalid');
    expect(s.lockedTests).toEqual([]);

    // the spec edit locks as well
    repo.write('tests/shop.test.ts', shopTestSource());
    repo.write('specs/capabilities/shop.md', read(repo, 'specs/capabilities/shop.md').replace('ship free', 'ship free of charge'));
    expect(codes(await statusOf(repo, id))).toEqual(expect.arrayContaining(['RED_INVALID_SPEC_EDITED']));
    repo.write('specs/capabilities/shop.md', read(repo, 'specs/capabilities/shop.md').replace('ship free of charge', 'ship free'));
    repo.write('tests/shop.test.ts', shopTestSource('// loosened later'));

    // red again: the code differs from base, so it runs in a constructed tree and the user's tree is untouched
    const again = await runChangeRed(await loadConfig(repo.dir), { id });
    expect(again.exitCode, again.messages.join('\n')).toBe(0);
    expect(again.messages.join('\n')).toContain('constructed tree');
    expect(read(repo, 'src/shop/cart.ts')).toContain('FREE_SHIPPING');
    const s2 = await statusOf(repo, id);
    expect([s2.stage, ...codes(s2)]).toEqual(['green', 'GREEN_MISSING']);
    expect(s2.red).toBe('valid');
  }, 60_000);

  // [claims: capabilities/spec-first-changes#change-record-not-evidence]
  it('is not moved by editing the record, and reads red from the run record content', async () => {
    const repo = changeRepo();
    const id = await begin(repo);
    addFreeShippingClaim(repo);
    await approveShop(repo);
    writeShopTests(repo);

    // a record that claims a later stage changes nothing
    const record = JSON.parse(read(repo, `${CHANGES_DIR}/${id}.json`));
    writeFileSync(recordFile(repo, id), JSON.stringify({ ...record, stage: 'green', red: 'valid', runs: { red: 'x' } }));
    expect((await statusOf(repo, id)).stage).toBe('red');

    expect((await runChangeRed(await loadConfig(repo.dir), { id })).exitCode).toBe(0);
    expect((await statusOf(repo, id)).red).toBe('valid');
    // rewriting a verdict in the run record to pass is what the stage reads, so red no longer holds
    const runFile = path.join(repo.dir, '.specguard', 'runs', `${id}-red.json`);
    const run = JSON.parse(readFileSync(runFile, 'utf8'));
    run.tests = run.tests.map((t: { verdict: string }) => ({ ...t, verdict: 'pass' }));
    writeFileSync(runFile, JSON.stringify(run));
    const s = await statusOf(repo, id);
    expect(s.red).toBe('invalid');
    expect(codes(s)).toContain('RED_NOT_RED');
    // and deleting it leaves no red at all
    writeFileSync(runFile, 'not json');
    expect(codes(await statusOf(repo, id))).toEqual(['RED_MISSING']);
  }, 60_000);

  // [claims: capabilities/spec-first-changes#change-stages-detected-live]
  it('counts a refactor as spec-free: it needs code and a green run of the capability claim tests, and refuses a changed requirement', async () => {
    const repo = changeRepo();
    const id = await begin(repo, { capabilities: ['auth'], kind: 'refactor', why: 'tidy login' });
    let s = await statusOf(repo, id);
    expect([s.kind, s.stage, ...codes(s)]).toEqual(['refactor', 'code', 'NO_CODE_CHANGE']);

    repo.write('src/auth/login.ts', 'export const login = 2;\n');
    s = await statusOf(repo, id);
    expect([s.stage, ...codes(s)]).toEqual(['green', 'GREEN_MISSING']);
    expect((await runChangeRed(await loadConfig(repo.dir), { id })).messages.join('\n')).toContain('is a refactor');
    const green = await runChangeGreen(await loadConfig(repo.dir), { id });
    expect(green.exitCode, green.messages.join('\n')).toBe(0);
    s = await statusOf(repo, id);
    expect(s.done).toEqual(['spec', 'tests', 'red', 'code', 'green']);

    repo.write('specs/capabilities/auth.md', read(repo, 'specs/capabilities/auth.md').replace('Logout clears the session', 'Logout clears every session'));
    s = await statusOf(repo, id);
    expect([s.stage, ...codes(s)]).toEqual(['spec', 'REFACTOR_CHANGES_INTENT']);
  }, 60_000);
});

describe('spikes and closing [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#change-spike-convert]
  it('lets a spike write code first, never validates it, and converts only with changed requirements and tests', async () => {
    const repo = changeRepo();
    const id = await begin(repo, { kind: 'spike', why: 'try shipping' });
    writeShopCode(repo);
    let s = await statusOf(repo, id);
    expect([s.kind, s.stage, ...codes(s)]).toEqual(['spike', 'spec', 'NO_INTENT_CHANGE']);
    expect(s.codeFiles).toEqual(['src/shop/cart.ts']);
    expect(s.blocks[0]!.message).toContain('state what should change first');

    const config = await loadConfig(repo.dir);
    expect((await runChangeConvert(config, { id })).messages.join('\n')).toContain('no changed requirement');
    addFreeShippingClaim(repo);
    expect((await runChangeConvert(config, { id })).messages.join('\n')).toContain(`no test is tagged to ${FREE_SHIPPING}`);

    await approveShop(repo);
    writeShopTests(repo);
    gitCommit(repo.dir, 'spike work');
    expect((await runChangeRed(await loadConfig(repo.dir), { id })).exitCode).toBe(0);
    expect((await runChangeGreen(await loadConfig(repo.dir), { id })).exitCode).toBe(0);
    s = await statusOf(repo, id);
    expect([s.stage, ...codes(s)]).toEqual(['validated', 'SPIKE_CANNOT_VALIDATE']);
    expect(s.next).toBe(`specguard change convert ${id} --to feature`);

    const converted = await runChangeConvert(await loadConfig(repo.dir), { id });
    expect(converted.exitCode, converted.messages.join('\n')).toBe(0);
    const record = JSON.parse(read(repo, `${CHANGES_DIR}/${id}.json`));
    expect(record).toMatchObject({ kind: 'feature', convertedFrom: { kind: 'spike' } });
    expect((await runChangeConvert(await loadConfig(repo.dir), { id })).messages.join('\n')).toContain('is a feature, not a spike');
  }, 60_000);

  // [claims: capabilities/spec-first-changes#change-close-rules]
  it('abandons with a reason, and a closed record is never edited by any change command', async () => {
    const repo = changeRepo();
    const id = await begin(repo);
    const config = await loadConfig(repo.dir);
    expect((await runChangeAbandon(config, { id })).messages.join('\n')).toContain('needs --why');
    expect(existsSync(recordFile(repo, id)) && JSON.parse(read(repo, `${CHANGES_DIR}/${id}.json`)).closed).toBeUndefined();

    const done = await runChangeAbandon(config, { id, why: 'wrong approach', now: NOW });
    expect(done.exitCode).toBe(0);
    const closedBytes = read(repo, `${CHANGES_DIR}/${id}.json`);
    expect(JSON.parse(closedBytes).closed).toMatchObject({ reason: 'abandoned', note: 'wrong approach', at: NOW.toISOString() });

    for (const r of [
      await runChangeAbandon(config, { id, why: 'again' }),
      await runChangeDone(config, { id, force: true, why: 'x' }),
      await runChangeConvert(config, { id }),
      await runChangeRed(config, { id }),
      await runChangeGreen(config, { id }),
    ]) {
      expect(r.exitCode).toBe(1);
      expect(r.messages.join('\n')).toContain('is closed');
    }
    expect(read(repo, `${CHANGES_DIR}/${id}.json`)).toBe(closedBytes);

    const status = await statusOf(repo, id);
    expect(status.closed?.reason).toBe('abandoned');
    expect(status.next).toBe('nothing: the change is closed');
    // an abandoned change is not open: no id means no change on this branch
    expect((await runChangeStatus(config, {})).messages.join('\n')).toContain('no open change on this branch');
    expect((await runChangeList(config, { all: true })).messages.join('\n')).toContain('closed (abandoned)');
    expect((await runChangeList(config, {})).messages.join('\n')).toContain('no open change');
  });

  // [claims: capabilities/spec-first-changes#change-close-rules]
  it('closes as done only when validated, or forced with a reason that is recorded', async () => {
    const repo = changeRepo();
    const id = await begin(repo);
    const config = await loadConfig(repo.dir);
    const refused = await runChangeDone(config, { id });
    expect(refused.exitCode).toBe(2);
    expect(refused.messages.join('\n')).toContain('is at spec, not validated');
    expect((await runChangeDone(config, { id, force: true })).messages.join('\n')).toContain('--force needs --why');

    const forced = await runChangeDone(config, { id, force: true, why: 'shipped by hand', now: NOW });
    expect(forced.exitCode, forced.messages.join('\n')).toBe(0);
    expect(JSON.parse(read(repo, `${CHANGES_DIR}/${id}.json`)).closed).toMatchObject({ reason: 'done', note: 'forced at spec: shipped by hand' });
  });
});

describe('parallel changes and plans [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#change-parallel-shared]
  it('warns about a second change on one capability and judges both on the same changed claims', async () => {
    const repo = changeRepo();
    const first = await begin(repo);
    const second = await start(repo, { random: () => 'c3d4', why: 'shipping tests' });
    expect(second.messages.join('\n')).toContain(`[warn] change ${first} is open on this branch for shop`);
    const secondId = second.items[0]!.key;
    expect(secondId).not.toBe(first);

    addFreeShippingClaim(repo);
    const got = await changeStatuses(await loadConfig(repo.dir), {});
    expect(got.ok && got.changes.map((c) => c.id)).toEqual([first, secondId].sort());
    for (const c of got.ok ? got.changes : []) expect(c.changed.map((x) => x.ref)).toEqual([FREE_SHIPPING]);

    // acting on one needs a name; each is judged by its own run records
    const config = await loadConfig(repo.dir);
    expect((await runChangeRed(config, {})).messages.join('\n')).toContain('2 changes are open on this branch');
    await approveShop(repo);
    writeShopTests(repo);
    expect((await runChangeRed(await loadConfig(repo.dir), { id: first })).exitCode).toBe(0);
    expect((await statusOf(repo, first)).red).toBe('valid');
    expect((await statusOf(repo, secondId)).red).toBe('none');
    expect((await runChangeList(config, {})).messages.filter((l) => l.startsWith('2026'))).toHaveLength(2);
  }, 60_000);

  // [claims: capabilities/spec-first-changes#change-plan-link]
  it('links a captured plan to the open change, and the plan stands in for the approval of its changed requirements', async () => {
    const repo = changeRepo();
    const id = await begin(repo);
    const config = await loadConfig(repo.dir);
    const entry = await capturePlan(config, JSON.stringify({ session_id: 's1', tool_name: 'ExitPlanMode', tool_input: { plan: '# Free shipping\n\n1. waive the fee over fifty' } }));
    expect(entry).toBeDefined();
    expect(JSON.parse(read(repo, `${CHANGES_DIR}/${id}.json`)).plans).toEqual([entry]);
    // a second capture adds a second plan; the same plan is never listed twice
    await capturePlan(config, JSON.stringify({ session_id: 's1', tool_name: 'ExitPlanMode', tool_input: { plan: '# Free shipping, again\n\n1. test it' } }));
    expect(JSON.parse(read(repo, `${CHANGES_DIR}/${id}.json`)).plans).toHaveLength(2);

    addFreeShippingClaim(repo);
    const s = await statusOf(repo, id);
    expect(codes(s)).toEqual(['TESTS_MISSING']);
    expect(s.stage).toBe('tests');
  });

  // [claims: capabilities/spec-first-changes#change-plan-link]
  it('does not link a plan to a closed change or one on another branch', async () => {
    const repo = changeRepo();
    const closed = await begin(repo);
    await runChangeAbandon(await loadConfig(repo.dir), { id: closed, why: 'no' });
    const other = await begin(repo, { random: () => 'e5f6', why: 'other branch work' });
    const file = recordFile(repo, other);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), branch: 'some-other-branch' }));
    await capturePlan(await loadConfig(repo.dir), JSON.stringify({ session_id: 's2', tool_name: 'ExitPlanMode', tool_input: { plan: '# Unrelated\n\n1. x' } }));
    expect(JSON.parse(read(repo, `${CHANGES_DIR}/${closed}.json`)).plans).toEqual([]);
    expect(JSON.parse(read(repo, `${CHANGES_DIR}/${other}.json`)).plans).toEqual([]);
  });
});

describe('change report [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#change-report-local]
  it('builds a provisional proof packet of the requirements that changed and how far the proof got', async () => {
    const repo = changeRepo();
    const id = await begin(repo);
    addFreeShippingClaim(repo);
    await approveShop(repo);
    writeShopTests(repo);
    expect((await runChangeRed(await loadConfig(repo.dir), { id })).exitCode).toBe(0);
    writeShopCode(repo);
    expect((await runChangeGreen(await loadConfig(repo.dir), { id })).exitCode).toBe(0);

    const built = await buildChangePacket(await loadConfig(repo.dir), { id, generated: NOW.toISOString() });
    expect(built.ok, built.ok ? '' : built.error).toBe(true);
    if (!built.ok) return;
    const { packet, markdown } = built;
    expect(markdown.split('\n')[0]).toBe('<!-- specguard-proof-packet v1 -->');
    expect(packet.provisional).toBe(true);
    expect(packet.headline).toContain('(local, provisional)');
    expect(packet.intent.map((i) => [i.ref, i.change])).toEqual([[FREE_SHIPPING, 'added']]);
    expect(packet.intent[0]!.summary).toContain('Orders over fifty dollars ship free');
    expect(packet.intent[0]!.approval).toMatchObject({ method: 'command', by: 'Ada', trust: 'recorded' });
    expect(packet.changes).toEqual([expect.objectContaining({ id, kind: 'feature', capabilities: ['shop'], verdict: 'pass', claims: [FREE_SHIPPING] })]);
    expect(packet.evidence.find((e) => e.ref === FREE_SHIPPING)?.sensitivity).toMatchObject({ kind: 'red-green', status: 'ok', redTests: 1 });
    expect(packet.weakening).toEqual([]);
    // no coverage was ingested: the packet says so instead of listing every line
    expect(packet.unrequested.lines).toEqual([]);
    expect(packet.limits.join('\n')).toContain('provisional');
    expect(markdown).toContain(FREE_SHIPPING);
    expect(markdown).not.toContain(CART_TOTALS);
  }, 120_000);

  // [claims: capabilities/spec-first-changes#change-report-local]
  it('names code changed under no change record and a weakened test', async () => {
    const repo = changeRepo();
    const id = await begin(repo, { capabilities: ['auth'], kind: 'refactor', why: 'auth only' });
    repo.write('src/shop/cart.ts', 'export const cart = 2;\n');
    repo.write('tests/auth.test.ts', `${commentTag('capabilities/auth#login-valid-code')}\nit.skip('logs in', () => {});\n`);
    const built = await buildChangePacket(await loadConfig(repo.dir), { id });
    expect(built.ok, built.ok ? '' : built.error).toBe(true);
    if (!built.ok) return;
    expect(built.packet.unrequested.withoutChange).toEqual([{ file: 'src/shop/cart.ts', capabilities: ['shop'] }]);
    expect(built.packet.weakening.length).toBeGreaterThan(0);
  }, 120_000);
});
