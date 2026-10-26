import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { claimHashOf } from '../../src/core/claim-hash.js';
import { formatApproved } from '../../src/core/approvals.js';
import { loadConfig } from '../../src/core/config.js';
import { renderHistoryEntry } from '../../src/core/history.js';
import { parseSpecContent } from '../../src/core/spec-parser.js';
import { classify } from '../../src/hooks/decide.js';
import { matchGlob } from '../../src/hooks/entry.js';
import { buildHookIndex, HOOK_INDEX_FILE, indexFingerprint, liveRedValidity, loadHookIndex, readHookIndexCache } from '../../src/hooks/index-build.js';
import { CHANGE_ID, hookRepo, writeChange, writeRed } from '../helpers/hook-repo.js';

describe('the hook ownership index [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#hook-index-contents]
  it('lists owned files, capability globs, enforce levels, test globs and open changes with their locked tests', async () => {
    const repo = hookRepo({ shop: 'enforce', auth: 'warn' });
    writeChange(repo, 'feature');
    writeRed(repo, ['tests/shop.test.ts']);
    const index = await buildHookIndex(await loadConfig(repo.dir));

    expect(index.specsRoot).toBe('specs');
    expect(index.historyDir).toBe('specs/history');
    expect(index.owned['src/shop/cart.ts']).toEqual(['shop']);
    expect(index.owned['src/core/awards.ts']).toEqual(['shop']);
    expect(index.owned['src/auth/login.ts']).toEqual(['auth']);
    expect(index.owned['src/orphan.ts']).toBeUndefined();
    expect(index.capabilities.find((c) => c.id === 'shop')).toEqual({ id: 'shop', specFile: 'specs/capabilities/shop.md', enforce: 'enforce', sources: ['src/shop/**', 'src/core/awards.ts'] });
    expect(index.capabilities.find((c) => c.id === 'auth')?.enforce).toBe('warn');
    expect(index.testGlobs).toContain('tests/auth.test.ts');
    expect(index.openChanges).toHaveLength(1);
    expect(index.openChanges[0]).toMatchObject({ id: CHANGE_ID, kind: 'feature', capabilities: ['shop'], lockedTests: ['tests/shop.test.ts'], red: { valid: true } });
  });

  // [claims: capabilities/spec-first-changes#hook-index-contents]
  it('leaves a closed change out and turns a record that does not parse into a note, not an error', async () => {
    const repo = hookRepo({ shop: 'enforce' });
    const record = JSON.parse(readFileSync(writeChange(repo, 'feature'), 'utf8')) as Record<string, unknown>;
    writeFileSync(path.join(repo.dir, `.specguard/changes/${CHANGE_ID}.json`), JSON.stringify({ ...record, closed: { at: 'x', by: 'y', reason: 'done' } }));
    repo.write('.specguard/changes/20261025-broken-ffff.json', '{ nope');
    const index = await buildHookIndex(await loadConfig(repo.dir));
    expect(index.openChanges).toEqual([]);
    expect(index.notes?.join('\n')).toContain('20261025-broken-ffff.json');
  });

  // [claims: capabilities/spec-first-changes#hook-index-contents]
  it('judges approvals of a feature change against its base: unapproved, then approved at the current wording', async () => {
    const repo = hookRepo({ shop: 'enforce' });
    writeChange(repo, 'feature');
    const specFile = path.join(repo.dir, 'specs/capabilities/shop.md');
    writeFileSync(specFile, readFileSync(specFile, 'utf8').replace('## Scenarios', '- [ ] Free shipping over fifty <!-- claim: free-shipping -->\n\n## Scenarios'));

    const config = await loadConfig(repo.dir);
    expect((await buildHookIndex(config)).openChanges[0]?.approvedAll).toBe(false);

    const spec = parseSpecContent(readFileSync(specFile, 'utf8'), specFile, path.join(repo.dir, 'specs'));
    const hash = claimHashOf(spec, 'free-shipping')!;
    mkdirSync(path.join(repo.dir, 'specs/history'), { recursive: true });
    writeFileSync(
      path.join(repo.dir, 'specs/history/2026-10-25-approve.md'),
      renderHistoryEntry({ id: '2026-10-25-approve', date: '2026-10-25', kind: 'approval', author: 'Ada', affects: ['shop'], approves: [formatApproved('capabilities/shop#free-shipping', hash)], method: 'command' }, 'approved'),
    );
    expect((await buildHookIndex(config)).openChanges[0]?.approvedAll).toBe(true);
  });

  // [claims: capabilities/spec-first-changes#hook-index-cache]
  it('the fingerprint moves with a spec edit, a new change record and a red record, and not with a test or source edit', () => {
    const repo = hookRepo({ shop: 'enforce' });
    const base = indexFingerprint(repo.dir);
    expect(indexFingerprint(repo.dir)).toBe(base);

    repo.write('tests/shop.test.ts', '// edited\n');
    repo.write('src/shop/cart.ts', 'export const cart = 2;\n');
    repo.write('src/shop/new-file.ts', 'export const n = 1;\n');
    expect(indexFingerprint(repo.dir)).toBe(base);

    const specFile = path.join(repo.dir, 'specs/capabilities/shop.md');
    writeFileSync(specFile, `${readFileSync(specFile, 'utf8')}\nmore\n`);
    const afterSpec = indexFingerprint(repo.dir);
    expect(afterSpec).not.toBe(base);

    writeChange(repo, 'feature');
    const afterChange = indexFingerprint(repo.dir);
    expect(afterChange).not.toBe(afterSpec);

    writeRed(repo, ['tests/shop.test.ts']);
    expect(indexFingerprint(repo.dir)).not.toBe(afterChange);
  });

  // [claims: capabilities/spec-first-changes#hook-index-cache]
  it('caches the index, reuses it while the fingerprint holds, and rebuilds it when it does not', async () => {
    const repo = hookRepo({ shop: 'enforce' });
    const first = await loadHookIndex(repo.dir);
    expect(first).toMatchObject({ rebuilt: true, cached: true });
    expect(readHookIndexCache(repo.dir)?.fingerprint).toBe(first.index.fingerprint);
    expect(HOOK_INDEX_FILE).toBe('.specguard/cache/hook-index.json');

    expect((await loadHookIndex(repo.dir)).rebuilt).toBe(false);

    writeChange(repo, 'refactor');
    const third = await loadHookIndex(repo.dir);
    expect(third.rebuilt).toBe(true);
    expect(third.index.openChanges.map((c) => c.id)).toEqual([CHANGE_ID]);

    // A corrupt cache is a miss, not an error.
    writeFileSync(path.join(repo.dir, HOOK_INDEX_FILE), '{ truncated');
    expect((await loadHookIndex(repo.dir)).rebuilt).toBe(true);
  });

  // [claims: capabilities/spec-first-changes#hook-index-contents]
  it('classifies a new file that matches a capability glob as owned, and a test file as a test', async () => {
    const repo = hookRepo({ shop: 'enforce' });
    const { index } = await loadHookIndex(repo.dir);
    expect(classify('src/shop/brand-new.ts', index, matchGlob)).toEqual({ kind: 'owned', capabilities: ['shop'] });
    expect(classify('src/orphan.ts', index, matchGlob)).toEqual({ kind: 'other' });
    expect(classify('specs/capabilities/shop.md', index, matchGlob)).toEqual({ kind: 'spec', capability: 'shop' });
    expect(classify('tests/shop.test.ts', index, matchGlob).kind).toBe('test');
  });

  // [claims: capabilities/spec-first-changes#hook-live-red]
  it('re-hashes the locked tests on every call: an edit makes red invalid with no rebuild, restoring the file makes it valid again', async () => {
    const repo = hookRepo({ shop: 'enforce' });
    writeChange(repo, 'feature');
    writeRed(repo, ['tests/shop.test.ts']);
    const { index } = await loadHookIndex(repo.dir);
    expect(liveRedValidity(repo.dir, index).get(CHANGE_ID)).toBe(true);

    const file = path.join(repo.dir, 'tests/shop.test.ts');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, `${original}// edited\n`);
    expect(liveRedValidity(repo.dir, index).get(CHANGE_ID)).toBe(false);
    writeFileSync(file, original);
    expect(liveRedValidity(repo.dir, index).get(CHANGE_ID)).toBe(true);
  });

  // [claims: capabilities/spec-first-changes#hook-live-red]
  it('a red record that shows no failing test, or ran on code that was not at base, is never valid', async () => {
    const repo = hookRepo({ shop: 'enforce' });
    writeChange(repo, 'feature');
    writeRed(repo, ['tests/shop.test.ts']);
    const redFile = path.join(repo.dir, `.specguard/cache/changes/${CHANGE_ID}/red.json`);
    const record = JSON.parse(readFileSync(redFile, 'utf8')) as { tests: Array<{ status: string }>; ownedHash: string };

    writeFileSync(redFile, JSON.stringify({ ...record, tests: record.tests.map((t) => ({ ...t, status: 'pass' })) }));
    expect(liveRedValidity(repo.dir, (await loadHookIndex(repo.dir, { force: true })).index).get(CHANGE_ID)).toBe(false);

    writeFileSync(redFile, JSON.stringify({ ...record, ownedHash: 'different' }));
    expect(liveRedValidity(repo.dir, (await loadHookIndex(repo.dir, { force: true })).index).get(CHANGE_ID)).toBe(false);
  });
});
