import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import type { CoverageEvidence } from '../../src/core/coverage.js';
import { readCoverageEvidence, runCoverageIngest, selectionForCapability } from '../../src/pipelines/coverage-ingest.js';
import { makeV2Repo, gitInit } from '../helpers/v2-repo.js';

const LOGIN_TEST = "// [claims: capabilities/auth#login-valid-code]\nit('logs in', () => {});\n// [claims: capabilities/auth#logout-clears-session]\nit('logs out', () => {});\n";

const LCOV = 'SF:src/auth/login.ts\nDA:1,3\nDA:2,0\nend_of_record\nSF:src/shop/cart.ts\nDA:1,1\nend_of_record\n';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const stored = (dir: string, rel: string) => JSON.parse(readFileSync(path.join(dir, rel), 'utf8')) as CoverageEvidence;

describe('coverage ingest [coverage-and-mutation]', () => {
  // [claims: capabilities/coverage-and-mutation#ingest-commands]
  it('writes suite evidence with the content hash of each mapped file, and a note that a suite report is not per claim', async () => {
    const repo = makeV2Repo();
    repo.write('lcov.info', LCOV);
    const r = await runCoverageIngest(['lcov.info'], repo.dir, { runId: 'ci-7', origin: 'ci' });
    expect(r.exitCode).toBe(0);
    const e = stored(repo.dir, '.specguard/coverage/suite.json');
    expect(e).toMatchObject({ version: 1, scope: { kind: 'suite' }, runId: 'ci-7', origin: 'ci', formats: ['lcov'], granularity: 'lines' });
    expect(e.files['src/auth/login.ts']).toEqual({ hash: sha('export const login = 1;\n'), exec: [[1, 2]], hit: [[1, 1]] });
    expect(e.summary['src/shop/cart.ts']).toEqual({ exec: 1, hit: 1 });
    expect(r.messages.join('\n')).toContain('2 file(s), 2/3 executable lines hit (66.7%)');
    expect(r.messages.join('\n')).toContain('whole-suite report');
    expect((await readCoverageEvidence(repo.dir))?.runId).toBe('ci-7');
  });

  // [claims: capabilities/coverage-and-mutation#ingest-commands]
  it('a second ingest replaces the first, and records the repo commit when the repo is under git', async () => {
    const repo = makeV2Repo();
    gitInit(repo.dir);
    repo.write('lcov.info', LCOV);
    await runCoverageIngest(['lcov.info'], repo.dir, { runId: 'one' });
    repo.write('other.info', 'SF:src/shop/cart.ts\nDA:1,0\nend_of_record\n');
    await runCoverageIngest(['other.info'], repo.dir, { runId: 'two' });
    const e = stored(repo.dir, '.specguard/coverage/suite.json');
    expect(e.runId).toBe('two');
    expect(Object.keys(e.files)).toEqual(['src/shop/cart.ts']);
    expect(e.repoSha).toMatch(/^[0-9a-f]{40}$/);
  });

  // [claims: capabilities/coverage-and-mutation#paths-normalized]
  it('maps absolute paths and configured checkout prefixes, and reports what it could not map', async () => {
    const repo = makeV2Repo({ coverage: { pathPrefixes: ['/home/runner/work/app/app'] } });
    repo.write(
      'lcov.info',
      `SF:${repo.dir}/src/auth/login.ts\nDA:1,1\nend_of_record\nSF:/home/runner/work/app/app/src/shop/cart.ts\nDA:1,1\nend_of_record\nSF:/nowhere/x.ts\nDA:1,1\nend_of_record\n`,
    );
    const r = await runCoverageIngest(['lcov.info'], repo.dir);
    expect(r.exitCode).toBe(0);
    const e = stored(repo.dir, '.specguard/coverage/suite.json');
    expect(Object.keys(e.files)).toEqual(['src/auth/login.ts', 'src/shop/cart.ts']);
    expect(e.unmapped).toEqual({ count: 1, sample: ['/nowhere/x.ts'] });
    expect(r.messages.join('\n')).toContain('[warn] 1 report path(s) map to no repo file');
  });

  // [claims: capabilities/coverage-and-mutation#ingest-commands]
  it('exits 2 and writes nothing when no report path maps, or the input is unparseable or missing', async () => {
    const repo = makeV2Repo();
    repo.write('lcov.info', 'SF:/nowhere/x.ts\nDA:1,1\nend_of_record\n');
    const unmapped = await runCoverageIngest(['lcov.info'], repo.dir);
    expect(unmapped.exitCode).toBe(2);
    expect(unmapped.messages.join(' ')).toContain('coverage.pathPrefixes');
    repo.write('junk.txt', 'hello');
    const junk = await runCoverageIngest(['junk.txt'], repo.dir);
    expect(junk.exitCode).toBe(2);
    expect(junk.messages.join(' ')).toContain('not recognised');
    const none = await runCoverageIngest(['nothing-*.info'], repo.dir);
    expect(none.exitCode).toBe(2);
    expect(existsSync(path.join(repo.dir, '.specguard/coverage/suite.json'))).toBe(false);
  });

  // [claims: capabilities/coverage-and-mutation#ingest-commands]
  it('ingests the good files and exits 2 when another file fails to parse; --format overrides detection', async () => {
    const repo = makeV2Repo();
    repo.write('lcov.info', LCOV);
    repo.write('junk.txt', 'hello');
    const mixed = await runCoverageIngest(['lcov.info', 'junk.txt'], repo.dir);
    expect(mixed.exitCode).toBe(2);
    expect(existsSync(path.join(repo.dir, '.specguard/coverage/suite.json'))).toBe(true);
    const forced = await runCoverageIngest(['lcov.info'], repo.dir, { format: 'go' });
    expect(forced.exitCode).toBe(2);
    expect(forced.messages.join(' ')).toContain('go coverage');
  });

  // [claims: capabilities/coverage-and-mutation#ingest-commands]
  it('parses a Go coverprofile through the module path of go.mod', async () => {
    const repo = makeV2Repo();
    repo.write('svc/go.mod', 'module example.com/app/svc\n\ngo 1.22\n');
    repo.write('svc/pay/pay.go', 'package pay\n');
    repo.write('cover.out', 'mode: set\nexample.com/app/svc/pay/pay.go:3.1,5.2 2 1\n');
    const r = await runCoverageIngest(['cover.out'], repo.dir);
    expect(r.exitCode).toBe(0);
    expect(Object.keys(stored(repo.dir, '.specguard/coverage/suite.json').files)).toEqual(['svc/pay/pay.go']);
  });

  // [claims: capabilities/coverage-and-mutation#suite-report-limit]
  it('capability scope records the tests it ran and a hash of that selection under cap/<id>.json', async () => {
    const repo = makeV2Repo();
    repo.write('tests/auth.test.ts', LOGIN_TEST);
    repo.write('lcov.info', LCOV);
    const r = await runCoverageIngest(['lcov.info'], repo.dir, { capability: 'auth' });
    expect(r.exitCode).toBe(0);
    const e = stored(repo.dir, '.specguard/coverage/cap/auth.json');
    expect(e.scope).toMatchObject({ kind: 'capability', capability: 'auth', selection: 'tests', tests: ['tests/auth.test.ts::logs in', 'tests/auth.test.ts::logs out'] });
    const sel = await selectionForCapability(await loadConfig(repo.dir), 'auth');
    expect(e.scope.kind === 'capability' && e.scope.testsHash).toBe(sel?.testsHash);
    expect(existsSync(path.join(repo.dir, '.specguard/coverage/suite.json'))).toBe(false);
    // the tests a capability runs changing changes the hash, which is how stale evidence is noticed
    repo.write('tests/auth.test.ts', LOGIN_TEST + "// [claims: capabilities/auth#login-valid-code]\nit('logs in twice', () => {});\n");
    const after = await selectionForCapability(await loadConfig(repo.dir), 'auth');
    expect(after?.testsHash).not.toBe(sel?.testsHash);
  });

  // [claims: capabilities/coverage-and-mutation#ingest-commands]
  it('refuses an unknown capability, a capability with no tagged tests, and --selection without --capability', async () => {
    const repo = makeV2Repo();
    repo.write('lcov.info', LCOV);
    expect((await runCoverageIngest(['lcov.info'], repo.dir, { capability: 'ghost' })).messages.join(' ')).toContain("no capability 'ghost'");
    expect((await runCoverageIngest(['lcov.info'], repo.dir, { capability: 'shop' })).messages.join(' ')).toContain('no tests tagged');
    expect((await runCoverageIngest(['lcov.info'], repo.dir, { capability: '../x' })).exitCode).toBe(2);
    expect((await runCoverageIngest(['lcov.info'], repo.dir, { selection: 'files' })).exitCode).toBe(2);
  });
});
