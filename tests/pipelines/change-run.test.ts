import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CHANGES_DIR } from '../../src/core/change-record.js';
import { loadConfig } from '../../src/core/config.js';
import { changeStatuses, runChangeDone, runChangeStart } from '../../src/pipelines/change.js';
import { runChangeGreen, runChangeRed } from '../../src/pipelines/change-run.js';
import type { RunRecord } from '../../src/pipelines/test-run.js';
import {
  SHIPPING_TITLE,
  SHOP_CATALOG,
  addFreeShippingClaim,
  approveShop,
  changeRepo,
  gitCommit,
  read,
  setCatalog,
  writeShopCode,
  writeShopTests,
} from '../helpers/change-fixture.js';
import type { TmpRepo } from '../helpers/repo.js';

const NOW = new Date('2026-10-26T10:00:00.000Z');

async function begin(repo: TmpRepo): Promise<string> {
  const r = await runChangeStart(await loadConfig(repo.dir), { capabilities: ['shop'], why: 'free shipping', now: NOW, random: () => 'a1b2' });
  expect(r.exitCode).toBe(0);
  return r.items[0]!.key;
}

/** Spec edited, approved by a person, tests written: the change is ready for red. */
async function readyForRed(repo: TmpRepo): Promise<string> {
  const id = await begin(repo);
  addFreeShippingClaim(repo);
  await approveShop(repo);
  writeShopTests(repo);
  return id;
}

const run = async (repo: TmpRepo, kind: 'red' | 'green', id?: string) => (kind === 'red' ? runChangeRed : runChangeGreen)(await loadConfig(repo.dir), { id });
const stageOf = async (repo: TmpRepo, id: string) => {
  const got = await changeStatuses(await loadConfig(repo.dir), { id });
  if (!got.ok) throw new Error(got.error);
  return got.changes[0]!;
};
const runRecord = (repo: TmpRepo, id: string, kind: string): RunRecord => JSON.parse(read(repo, `.specguard/runs/${id}-${kind}.json`)) as RunRecord;
const git = (repo: TmpRepo, ...args: string[]): string => execFileSync('git', args, { cwd: repo.dir, encoding: 'utf8' });

describe('change red [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#change-red-run]
  it('runs exactly the tests of the changed requirements and records the run without touching the proof ledger', async () => {
    const repo = changeRepo();
    const id = await readyForRed(repo);
    const r = await run(repo, 'red');
    expect(r.exitCode, r.messages.join('\n')).toBe(0);
    expect(r.messages.join('\n')).toContain(`red recorded for ${id} (working-tree)`);

    const record = runRecord(repo, id, 'red');
    // the unrelated auth test did not run; the changed requirement's test failed on the old code
    expect(record.tests).toEqual([{ file: 'tests/shop.test.ts', title: SHIPPING_TITLE, refs: ['capabilities/shop#free-shipping'], verdict: 'fail' }]);
    expect(record.selection).toBe('tests');
    // failing verdicts against old code stay out of the ledger, and the pointer is only a pointer
    expect(existsSync(path.join(repo.dir, '.specguard', 'proofs.json'))).toBe(false);
    const pointer = JSON.parse(read(repo, `.specguard/cache/changes/${id}/red.json`));
    expect(pointer).toMatchObject({ kind: 'red', runRecord: `${id}-red`, mode: 'working-tree' });
    expect(Object.keys(pointer)).not.toContain('stage');
    // the committed record gained nothing
    expect(Object.keys(JSON.parse(read(repo, `${CHANGES_DIR}/${id}.json`)))).not.toContain('red');
  }, 60_000);

  // [claims: capabilities/spec-first-changes#change-red-run]
  it('is refused until the requirements are approved and tested, and records nothing', async () => {
    const repo = changeRepo();
    const id = await begin(repo);
    addFreeShippingClaim(repo);
    const early = await run(repo, 'red');
    expect(early.exitCode).toBe(2);
    expect(early.messages.join('\n')).toContain('not ready for red (stage spec)');
    await approveShop(repo);
    expect((await run(repo, 'red')).messages.join('\n')).toContain('not ready for red (stage tests)');
    expect(existsSync(path.join(repo.dir, '.specguard', 'runs', `${id}-red.json`))).toBe(false);
  }, 60_000);

  // [claims: capabilities/spec-first-changes#change-red-run]
  it('records a run in which the test already passes, says it is not red, and leaves the stage at red', async () => {
    const repo = changeRepo();
    const id = await readyForRed(repo);
    // a test that cannot fail: it passes without any new code
    setCatalog(repo, SHOP_CATALOG.map((c) => ({ file: c.file, title: c.title })));
    const r = await run(repo, 'red');
    expect(r.exitCode).toBe(2);
    expect(r.messages.join('\n')).toContain('[RED_NOT_RED]');
    const s = await stageOf(repo, id);
    expect([s.stage, s.red, s.blocks[0]!.code]).toEqual(['red', 'invalid', 'RED_NOT_RED']);
  }, 60_000);

  // [claims: capabilities/spec-first-changes#change-red-run]
  it('builds a constructed tree once code exists, runs against the base code, and cleans up leaving the working tree alone', async () => {
    const repo = changeRepo();
    const id = await readyForRed(repo);
    gitCommit(repo.dir, 'spec, approval and tests');
    writeShopCode(repo);
    const before = read(repo, 'src/shop/cart.ts');
    const r = await run(repo, 'red');
    expect(r.exitCode, r.messages.join('\n')).toBe(0);
    const text = r.messages.join('\n');
    expect(text).toContain(`red recorded for ${id} (constructed)`);
    expect(runRecord(repo, id, 'red').tests[0]!.verdict).toBe('fail');
    // the user's working tree is as it was, and the temporary worktree is gone
    expect(read(repo, 'src/shop/cart.ts')).toBe(before);
    expect(git(repo, 'status', '--porcelain', '--', 'src')).toContain('src/shop/cart.ts');
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    const tree = text.match(/constructed tree: .*\((.+?)\)/)?.[1];
    expect(tree && existsSync(tree)).toBe(false);
    expect(JSON.parse(read(repo, `.specguard/cache/changes/${id}/red.json`)).mode).toBe('constructed');
    expect((await stageOf(repo, id)).stage).toBe('green');
  }, 60_000);
});

describe('change green [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#change-green-run]
  it('is refused until red is valid and code exists, then records a passing run and validates only through CI', async () => {
    const repo = changeRepo();
    const id = await readyForRed(repo);
    expect((await run(repo, 'green')).messages.join('\n')).toContain('not ready for green (stage red)');
    expect((await run(repo, 'red')).exitCode).toBe(0);
    expect((await run(repo, 'green')).messages.join('\n')).toContain('not ready for green (stage code)');

    writeShopCode(repo);
    const green = await run(repo, 'green');
    expect(green.exitCode, green.messages.join('\n')).toBe(0);
    expect(runRecord(repo, id, 'green').tests).toEqual([expect.objectContaining({ title: SHIPPING_TITLE, verdict: 'pass' })]);
    // passing verdicts are real proof, so the green run is ingested
    expect(existsSync(path.join(repo.dir, '.specguard', 'proofs.json'))).toBe(true);

    const config = await loadConfig(repo.dir);
    const s = await stageOf(repo, id);
    expect(s.stage).toBe('validated');
    expect(s.blocks.map((b) => b.code)).toEqual(['NOT_VALIDATED']);
    // CI's word (injected here) is what lets the change close without --force
    const ci = { commit: 'a'.repeat(40), verdict: 'pass' as const };
    expect((await changeStatuses(config, { id, ci })).ok).toBe(true);
    const done = await runChangeDone(config, { id, ci, now: NOW });
    expect(done.exitCode, done.messages.join('\n')).toBe(0);
    expect(JSON.parse(readFileSync(path.join(repo.dir, CHANGES_DIR, `${id}.json`), 'utf8')).closed).toMatchObject({ reason: 'done', validatedAt: NOW.toISOString() });
  }, 60_000);

  // [claims: capabilities/spec-first-changes#change-green-run]
  it('records a failing green run as not green and keeps the stage at green', async () => {
    const repo = changeRepo();
    const id = await readyForRed(repo);
    expect((await run(repo, 'red')).exitCode).toBe(0);
    // code that does not satisfy the test: the marker is missing
    repo.write('src/shop/cart.ts', 'export const cart = 2;\n');
    const green = await run(repo, 'green');
    expect(green.exitCode).toBe(2);
    expect(green.messages.join('\n')).toContain('[GREEN_FAILING]');
    const s = await stageOf(repo, id);
    expect([s.stage, s.blocks[0]!.code]).toEqual(['green', 'GREEN_FAILING']);
    // fixing the code makes the recorded run stale until it is run again
    writeShopCode(repo);
    expect((await stageOf(repo, id)).blocks[0]!.code).toBe('GREEN_STALE');
    expect((await run(repo, 'green')).exitCode).toBe(0);
  }, 60_000);
});
