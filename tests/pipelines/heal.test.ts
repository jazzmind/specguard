import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mock the LLM chokepoint so no real provider calls occur.
vi.mock('../../src/core/llm.js', () => ({
  llmGenerateObject: vi.fn(),
}));

import { llmGenerateObject } from '../../src/core/llm.js';
import { runHeal, healRunner, parseVitestJson, buildHealJobs, featureOfTestFile } from '../../src/pipelines/heal.js';
import { parseVitestResults } from '../../src/core/test-results.js';
import { getProfile } from '../../src/core/language-profiles.js';
import type { TestRunReport } from '../../src/adapters/test-runners.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

const mockedLlm = llmGenerateObject as unknown as ReturnType<typeof vi.fn>;

let rootDir: string;

function makeConfig(): SpecGuardConfig {
  return {
    rootDir,
    apps: [
      {
        name: 'my-app',
        repo: '.',
        specDir: 'specs/my-app',
        sources: {},
        framework: 'vitest',
        testOutput: 'tests/',
      },
    ],
    llm: { provider: 'anthropic', model: 'claude-test', apiKeyEnv: 'TEST_KEY' },
    heal: { maxRetries: 2, testCommand: 'npm test' },
  };
}

/** Build a vitest-style JSON reporter document with the given failing tests. */
function jsonOutput(
  failing: Array<{ file: string; title: string; message?: string }>,
): string {
  const byFile = new Map<string, Array<{ title: string; message?: string }>>();
  for (const f of failing) {
    const arr = byFile.get(f.file) ?? [];
    arr.push({ title: f.title, message: f.message });
    byFile.set(f.file, arr);
  }
  const testResults = [...byFile.entries()].map(([file, tests]) => ({
    name: file,
    assertionResults: tests.map((t) => ({
      status: 'failed',
      title: t.title,
      failureMessages: [t.message ?? 'assertion failed'],
    })),
  }));
  return JSON.stringify({
    numFailedTests: failing.length,
    success: failing.length === 0,
    testResults,
  });
}

const PASSING_JSON = JSON.stringify({
  numFailedTests: 0,
  success: true,
  testResults: [{ name: 'a.test.ts', assertionResults: [{ status: 'passed', title: 'ok', failureMessages: [] }] }],
});

/** A runner report as the adapter would return it for a reporter file holding `json`. */
function report(json: string, exitCode: number): TestRunReport {
  return { tests: parseVitestResults(json), exitCode, raw: '', parsed: true, timedOut: false, reportFiles: ['r.json'], command: 'x' };
}
const unreadable = (exitCode: number): TestRunReport => ({
  tests: [], exitCode, raw: 'segfault', parsed: false, timedOut: false, reportFiles: [], command: 'x', parseError: 'results file was not written',
});

beforeEach(async () => {
  mockedLlm.mockReset();
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'specguard-heal-'));
});

describe('parseVitestJson', () => {
  it('returns null for malformed output', () => {
    expect(parseVitestJson('not json at all')).toBeNull();
  });

  it('extracts a JSON object from noisy stdout', () => {
    const noisy = `> vitest run\n${jsonOutput([{ file: 'x.test.ts', title: 'fails' }])}\nDone.`;
    const res = parseVitestJson(noisy);
    expect(res).toHaveLength(1);
    expect(res?.[0]).toMatchObject({ file: 'x.test.ts', name: 'fails' });
  });
});

describe('runHeal', () => {
  it('scenario 1: all passing on first run → exit 0, no LLM calls', async () => {
    const spy = vi.spyOn(healRunner, 'run').mockResolvedValue(report(PASSING_JSON, 0));

    const res = await runHeal(makeConfig(), {});

    expect(spy).toHaveBeenCalledOnce();
    expect(mockedLlm).not.toHaveBeenCalled();
    expect(res.exitCode).toBe(ExitCode.Success);
    expect(res.messages.some((m) => m.includes('all tests passing'))).toBe(true);

    spy.mockRestore();
  });

  it('scenario 2: test-bug rewrite, second run passes → fixed:1, exit 0', async () => {
    const testFile = path.join(rootDir, 'foo.test.ts');
    await writeFile(testFile, 'expect(1).toBe(2);\n', 'utf-8');

    const spy = vi
      .spyOn(healRunner, 'run')
      .mockResolvedValueOnce(report(jsonOutput([{ file: testFile, title: 'does x' }]), 1))
      .mockResolvedValueOnce(report(PASSING_JSON, 0));

    mockedLlm.mockResolvedValueOnce({
      classification: 'test-bug',
      reason: 'stale assertion',
      fixedTestCode: 'expect(1).toBe(1);\n',
    });

    const res = await runHeal(makeConfig(), {});

    expect(mockedLlm).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.updated).toBe(1); // fixed
    expect(res.exitCode).toBe(ExitCode.Success);
    // The rewrite was written through the writer abstraction.
    expect(await readFile(testFile, 'utf-8')).toBe('expect(1).toBe(1);\n');

    spy.mockRestore();
  });

  it('scenario 3: app-bug recorded, no rewrite, exit 7', async () => {
    const testFile = path.join(rootDir, 'bar.test.ts');
    await writeFile(testFile, 'expect(api()).toBe(true);\n', 'utf-8');
    const original = await readFile(testFile, 'utf-8');

    const spy = vi
      .spyOn(healRunner, 'run')
      .mockResolvedValue(report(jsonOutput([{ file: testFile, title: 'api works' }]), 1));

    mockedLlm.mockResolvedValueOnce({
      classification: 'app-bug',
      reason: 'application returns false; real defect',
    });

    const res = await runHeal(makeConfig(), {});

    expect(mockedLlm).toHaveBeenCalledOnce();
    // Only the initial run — no re-run since nothing was rewritten.
    expect(spy).toHaveBeenCalledOnce();
    expect(res.exitCode).toBe(ExitCode.HealFailed);
    const appBugItem = res.items.find((i) => i.status === 'failed' && i.message?.includes('real defect'));
    expect(appBugItem).toBeDefined();
    // Test file untouched.
    expect(await readFile(testFile, 'utf-8')).toBe(original);
    expect(res.messages.some((m) => m.includes('app-bugs: 1'))).toBe(true);

    spy.mockRestore();
  });

  it('scenario 4: still failing after maxRetries → still-broken, exit 7', async () => {
    const testFile = path.join(rootDir, 'baz.test.ts');
    await writeFile(testFile, 'expect(1).toBe(2);\n', 'utf-8');

    // Always fails, every run.
    const spy = vi
      .spyOn(healRunner, 'run')
      .mockResolvedValue(report(jsonOutput([{ file: testFile, title: 'never green' }]), 1));

    // Always classified as a test-bug with a rewrite that never helps.
    mockedLlm.mockResolvedValue({
      classification: 'test-bug',
      reason: 'attempting fix',
      fixedTestCode: 'expect(1).toBe(2);\n',
    });

    const res = await runHeal({ ...makeConfig(), heal: { maxRetries: 2, testCommand: 'npm test' } }, {});

    // initial + 2 retries = 3 runs.
    expect(spy).toHaveBeenCalledTimes(3);
    expect(res.exitCode).toBe(ExitCode.HealFailed);
    expect(res.messages.some((m) => m.includes('still-broken: 1'))).toBe(true);
    expect(res.updated).toBe(0);

    spy.mockRestore();
  });

  it('scenario 5: malformed JSON → graceful, no throw', async () => {
    const spy = vi
      .spyOn(healRunner, 'run')
      .mockResolvedValue(unreadable(1));

    const res = await runHeal(makeConfig(), {});

    expect(mockedLlm).not.toHaveBeenCalled();
    expect(res.exitCode).toBe(ExitCode.HealFailed);
    expect(res.messages.some((m) => m.includes('could not parse test output'))).toBe(true);

    spy.mockRestore();
  });

  it('respects opts.maxRetries override', async () => {
    const testFile = path.join(rootDir, 'qux.test.ts');
    await writeFile(testFile, 'x\n', 'utf-8');

    const spy = vi
      .spyOn(healRunner, 'run')
      .mockResolvedValue(report(jsonOutput([{ file: testFile, title: 'fails' }]), 1));
    mockedLlm.mockResolvedValue({
      classification: 'test-bug',
      reason: 'fix',
      fixedTestCode: 'y\n',
    });

    await runHeal(makeConfig(), { maxRetries: 0 });

    // maxRetries 0 → only the initial run, no re-runs.
    expect(spy).toHaveBeenCalledOnce();

    spy.mockRestore();
  });
});

describe('runHeal gate and modes', () => {
  it('an unreadable report is a failure even when the runner exited 0', async () => {
    const spy = vi.spyOn(healRunner, 'run').mockResolvedValue(unreadable(0));
    const res = await runHeal(makeConfig(), {});
    expect(res.exitCode).toBe(ExitCode.HealFailed);
    expect(res.messages.some((m) => m.includes('could not parse test output'))).toBe(true);
    expect(res.messages.some((m) => m.includes('all tests passing'))).toBe(false);
    spy.mockRestore();
  });

  it('--lenient restores fail-open only for a zero exit', async () => {
    const spy = vi.spyOn(healRunner, 'run').mockResolvedValue(unreadable(0));
    expect((await runHeal(makeConfig(), { lenient: true })).exitCode).toBe(ExitCode.Success);
    spy.mockResolvedValue(unreadable(1));
    expect((await runHeal(makeConfig(), { lenient: true })).exitCode).toBe(ExitCode.HealFailed);
    spy.mockRestore();
  });

  it('--classify-only classifies but never writes a test and never re-runs', async () => {
    const testFile = path.join(rootDir, 'stale.test.ts');
    await writeFile(testFile, 'expect(1).toBe(2);\n', 'utf-8');
    const spy = vi.spyOn(healRunner, 'run').mockResolvedValue(report(jsonOutput([{ file: testFile, title: 'stale' }]), 1));
    mockedLlm.mockResolvedValue({ classification: 'test-bug', reason: 'stale assertion', fixedTestCode: 'expect(1).toBe(1);\n' });
    const res = await runHeal(makeConfig(), { classifyOnly: true });
    expect(spy).toHaveBeenCalledOnce();
    expect(await readFile(testFile, 'utf-8')).toBe('expect(1).toBe(2);\n');
    expect(res.exitCode).toBe(ExitCode.HealFailed);
    expect(res.messages.some((m) => m.includes('classify-only: not rewritten'))).toBe(true);
    expect(res.items[0].message).toBe('test-bug: stale assertion');
    spy.mockRestore();
  });

  it('runs one job per distinct command across apps and reports failures from each', async () => {
    const a = path.join(rootDir, 'a.test.ts');
    const b = path.join(rootDir, 'b.test.ts');
    await writeFile(a, 'a', 'utf-8');
    await writeFile(b, 'b', 'utf-8');
    const config: SpecGuardConfig = {
      ...makeConfig(),
      apps: [
        { name: 'web', repo: '.', specDir: 'specs/web', sources: {}, framework: 'vitest', testOutput: 'tests/', test: { command: 'pnpm --filter web test', cwd: 'web' } },
        { name: 'api', repo: '.', specDir: 'specs/api', sources: {}, framework: 'jest', testOutput: 'tests/', test: { command: 'pnpm --filter api test', cwd: 'api' } },
        { name: 'lib', repo: '.', specDir: 'specs/lib', sources: {}, framework: 'vitest', testOutput: 'tests/' },
        { name: 'lib2', repo: '.', specDir: 'specs/lib2', sources: {}, framework: 'vitest', testOutput: 'tests/' },
      ],
    };
    const jobs = await buildHealJobs(config, {});
    expect(jobs.map((j) => [j.key, j.runner, j.command])).toEqual([
      ['web', 'vitest', 'pnpm --filter web test'],
      ['api', 'jest', 'pnpm --filter api test'],
      ['lib', 'vitest', 'npm test'],
    ]);
    expect(jobs[2].apps.map((x) => x.name)).toEqual(['lib', 'lib2']);
    expect(jobs[0].cwd).toBe(path.join(rootDir, 'web'));

    const spy = vi
      .spyOn(healRunner, 'run')
      .mockImplementation(async (job) => {
        if (job.key === 'web') return report(jsonOutput([{ file: a, title: 'web fails' }]), 1);
        if (job.key === 'api') return report(jsonOutput([{ file: b, title: 'api fails' }]), 1);
        return report(PASSING_JSON, 0);
      });
    mockedLlm.mockResolvedValue({ classification: 'app-bug', reason: 'real' });
    const res = await runHeal(config, {});
    expect(spy).toHaveBeenCalledTimes(3);
    expect(res.exitCode).toBe(ExitCode.HealFailed);
    expect(res.messages.some((m) => m.includes('app-bugs: 2'))).toBe(true);
    spy.mockRestore();
  });

  it('--app narrows to one app', async () => {
    const config = { ...makeConfig(), apps: [
      { name: 'one', repo: '.', specDir: 's1', sources: {}, framework: 'vitest', testOutput: 't/', test: { command: 'a' } },
      { name: 'two', repo: '.', specDir: 's2', sources: {}, framework: 'vitest', testOutput: 't/', test: { command: 'b' } },
    ] };
    expect((await buildHealJobs(config, { app: 'two' })).map((j) => j.key)).toEqual(['two']);
    expect((await buildHealJobs(config, { all: true })).map((j) => j.key)).toEqual(['one', 'two']);
  });

  it('--spec runs only the owning app with that spec\'s test files', async () => {
    await mkdir(path.join(rootDir, 'specs/my-app'), { recursive: true });
    await mkdir(path.join(rootDir, 'tests'), { recursive: true });
    await writeFile(path.join(rootDir, 'specs/my-app/reader.md'), '# Reader\n\n## Overview\nx\n', 'utf-8');
    await writeFile(path.join(rootDir, 'tests/reader.test.ts'), "it('x @claim:reader#a', () => {})\n", 'utf-8');
    await writeFile(path.join(rootDir, 'tests/other.test.ts'), "it('y', () => {})\n", 'utf-8');
    await writeFile(path.join(rootDir, 'tests/tagged.test.ts'), "it('z @claim:reader#b', () => {})\n", 'utf-8');
    const jobs = await buildHealJobs(makeConfig(), { spec: 'reader' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].selection).toEqual(['tests/reader.test.ts', 'tests/tagged.test.ts']);
    const none = await runHeal(makeConfig(), { spec: 'missing-spec' });
    expect(none.messages.join('\n')).toContain('no app owns spec');
  });

  it('matches a failing test to its spec with the language profile, not a TypeScript-only regex', () => {
    expect(featureOfTestFile('/x/reader_test.py', getProfile('python'))).toBe('reader');
    expect(featureOfTestFile('/x/test_reader.py', getProfile('python'))).toBe('reader');
    expect(featureOfTestFile('/x/Reader.test.tsx', getProfile('typescript'))).toBe('reader');
    expect(featureOfTestFile('/x/reader_test.go', getProfile('go'))).toBe('reader');
  });
});

