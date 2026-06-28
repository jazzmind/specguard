import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mock the LLM chokepoint so no real provider calls occur.
vi.mock('../../src/core/llm.js', () => ({
  llmGenerateObject: vi.fn(),
}));

import { llmGenerateObject } from '../../src/core/llm.js';
import { runHeal, healRunner, parseVitestJson } from '../../src/pipelines/heal.js';
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
    const spy = vi.spyOn(healRunner, 'runTests').mockReturnValue({ stdout: PASSING_JSON, exitCode: 0 });

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
      .spyOn(healRunner, 'runTests')
      .mockReturnValueOnce({ stdout: jsonOutput([{ file: testFile, title: 'does x' }]), exitCode: 1 })
      .mockReturnValueOnce({ stdout: PASSING_JSON, exitCode: 0 });

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
      .spyOn(healRunner, 'runTests')
      .mockReturnValue({ stdout: jsonOutput([{ file: testFile, title: 'api works' }]), exitCode: 1 });

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
      .spyOn(healRunner, 'runTests')
      .mockReturnValue({ stdout: jsonOutput([{ file: testFile, title: 'never green' }]), exitCode: 1 });

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
      .spyOn(healRunner, 'runTests')
      .mockReturnValue({ stdout: 'segfault: no json here', exitCode: 1 });

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
      .spyOn(healRunner, 'runTests')
      .mockReturnValue({ stdout: jsonOutput([{ file: testFile, title: 'fails' }]), exitCode: 1 });
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
