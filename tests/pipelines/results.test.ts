import { describe, it, expect } from 'vitest';
import { copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { runResultsIngest } from '../../src/pipelines/results.js';
import { makeRepo } from '../helpers/repo.js';
import { SHOP_SPEC_WITH_ROWS, makeV2Repo } from '../helpers/v2-repo.js';

const fx = (name: string) => path.join(__dirname, '..', 'fixtures', 'results', name);

function ledger(dir: string, rel = '.specguard/proofs.json') {
  return JSON.parse(readFileSync(path.join(dir, rel), 'utf8')).proofs as Record<string, Record<string, unknown>>;
}

describe('results ingest', () => {
  // [claims: capabilities/conformance-testing#results-ingest]
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

  // [claims: capabilities/conformance-testing#results-ingest]
  it('merges several files so one claim is exercised from two suites', async () => {
    const repo = makeRepo();
    repo.write('a.xml', `<testsuites><testsuite name="s"><testcase classname="c" name="t1 @claim:core/awards#award-once" time="0.1"/></testsuite></testsuites>`);
    repo.write('b.xml', `<testsuites><testsuite name="s"><testcase classname="c" name="t2 @claim:core/awards#award-once" time="0.1"/></testsuite></testsuites>`);
    const r = await runResultsIngest(['*.xml'], repo.dir, { format: 'junit' });
    expect(r.exitCode).toBe(0);
    expect(ledger(repo.dir)['core/awards#award-once']).toMatchObject({ verdict: 'proven', exercised: 2 });
  });

  // [claims: capabilities/conformance-testing#partial-and-sweep]
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

  // [claims: capabilities/conformance-testing#results-ingest]
  it('exits 2 and writes nothing for unparseable input; explicit format overrides detection', async () => {
    const repo = makeRepo();
    repo.write('bad.json', '{"nothing":true}');
    const r = await runResultsIngest(['bad.json'], repo.dir);
    expect(r.exitCode).toBe(2);
    const forced = await runResultsIngest(['bad.json'], repo.dir, { format: 'pytest' });
    expect(forced.exitCode).toBe(2);
    expect(forced.messages.join(' ')).toContain('pytest');
  });

  // [claims: capabilities/conformance-testing#shared-ingest-and-ledger-path]
  it('writes to an alternate ledger', async () => {
    const repo = makeRepo();
    repo.write('a.xml', `<testsuite name="s"><testcase classname="c" name="t1 @claim:core/awards#award-once"/></testsuite>`);
    await runResultsIngest(['a.xml'], repo.dir, { ledger: 'out/ledger.json' });
    expect(ledger(repo.dir, 'out/ledger.json')['core/awards#award-once']).toBeDefined();
  });
});

describe('results ingest sweep semantics', () => {
  const tag = (id: string) => `<testsuite name="s"><testcase classname="c" name="t @claim:core/awards#${id}"/></testsuite>`;

  function twoApps() {
    const repo = makeRepo({
      apps: [
        { name: 'one', repo: '.', specDir: 'specs/core', sources: { routes: ['src/**/*.ts'] }, framework: 'vitest', testOutput: 'tests/' },
        { name: 'two', repo: '.', specDir: 'specs/other', sources: { routes: ['lib/**/*.ts'] }, framework: 'vitest', testOutput: 'tests/' },
      ],
    });
    repo.write('specs/other/thing.md', '# Thing\n\n<!-- module: lib/thing.ts / type: core / status: draft -->\n\n## Acceptance Criteria\n\n- [ ] Works <!-- claim: works -->\n');
    repo.write('lib/thing.ts', 'export const t = 1;\n');
    return repo;
  }

  // [claims: capabilities/conformance-testing#partial-and-sweep]
  it('a partial ingest only updates claims present; --unexercised is ignored with a warning [partial-ingest]', async () => {
    const repo = twoApps();
    repo.write('a.xml', tag('award-once'));
    await runResultsIngest(['a.xml'], repo.dir);
    const r = await runResultsIngest(['a.xml'], repo.dir, { unexercised: true });
    expect(r.messages.join('\n')).toContain('partial ingest');
    expect(Object.keys(ledger(repo.dir))).toEqual(['core/awards#award-once']);
  });

  // [claims: capabilities/conformance-testing#partial-and-sweep]
  it('--full-run lets the sweep apply (alias --sweep) but keeps proven claims with matching hashes [sweep-keeps-proven]', async () => {
    const repo = twoApps();
    repo.write('both.xml', `<testsuite name="s"><testcase classname="c" name="t @claim:core/awards#award-once"/><testcase classname="c" name="u @claim:core/awards#no-dupes"/></testsuite>`);
    await runResultsIngest(['both.xml'], repo.dir);
    repo.write('a.xml', tag('award-once'));
    const r = await runResultsIngest(['a.xml'], repo.dir, { sweep: true, fullRun: true });
    const proofs = ledger(repo.dir);
    expect(proofs['core/awards#no-dupes']).toMatchObject({ verdict: 'proven' });
    expect(proofs['core/awards#untested']).toMatchObject({ verdict: 'unexercised' });
    expect(proofs['other/thing#works']).toMatchObject({ verdict: 'unexercised' });
    expect(r.messages.join('\n')).toContain('sweep kept 1 proven');
  });

  // [claims: capabilities/conformance-testing#partial-and-sweep]
  it('a sweep covering every app applies without --full-run [unexercised-flag]', async () => {
    const repo = twoApps();
    repo.write('both.xml', `<testsuite name="s"><testcase classname="c" name="t @claim:core/awards#award-once"/><testcase classname="c" name="u @claim:other/thing#works"/></testsuite>`);
    await runResultsIngest(['both.xml'], repo.dir, { unexercised: true });
    expect(ledger(repo.dir)['core/awards#no-dupes']).toMatchObject({ verdict: 'unexercised' });
  });
});

describe('results ingest with tags written in source comments [results-source-tags]', () => {
  it('proves a claim from a test whose tag is a comment above it, not in its title [comment-tag-proves]', async () => {
    const repo = makeRepo();
    const testFile = repo.write('tests/awards.test.ts', "// [claims: core/awards#award-once]\nit('awards once', () => {});\nit('untagged test', () => {});\n");
    repo.write(
      'report.json',
      JSON.stringify({
        testResults: [
          {
            name: testFile,
            assertionResults: [
              { title: 'awards once', status: 'passed', ancestorTitles: [], fullName: 'awards once', duration: 1 },
              { title: 'untagged test', status: 'failed', ancestorTitles: [], fullName: 'untagged test', duration: 1, failureMessages: ['x'] },
            ],
          },
        ],
      }),
    );
    const r = await runResultsIngest(['report.json'], repo.dir, { format: 'vitest' });
    expect(r.exitCode).toBe(0);
    const proofs = ledger(repo.dir);
    expect(proofs['core/awards#award-once']).toMatchObject({ verdict: 'proven', exercised: 1 });
    // The failing untagged test proves nothing and fails nothing.
    expect(Object.keys(proofs)).toEqual(['core/awards#award-once']);
  });

  it('a failing tagged test fails its claim [comment-tag-fails]', async () => {
    const repo = makeRepo();
    const testFile = repo.write('tests/awards.test.ts', "// [claims: core/awards#no-dupes]\nit('rejects duplicates', () => {});\n");
    repo.write(
      'report.json',
      JSON.stringify({ testResults: [{ name: testFile, assertionResults: [{ title: 'rejects duplicates', status: 'failed', fullName: 'rejects duplicates', failureMessages: ['boom'] }] }] }),
    );
    const r = await runResultsIngest(['report.json'], repo.dir, { format: 'vitest' });
    expect(r.exitCode).toBe(2);
    expect(ledger(repo.dir)['core/awards#no-dupes']).toMatchObject({ verdict: 'failed', counterexamples: 1 });
  });
});

describe('example rows in results ingest [row-aggregation]', () => {
  const CART = 'capabilities/shop#cart-totals';
  const junit = (...names: string[]): string => `<testsuite name="s">${names.map((n) => `<testcase classname="c" name="${n}"/>`).join('')}</testsuite>`;

  // [claims: capabilities/conformance-testing#row-aggregation]
  it('attributes a parameterized test to the one row its title names, and counts it once for the claim', async () => {
    const repo = makeV2Repo();
    repo.write('specs/capabilities/shop.md', SHOP_SPEC_WITH_ROWS);
    repo.write('r.xml', junit(`fee for ny-small @claim:${CART}`, `other total @claim:${CART}`));
    const r = await runResultsIngest(['r.xml'], repo.dir, { format: 'junit' });
    expect(r.exitCode).toBe(0);
    const proofs = ledger(repo.dir);
    expect(proofs[`${CART}/ny-small`]).toMatchObject({ verdict: 'proven', exercised: 1 });
    expect(proofs[`${CART}/ny-free`]).toBeUndefined();
    expect(proofs[CART]).toMatchObject({ verdict: 'proven', exercised: 2 });
    expect(r.messages.join('\n')).not.toContain('EXAMPLE_TITLE_AMBIGUOUS');
  });

  // [claims: capabilities/conformance-testing#example-title-ambiguity-warning]
  it('warns EXAMPLE_TITLE_AMBIGUOUS and attributes to no row when a title names two rows, without failing', async () => {
    const repo = makeV2Repo();
    repo.write('specs/capabilities/shop.md', SHOP_SPEC_WITH_ROWS);
    repo.write('r.xml', junit(`ny-small and ny-free together @claim:${CART}`));
    const r = await runResultsIngest(['r.xml'], repo.dir, { format: 'junit' });
    expect(r.exitCode).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.messages.join('\n')).toContain('EXAMPLE_TITLE_AMBIGUOUS');
    expect(Object.keys(ledger(repo.dir))).toEqual([CART]);
  });

  // [claims: capabilities/conformance-testing#row-aggregation]
  it('records a row named in the tag itself, and fails one that is not in the table', async () => {
    const repo = makeV2Repo();
    repo.write('specs/capabilities/shop.md', SHOP_SPEC_WITH_ROWS);
    repo.write('r.xml', junit(`free shipping @claim:${CART}/ny-free`, `ghost @claim:${CART}/ghost`));
    const r = await runResultsIngest(['r.xml'], repo.dir, { format: 'junit' });
    const proofs = ledger(repo.dir);
    expect(proofs[`${CART}/ny-free`]).toMatchObject({ verdict: 'proven' });
    expect(proofs[CART]).toMatchObject({ verdict: 'proven', exercised: 2 });
    expect(proofs[`${CART}/ghost`]).toBeUndefined();
    expect(r.failed).toBe(1);
  });
});
