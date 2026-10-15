import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { runTestRun } from '../../src/pipelines/test-run.js';
import { makeRepo, type TmpRepo } from '../helpers/repo.js';

/** A repo whose configured test command is a script that writes a JUnit report. */
function repoWith(report: string | null, exit = 0, extraApp: Record<string, unknown> = {}): TmpRepo {
  const repo = makeRepo({
    apps: [
      {
        name: 'app',
        repo: '.',
        specDir: 'specs',
        sources: { routes: ['src/**/*.ts'], tests: ['tests/**/*.test.ts'] },
        framework: 'junit',
        testOutput: 'tests/',
        test: { command: 'node run-tests.cjs', resultsFile: 'report.xml', reporter: 'junit' },
        ...extraApp,
      },
    ],
  });
  repo.write(
    'run-tests.cjs',
    `${report === null ? '' : `require('fs').writeFileSync('report.xml', ${JSON.stringify(report)});`}\nprocess.exit(${exit});\n`,
  );
  return repo;
}

const ledger = (repo: TmpRepo) => JSON.parse(readFileSync(path.join(repo.dir, '.specguard/proofs.json'), 'utf8')).proofs as Record<string, { verdict: string; runId: string }>;

const PASS = '<testsuite name="s"><testcase classname="c" name="awards once @claim:core/awards#award-once"/></testsuite>';
const FAIL =
  '<testsuite name="s"><testcase classname="c" name="awards once @claim:core/awards#award-once"/>' +
  '<testcase classname="c" name="no dupes @claim:core/awards#no-dupes"><failure message="duplicate accepted"/></testcase></testsuite>';

describe('test run [test-run]', () => {
  // [claims: capabilities/conformance-testing#test-run-ingests]
  it('runs the configured command and ingests the report in one step [run-and-ingest]', async () => {
    const repo = repoWith(PASS);
    const r = await runTestRun(await loadConfig(repo.dir), { runId: 'run-1' });
    expect(r.exitCode).toBe(0);
    expect(r.messages.join('\n')).toContain('[run] app: node run-tests.cjs');
    expect(ledger(repo)['core/awards#award-once']).toMatchObject({ verdict: 'proven', runId: 'run-1' });
  });

  // [claims: capabilities/conformance-testing#test-run-fails-honestly]
  it('records a failing claim and exits 2 [failing-claim]', async () => {
    const repo = repoWith(FAIL, 1);
    const r = await runTestRun(await loadConfig(repo.dir), {});
    expect(r.exitCode).toBe(2);
    expect(ledger(repo)['core/awards#no-dupes'].verdict).toBe('failed');
    expect(ledger(repo)['core/awards#award-once'].verdict).toBe('proven');
  });

  // [claims: capabilities/conformance-testing#test-run-fails-honestly]
  it('fails the run when the suite fails even though no failing test carries a claim tag [untagged-failure]', async () => {
    const repo = repoWith('<testsuite name="s"><testcase classname="c" name="untagged"><failure message="x"/></testcase></testsuite>', 1);
    const r = await runTestRun(await loadConfig(repo.dir), {});
    expect(r.exitCode).toBe(2);
  });

  // [claims: capabilities/conformance-testing#test-run-fails-honestly]
  it('fails clearly when the runner produced no report [no-report]', async () => {
    const repo = repoWith(null, 0);
    const r = await runTestRun(await loadConfig(repo.dir), {});
    expect(r.exitCode).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.messages.join('\n')).toContain('[fail] app:');
  });

  it('skips an app whose framework has no runner and rejects an unknown app name [skip-and-unknown]', async () => {
    const repo = repoWith(PASS, 0, { framework: 'mystery', test: { command: 'node run-tests.cjs', resultsFile: 'report.xml' } });
    const skipped = await runTestRun(await loadConfig(repo.dir), {});
    expect(skipped.skipped).toBe(1);
    expect(skipped.messages.join('\n')).toContain('no test runner for framework "mystery"');
    const unknown = await runTestRun(await loadConfig(repo.dir), { app: 'nope' });
    expect(unknown.exitCode).toBe(1);
  });
});
