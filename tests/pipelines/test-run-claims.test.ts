import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { ownedTreeHash, runTestRun, type RunRecord } from '../../src/pipelines/test-run.js';
import { gitInit, makeV2Repo } from '../helpers/v2-repo.js';
import type { TmpRepo } from '../helpers/repo.js';

// Fixture tags are assembled here so this file holds no literal tag of its own.
const refTag = (ref: string): string => `@claim${':'}${ref}`;
const commentTag = (ref: string): string => `// [claims${':'} ${ref}]`;

/** A fake vitest: records its arguments, honours `-t` and file arguments, and writes a vitest JSON report. */
const RUNNER = `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.writeFileSync('argv.json', JSON.stringify(args));
const catalog = JSON.parse(fs.readFileSync('catalog.json', 'utf8'));
const t = args.indexOf('-t');
const re = t >= 0 ? new RegExp(args[t + 1]) : null;
const files = args.filter((a) => /\\.test\\.ts$/.test(a));
const chosen = catalog.filter((c) => (!re || re.test([...c.ancestors, c.title].join(' '))) && (files.length === 0 || files.includes(c.file)));
const byFile = {};
for (const c of chosen) (byFile[c.file] = byFile[c.file] || []).push({ title: c.title, ancestorTitles: c.ancestors, fullName: [...c.ancestors, c.title].join(' '), status: c.status });
const testResults = Object.entries(byFile).map(([file, assertionResults]) => ({ name: path.resolve(file), assertionResults }));
fs.writeFileSync('report.json', JSON.stringify({ testResults }));
process.exit(chosen.some((c) => c.status === 'failed') ? 1 : 0);
`;

const LOGIN = `logs in ${refTag('capabilities/auth#login-valid-code')}`;
const LOGOUT = 'logs out cleanly';
const OTHER = 'unrelated behaviour';
const TEMPLATED = 'interpolated ${1 + 1} title';

interface Row {
  title: string;
  status?: 'passed' | 'failed';
}

function repoWith(rows: Row[], coverage?: Record<string, unknown>): TmpRepo {
  const repo = makeV2Repo({
    apps: [
      {
        name: 'app',
        repo: '.',
        specDir: 'specs',
        sources: { routes: ['src/**/*.ts'], tests: ['tests/**/*.test.ts'] },
        framework: 'vitest',
        testOutput: 'tests/',
        test: { command: 'node run-tests.cjs', resultsFile: 'report.json', reporter: 'vitest', ...(coverage ? { coverage } : {}) },
      },
    ],
  });
  repo.write(
    'tests/auth.test.ts',
    [
      "describe('auth', () => {",
      `  it('${LOGIN}', () => {});`,
      `  ${commentTag('capabilities/auth#logout-clears-session')}`,
      `  it('${LOGOUT}', () => {});`,
      `  ${commentTag('capabilities/auth#login-valid-code')}`,
      `  it(\`${TEMPLATED} ${refTag('capabilities/auth#login-valid-code')}\`, () => {});`,
      `  it('${OTHER}', () => {});`,
      '});',
      '',
    ].join('\n'),
  );
  repo.write('run-tests.cjs', RUNNER);
  repo.write(
    'catalog.json',
    JSON.stringify(
      [...rows.map((r) => r.title), LOGIN, LOGOUT, OTHER]
        .filter((t, i, all) => all.indexOf(t) === i)
        .map((title) => ({ file: 'tests/auth.test.ts', ancestors: ['auth'], title, status: rows.find((r) => r.title === title)?.status ?? 'passed' })),
    ),
  );
  gitInit(repo.dir);
  return repo;
}

const argvOf = (repo: TmpRepo): string[] => JSON.parse(readFileSync(path.join(repo.dir, 'argv.json'), 'utf8')) as string[];
const recordOf = (repo: TmpRepo, id: string): RunRecord => JSON.parse(readFileSync(path.join(repo.dir, '.specguard', 'runs', `${id}.json`), 'utf8')) as RunRecord;
const run = async (repo: TmpRepo, opts: Parameters<typeof runTestRun>[1]) => runTestRun(await loadConfig(repo.dir), { ingest: false, ...opts });

describe('test run --claims [claims-selection]', () => {
  // [claims: capabilities/conformance-testing#claims-run-exact-tests]
  it('runs exactly the tests tagged to the claim, by title, and reports the selection', async () => {
    const repo = repoWith([]);
    const result = await run(repo, { claims: ['capabilities/auth#logout-clears-session'], record: 'one' });
    expect(result.exitCode).toBe(0);
    const args = argvOf(repo);
    expect(args).toContain('-t');
    expect(args).toContain('tests/auth.test.ts');
    expect(new RegExp(args[args.indexOf('-t') + 1]).test('auth logs out cleanly')).toBe(true);
    expect(new RegExp(args[args.indexOf('-t') + 1]).test(`auth ${LOGIN}`)).toBe(false);
    expect(result.messages.join('\n')).toContain('selected by title');
    expect(result.items.find((i) => i.key === 'app')?.message).toContain('selection: tests');
    const record = recordOf(repo, 'one');
    expect(record.selection).toBe('tests');
    expect(record.tests).toEqual([{ file: 'tests/auth.test.ts', title: LOGOUT, refs: ['capabilities/auth#logout-clears-session'], verdict: 'pass' }]);
  });

  // [claims: capabilities/conformance-testing#claims-run-exact-tests]
  it('selects the tests of several claims together and a row-less ref also selects its rows', async () => {
    const repo = repoWith([]);
    await run(repo, { claims: ['capabilities/auth#logout-clears-session', 'capabilities/auth#login-valid-code'], record: 'two' });
    const record = recordOf(repo, 'two');
    expect(record.tests.map((t) => t.title).sort()).toEqual([LOGIN, LOGOUT].sort());
  });

  // [claims: capabilities/conformance-testing#claims-run-exact-tests]
  it('does not run anything when no test is tagged to the claims, and says which', async () => {
    const repo = repoWith([]);
    const result = await run(repo, { claims: ['capabilities/auth#nothing-tests-this'] });
    expect(result.exitCode).toBe(2);
    expect(result.messages.join('\n')).toContain('no test is tagged to capabilities/auth#nothing-tests-this');
    expect(existsSync(path.join(repo.dir, 'argv.json'))).toBe(false);
  });

  // [claims: capabilities/conformance-testing#claims-run-exact-tests]
  it('reports a claim without a test while running the others', async () => {
    const repo = repoWith([]);
    const result = await run(repo, { claims: ['capabilities/auth#logout-clears-session', 'capabilities/auth#nothing-tests-this'] });
    expect(result.exitCode).toBe(0);
    expect(result.items.find((i) => i.key === 'capabilities/auth#nothing-tests-this')?.status).toBe('skipped');
  });

  // [claims: capabilities/conformance-testing#claims-run-exact-tests]
  it('refuses a malformed ref, test files next to --claims, and a bad record id', async () => {
    const repo = repoWith([]);
    expect((await run(repo, { claims: ['not-a-ref'] })).exitCode).toBe(1);
    expect((await run(repo, { claims: ['capabilities/auth#logout-clears-session'], selection: ['tests/auth.test.ts'] })).exitCode).toBe(1);
    expect((await run(repo, { record: '../escape' })).exitCode).toBe(1);
    expect(existsSync(path.join(repo.dir, 'argv.json'))).toBe(false);
  });

  // [claims: capabilities/conformance-testing#claims-files-fallback]
  it('runs the files and flags selection: files when a tagged test has no title the runner can be given', async () => {
    const repo = repoWith([]);
    const result = await run(repo, { claims: ['capabilities/auth#login-valid-code'], record: 'fallback' });
    const args = argvOf(repo);
    expect(args).not.toContain('-t');
    expect(args).toContain('tests/auth.test.ts');
    expect(result.messages.join('\n')).toContain('by file only');
    expect(result.items.find((i) => i.key === 'app')?.message).toContain('selection: files');
    const record = recordOf(repo, 'fallback');
    expect(record.selection).toBe('files');
    expect(record.suites[0].selection).toBe('files');
    // the verdicts are still judged only on the selected tests: the other tests of the file are ignored
    expect(record.tests.map((t) => t.title)).toEqual([LOGIN]);
    expect(record.tests[0].verdict).toBe('pass');
  });

  // [claims: capabilities/conformance-testing#claims-files-fallback]
  it('says missing, never pass, for a selected test no report row names', async () => {
    const repo = repoWith([]);
    // the fake runner drops the test from its catalog: the report cannot vouch for it
    repo.write('catalog.json', JSON.stringify([{ file: 'tests/auth.test.ts', ancestors: ['auth'], title: OTHER, status: 'passed' }]));
    await run(repo, { claims: ['capabilities/auth#login-valid-code'], record: 'missing' });
    expect(recordOf(repo, 'missing').tests.every((t) => t.verdict === 'missing')).toBe(true);
  });
});

describe('test run --record [run-record]', () => {
  // [claims: capabilities/conformance-testing#run-record-owned-hash]
  it('writes the run record with the head commit, selection, suites and per-test verdicts', async () => {
    const repo = repoWith([{ title: LOGOUT, status: 'failed' }]);
    const result = await run(repo, { claims: ['capabilities/auth#logout-clears-session'], record: 'red-1', runId: 'run-x' });
    expect(result.exitCode).toBe(2);
    const record = recordOf(repo, 'red-1');
    expect(record).toMatchObject({ version: 1, id: 'red-1', runId: 'run-x', claims: ['capabilities/auth#logout-clears-session'], selection: 'tests' });
    expect(record.headSha).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim());
    expect(record.tests).toEqual([{ file: 'tests/auth.test.ts', title: LOGOUT, refs: ['capabilities/auth#logout-clears-session'], verdict: 'fail' }]);
    expect(record.suites).toHaveLength(1);
    expect(record.suites[0]).toMatchObject({ label: 'app', runner: 'vitest', exitCode: 1, parsed: true, selection: 'tests' });
    expect(record.startedAt <= record.finishedAt).toBe(true);
  });

  // [claims: capabilities/conformance-testing#run-record-owned-hash]
  it('changes the owned source tree hash when an owned file changes, and only then', async () => {
    const repo = repoWith([]);
    const claims = ['capabilities/auth#logout-clears-session'];
    await run(repo, { claims, record: 'a' });
    await run(repo, { claims, record: 'same' });
    const a = recordOf(repo, 'a');
    expect(a.ownedFileCount).toBe(2);
    expect(recordOf(repo, 'same').ownedSourceTreeHash).toBe(a.ownedSourceTreeHash);

    // a file another capability owns, and a test file: not owned source
    repo.write('src/shop/cart.ts', 'export const cart = 2;\n');
    repo.write('tests/other.test.ts', '// nothing\n');
    await run(repo, { claims, record: 'unowned' });
    expect(recordOf(repo, 'unowned').ownedSourceTreeHash).toBe(a.ownedSourceTreeHash);

    repo.write('src/auth/login.ts', 'export const login = 2;\n');
    await run(repo, { claims, record: 'owned-edit' });
    expect(recordOf(repo, 'owned-edit').ownedSourceTreeHash).not.toBe(a.ownedSourceTreeHash);

    repo.write('src/auth/extra.ts', 'export const extra = 1;\n');
    await run(repo, { claims, record: 'owned-add' });
    expect(recordOf(repo, 'owned-add').ownedSourceTreeHash).not.toBe(recordOf(repo, 'owned-edit').ownedSourceTreeHash);
    expect(recordOf(repo, 'owned-add').ownedFileCount).toBe(3);
  });

  // [claims: capabilities/conformance-testing#run-record-owned-hash]
  it('hashes content and path, in a stable order', () => {
    const repo = repoWith([]);
    const files = ['src/auth/login.ts', 'src/auth/logout.ts'];
    expect(ownedTreeHash(repo.dir, files)).toBe(ownedTreeHash(repo.dir, [...files].reverse()));
    expect(ownedTreeHash(repo.dir, files)).not.toBe(ownedTreeHash(repo.dir, [files[0]]));
    expect(ownedTreeHash(repo.dir, ['src/gone.ts'])).not.toBe(ownedTreeHash(repo.dir, []));
  });

  // [claims: capabilities/conformance-testing#run-record-owned-hash]
  it('records a run without claims too, over every capability, and runs the whole suite', async () => {
    const repo = repoWith([]);
    await run(repo, { record: 'whole' });
    const record = recordOf(repo, 'whole');
    expect(record.claims).toEqual([]);
    expect(record.selection).toBe('suite');
    expect(record.ownedFileCount).toBeGreaterThanOrEqual(3);
    expect(argvOf(repo)).toEqual([]);
  });

  // [claims: capabilities/conformance-testing#run-record-owned-hash]
  it('ingests into the proof ledger by default and not when asked not to', async () => {
    const repo = repoWith([]);
    await runTestRun(await loadConfig(repo.dir), { claims: ['capabilities/auth#logout-clears-session'] });
    expect(existsSync(path.join(repo.dir, '.specguard/proofs.json'))).toBe(true);
    const quiet = repoWith([]);
    await run(quiet, { claims: ['capabilities/auth#logout-clears-session'] });
    expect(existsSync(path.join(quiet.dir, '.specguard/proofs.json'))).toBe(false);
  });
});

describe('test run --coverage [coverage-flags]', () => {
  const COVERAGE = { flags: '--coverage --coverage.reporter=lcov', reports: ['coverage/lcov.info'], format: 'lcov' };

  // [claims: capabilities/conformance-testing#coverage-flags-recorded]
  it('appends the configured flags and records the report paths without ingesting anything', async () => {
    const repo = repoWith([], COVERAGE);
    const result = await run(repo, { claims: ['capabilities/auth#logout-clears-session'], coverage: true, record: 'cov' });
    const args = argvOf(repo);
    expect(args).toContain('--coverage');
    expect(args).toContain('--coverage.reporter=lcov');
    expect(args).toContain('-t');
    expect(result.messages.join('\n')).toContain('[coverage] app: reports coverage/lcov.info');
    expect(recordOf(repo, 'cov').coverage).toEqual([{ suite: 'app', configured: true, flags: COVERAGE.flags, reports: COVERAGE.reports, format: 'lcov' }]);
    expect(existsSync(path.join(repo.dir, '.specguard/coverage'))).toBe(false);
  });

  // [claims: capabilities/conformance-testing#coverage-flags-recorded]
  it('adds nothing without --coverage', async () => {
    const repo = repoWith([], COVERAGE);
    await run(repo, { claims: ['capabilities/auth#logout-clears-session'], record: 'plain' });
    expect(argvOf(repo)).not.toContain('--coverage');
    expect(recordOf(repo, 'plain').coverage).toBeUndefined();
  });

  // [claims: capabilities/conformance-testing#coverage-flags-recorded]
  it('says so, and runs without coverage, for an app with no test.coverage', async () => {
    const repo = repoWith([]);
    const result = await run(repo, { coverage: true, record: 'none' });
    expect(argvOf(repo)).not.toContain('--coverage');
    expect(result.messages.join('\n')).toContain('no test.coverage configured');
    expect(recordOf(repo, 'none').coverage).toEqual([{ suite: 'app', configured: false, reports: [] }]);
  });
});
