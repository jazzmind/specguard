import { describe, it, expect } from 'vitest';
import { copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { runResultsIngest } from '../../src/pipelines/results.js';
import { makeRepo } from '../helpers/repo.js';

const fx = (name: string) => path.join(__dirname, '..', 'fixtures', 'results', name);

function ledger(dir: string, rel = '.specguard/proofs.json') {
  return JSON.parse(readFileSync(path.join(dir, rel), 'utf8')).proofs as Record<string, Record<string, unknown>>;
}

describe('results ingest', () => {
  it('writes aggregated verdicts with a relative evidence path', async () => {
    const repo = makeRepo();
    copyFileSync(fx('vitest.json'), path.join(repo.dir, 'report.json'));
    const r = await runResultsIngest(['report.json'], repo.dir, { runId: 'ci-1' });
    const proofs = ledger(repo.dir);
    expect(proofs['core/awards#award-once']).toMatchObject({ verdict: 'proven', exercised: 2, runId: 'ci-1', evidencePath: 'report.json' });
    expect(proofs['core/awards#no-dupes']).toMatchObject({ verdict: 'failed', counterexamples: 1 });
    // deferred has no spec claim in this repo: reported failed and not stored
    expect(proofs['core/awards#deferred']).toBeUndefined();
    expect(r.exitCode).toBe(2);
    expect(r.messages.join('\n')).toContain('counterexamples for core/awards#no-dupes');
  });

  it('merges several files so one claim is exercised from two suites', async () => {
    const repo = makeRepo();
    repo.write('a.xml', `<testsuites><testsuite name="s"><testcase classname="c" name="t1 @claim:core/awards#award-once" time="0.1"/></testsuite></testsuites>`);
    repo.write('b.xml', `<testsuites><testsuite name="s"><testcase classname="c" name="t2 @claim:core/awards#award-once" time="0.1"/></testsuite></testsuites>`);
    const r = await runResultsIngest(['*.xml'], repo.dir, { format: 'junit' });
    expect(r.exitCode).toBe(0);
    expect(ledger(repo.dir)['core/awards#award-once']).toMatchObject({ verdict: 'proven', exercised: 2 });
  });

  it('stores unexercised for untagged spec claims only with --unexercised', async () => {
    const repo = makeRepo();
    repo.write('a.xml', `<testsuite name="s"><testcase classname="c" name="t1 @claim:core/awards#award-once"/></testsuite>`);
    await runResultsIngest(['a.xml'], repo.dir);
    expect(Object.keys(ledger(repo.dir))).toEqual(['core/awards#award-once']);
    await runResultsIngest(['a.xml'], repo.dir, { unexercised: true });
    const proofs = ledger(repo.dir);
    expect(proofs['core/awards#no-dupes']).toMatchObject({ verdict: 'unexercised', exercised: 0 });
    expect(proofs['core/awards#untested']).toMatchObject({ verdict: 'unexercised' });
  });

  it('exits 2 and writes nothing for unparseable input; explicit format overrides detection', async () => {
    const repo = makeRepo();
    repo.write('bad.json', '{"nothing":true}');
    const r = await runResultsIngest(['bad.json'], repo.dir);
    expect(r.exitCode).toBe(2);
    const forced = await runResultsIngest(['bad.json'], repo.dir, { format: 'pytest' });
    expect(forced.exitCode).toBe(2);
    expect(forced.messages.join(' ')).toContain('pytest');
  });

  it('writes to an alternate ledger', async () => {
    const repo = makeRepo();
    repo.write('a.xml', `<testsuite name="s"><testcase classname="c" name="t1 @claim:core/awards#award-once"/></testsuite>`);
    await runResultsIngest(['a.xml'], repo.dir, { ledger: 'out/ledger.json' });
    expect(ledger(repo.dir, 'out/ledger.json')['core/awards#award-once']).toBeDefined();
  });
});
