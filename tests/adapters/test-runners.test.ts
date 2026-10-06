import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dockerRunner } from '../../src/adapters/docker.js';
import {
  ADAPTERS,
  getRunnerAdapter,
  prepareRun,
  runnerForFramework,
  runTests,
  testRunnerSeam,
  withFlags,
} from '../../src/adapters/test-runners.js';

const fx = (name: string) => path.join(__dirname, '..', 'fixtures', 'results', name);
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'sg-runner-'));

afterEach(() => vi.restoreAllMocks());

describe('prepareRun', () => {
  const run = (id: keyof typeof ADAPTERS, opts: Partial<Parameters<typeof prepareRun>[1]> = {}) =>
    prepareRun(ADAPTERS[id], { cwd: '/repo', ...opts }, '/repo/.specguard/runs/x');

  it('adds the right reporter flags per adapter', () => {
    expect(run('vitest').command).toBe('npx vitest run --reporter=json --outputFile=/repo/.specguard/runs/x/results.json');
    expect(run('jest').command).toBe('npx jest --json --outputFile=/repo/.specguard/runs/x/results.json');
    const pw = run('playwright');
    expect(pw.command).toBe('npx playwright test --reporter=json');
    expect(pw.env).toEqual({ PLAYWRIGHT_JSON_OUTPUT_NAME: '/repo/.specguard/runs/x/results.json' });
    expect(run('pytest').command).toBe('pytest --junitxml=/repo/.specguard/runs/x/results.xml');
    expect(run('go').command).toBe('go test -json ./... > /repo/.specguard/runs/x/results.jsonl');
    const cargo = run('cargo');
    expect(cargo.command).toBe('cargo test -- -Z unstable-options --format json > /repo/.specguard/runs/x/results.jsonl');
    expect(cargo.env).toEqual({ RUSTC_BOOTSTRAP: '1' });
  });

  it('inserts one -- for npm scripts only', () => {
    expect(withFlags('npm test', '--reporter=json')).toBe('npm test -- --reporter=json');
    expect(withFlags('npm run test:unit', '--json')).toBe('npm run test:unit -- --json');
    expect(withFlags('npm test -- --run', '--json')).toBe('npm test -- --run --json');
    expect(withFlags('pnpm test', '--json')).toBe('pnpm test --json');
    expect(withFlags('yarn vitest run', '--json')).toBe('yarn vitest run --json');
    expect(run('vitest', { command: 'npm test' }).command).toBe('npm test -- --reporter=json --outputFile=/repo/.specguard/runs/x/results.json');
  });

  it('runs the command verbatim when resultsFile is configured', () => {
    const p = run('vitest', { command: 'pnpm test:ci', resultsFile: 'out/vitest.json' });
    expect(p.command).toBe('pnpm test:ci');
    expect(p.env).toEqual({ SPECGUARD_RESULTS_FILE: path.resolve('/repo', 'out/vitest.json') });
    expect(p.file).toBeUndefined();
  });

  it('passes a selection as file arguments (package dirs for Go)', () => {
    expect(run('vitest', { selection: ['tests/a.test.ts', 'tests/b c.test.ts'] }).command).toContain("--outputFile=/repo/.specguard/runs/x/results.json tests/a.test.ts 'tests/b c.test.ts'");
    expect(run('go', { selection: ['./pkg/a'] }).command).toBe('go test -json ./pkg/a > /repo/.specguard/runs/x/results.jsonl');
    expect(run('pytest', { selection: ['tests/test_a.py'] }).command).toBe('pytest --junitxml=/repo/.specguard/runs/x/results.xml tests/test_a.py');
  });

  it('knows the adapter for each language framework and rejects unknown ones', () => {
    expect(runnerForFramework('go-test')).toBe('go');
    expect(runnerForFramework('cargo-test')).toBe('cargo');
    expect(runnerForFramework('pytest')).toBe('pytest');
    expect(runnerForFramework('mocha')).toBeUndefined();
    expect(() => getRunnerAdapter('mocha')).toThrow(/Unknown test runner/);
  });
});

/** Stand-in runner: copies a fixture to wherever the command says the report goes. */
function fakeRunner(fixture: string, exitCode = 1) {
  return vi.spyOn(testRunnerSeam, 'exec').mockImplementation((command, opts) => {
    const target =
      command.match(/--outputFile=(\S+)/)?.[1] ??
      opts.env.PLAYWRIGHT_JSON_OUTPUT_NAME ??
      command.match(/--junitxml=(\S+)/)?.[1] ??
      command.match(/> (\S+)$/)?.[1];
    if (target) copyFileSync(fx(fixture), target);
    return { output: 'noisy stdout that must never be parsed {"testResults":[]}', exitCode, timedOut: false };
  });
}

describe('runTests', () => {
  it('reads every test from the reporter file, including passes', async () => {
    fakeRunner('vitest.json');
    const report = await runTests('vitest', { cwd: tmp() });
    expect(report.parsed).toBe(true);
    expect(report.exitCode).toBe(1);
    expect(report.tests.map((t) => t.status)).toEqual(['pass', 'fail', 'pass', 'skip']);
    expect(report.raw).toContain('noisy stdout');
  });

  it('reads Playwright from the env-named file, pytest from JUnit, Go and Cargo from the redirect', async () => {
    fakeRunner('playwright.json');
    expect((await runTests('playwright', { cwd: tmp() })).tests).toHaveLength(3);
    fakeRunner('junit.xml');
    expect((await runTests('pytest', { cwd: tmp() })).tests.map((t) => t.status)).toEqual(['pass', 'fail', 'skip']);
    fakeRunner('go.jsonl');
    expect((await runTests('go', { cwd: tmp() })).tests).toHaveLength(2);
    fakeRunner('cargo.jsonl');
    expect((await runTests('cargo', { cwd: tmp() })).tests).toHaveLength(2);
  });

  it('never falls back to stdout: a missing report is parsed:false with no tests', async () => {
    vi.spyOn(testRunnerSeam, 'exec').mockReturnValue({ output: readFileSync(fx('vitest.json'), 'utf8'), exitCode: 0, timedOut: false });
    const report = await runTests('vitest', { cwd: tmp() });
    expect(report.parsed).toBe(false);
    expect(report.tests).toEqual([]);
    expect(report.parseError).toMatch(/not written/);
  });

  it('an unparseable report file is parsed:false and names the file', async () => {
    vi.spyOn(testRunnerSeam, 'exec').mockImplementation((command) => {
      writeFileSync(command.match(/--outputFile=(\S+)/)![1], '{ not json');
      return { output: '', exitCode: 0, timedOut: false };
    });
    const report = await runTests('vitest', { cwd: tmp() });
    expect(report.parsed).toBe(false);
    expect(report.parseError).toMatch(/results\.json/);
  });

  it('merges a results glob and runs the command as written', async () => {
    const cwd = tmp();
    const spy = vi.spyOn(testRunnerSeam, 'exec').mockImplementation(() => {
      mkdirSync(path.join(cwd, 'target/surefire-reports'), { recursive: true });
      copyFileSync(fx('junit.xml'), path.join(cwd, 'target/surefire-reports/TEST-a.xml'));
      copyFileSync(fx('junit.xml'), path.join(cwd, 'target/surefire-reports/TEST-b.xml'));
      return { output: '', exitCode: 1, timedOut: false };
    });
    const report = await runTests('junit', { cwd, command: 'mvn -q test', resultsFile: 'target/surefire-reports/TEST-*.xml' });
    expect(spy.mock.calls[0][0]).toBe('mvn -q test');
    expect(report.parsed).toBe(true);
    expect(report.tests).toHaveLength(6);
    expect(report.reportFiles).toHaveLength(2);
  });

  it('reports a timeout', async () => {
    vi.spyOn(testRunnerSeam, 'exec').mockReturnValue({ output: '', exitCode: 124, timedOut: true });
    const report = await runTests('vitest', { cwd: tmp(), timeoutMs: 5 });
    expect(report.timedOut).toBe(true);
    expect(report.exitCode).not.toBe(0);
  });

  it('actually spawns and kills a hung process at timeoutMs', async () => {
    const report = await runTests('vitest', { cwd: tmp(), command: 'node -e "setTimeout(()=>{}, 30000)" #', timeoutMs: 300 });
    expect(report.timedOut).toBe(true);
    expect(report.exitCode).toBe(124);
    expect(report.parsed).toBe(false);
  });

  it('docker sandbox needs an image and a daemon, and never falls back to the host', async () => {
    const exec = vi.spyOn(testRunnerSeam, 'exec');
    const noImage = await runTests('vitest', { cwd: tmp(), sandbox: 'docker' });
    expect(noImage.parseError).toMatch(/test\.image/);
    vi.spyOn(dockerRunner, 'spawn').mockReturnValue({ stdout: '', stderr: 'no daemon', status: 1 });
    const noDaemon = await runTests('vitest', { cwd: tmp(), sandbox: 'docker', image: 'node:22' });
    expect(noDaemon.parseError).toMatch(/not available/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('docker sandbox mounts the repo and rewrites host paths', async () => {
    const cwd = tmp();
    const spawn = vi.spyOn(dockerRunner, 'spawn').mockImplementation((args) => {
      if (args[0] === 'info') return { stdout: '27', stderr: '', status: 0 };
      const cmd = args[args.length - 1];
      const file = cmd.match(/--outputFile=\/work\/(\S+)/)![1];
      copyFileSync(fx('vitest.json'), path.join(cwd, file));
      return { stdout: '', stderr: '', status: 1 };
    });
    const report = await runTests('vitest', { cwd, sandbox: 'docker', image: 'node:22' });
    const runArgs = spawn.mock.calls.find((c) => c[0][0] === 'run')![0];
    expect(runArgs).toContain(`${cwd}:/work:rw`);
    expect(runArgs).toContain('node:22');
    expect(report.parsed).toBe(true);
    expect(report.tests).toHaveLength(4);
  });
});
