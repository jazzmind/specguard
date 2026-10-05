import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/core/llm.js', () => ({
  llmGenerateObject: vi.fn(),
}));

import { llmGenerateObject } from '../../src/core/llm.js';
import { runAlign } from '../../src/pipelines/align.js';
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
        specDir: 'specs',
        sources: {},
        framework: 'vitest',
        testOutput: 'tests',
      },
    ],
    llm: { provider: 'anthropic', model: 'claude-test', apiKeyEnv: 'TEST_KEY' },
  };
}

function specMarkdown(title: string, scenario: string): string {
  return `# ${title}

<!-- module: my-app/${title} / type: core / status: draft -->

## Scenarios

### Scenario 1: ${scenario}

**Steps:**
1. Do the thing

**Expected Results:**
- It works
`;
}

async function writeFixture(): Promise<void> {
  await mkdir(path.join(rootDir, 'specs'), { recursive: true });
  await mkdir(path.join(rootDir, 'tests'), { recursive: true });
  await writeFile(path.join(rootDir, 'specs', 'alpha.md'), specMarkdown('Alpha', 'Alpha works'));
  await writeFile(path.join(rootDir, 'specs', 'beta.md'), specMarkdown('Beta', 'Beta works'));
  await writeFile(path.join(rootDir, 'tests', 'alpha.test.ts'), "it('checks alpha behaviour', () => {});\n");
  await writeFile(path.join(rootDir, 'tests', 'beta.test.ts'), "it('checks beta behaviour', () => {});\n");
}

function covered(scenario: string, testFile: string) {
  return {
    coveredScenarios: [{ scenario, testFile, testName: scenario, confidence: 'high' as const }],
    uncoveredScenarios: [],
    unmappedTests: [],
    coveredClaims: [],
    uncoveredClaims: [],
  };
}

beforeEach(async () => {
  mockedLlm.mockReset();
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'specguard-align-'));
  await writeFixture();
});

describe('runAlign checkpoint', () => {
  it('writes alignment.json after a finished run and skips cached specs on the next run', async () => {
    mockedLlm.mockImplementation(async (opts: { prompt: string }) => {
      if (opts.prompt.includes('SPEC KEY: alpha')) return covered('Alpha works', 'tests/alpha.test.ts');
      return covered('Beta works', 'tests/beta.test.ts');
    });

    const first = await runAlign(makeConfig(), { concurrency: 2 });
    expect(mockedLlm).toHaveBeenCalledTimes(2);
    expect(first.report.checkpoint?.complete).toBe(true);
    expect(first.report.entries).toHaveLength(2);

    const saved = JSON.parse(await readFile(path.join(rootDir, '.specguard', 'alignment.json'), 'utf-8'));
    expect(saved.checkpoint.complete).toBe(true);
    expect(saved.entries.map((e: { specKey: string }) => e.specKey).sort()).toEqual([
      'my-app/alpha',
      'my-app/beta',
    ]);

    mockedLlm.mockClear();
    const second = await runAlign(makeConfig(), { concurrency: 2 });
    expect(mockedLlm).not.toHaveBeenCalled();
    expect(second.report.entries).toHaveLength(2);
    expect(second.messages.some((line) => line.includes('cached'))).toBe(true);
  });

  it('keeps finished specs when one LLM call fails, and retries only the failure', async () => {
    mockedLlm.mockImplementation(async (opts: { prompt: string }) => {
      if (opts.prompt.includes('SPEC KEY: beta')) throw new Error('rate limit');
      return covered('Alpha works', 'tests/alpha.test.ts');
    });

    const first = await runAlign(makeConfig(), { concurrency: 2 });
    expect(first.report.checkpoint?.complete).toBe(false);
    expect(first.report.entries.map((e) => e.specKey)).toEqual(['my-app/alpha']);

    const partial = JSON.parse(await readFile(path.join(rootDir, '.specguard', 'alignment.json'), 'utf-8'));
    expect(partial.checkpoint.complete).toBe(false);
    expect(partial.entries).toHaveLength(1);

    mockedLlm.mockReset();
    mockedLlm.mockImplementation(async () => covered('Beta works', 'tests/beta.test.ts'));
    const second = await runAlign(makeConfig(), { concurrency: 2 });
    expect(mockedLlm).toHaveBeenCalledTimes(1);
    expect(String(mockedLlm.mock.calls[0][0].prompt)).toContain('SPEC KEY: beta');
    expect(second.report.checkpoint?.complete).toBe(true);
    expect(second.report.entries.map((e) => e.specKey).sort()).toEqual(['my-app/alpha', 'my-app/beta']);
  });

  it('ignores a checkpoint when --fresh is set', async () => {
    mockedLlm.mockResolvedValue(covered('Alpha works', 'tests/alpha.test.ts'));
    await runAlign(makeConfig(), { concurrency: 1 });
    mockedLlm.mockClear();
    await runAlign(makeConfig(), { concurrency: 1, fresh: true });
    expect(mockedLlm).toHaveBeenCalled();
  });
});

describe('runAlign deterministic prepass', () => {
  const CLAIM_SPEC = `# Gamma

<!-- module: my-app/gamma / type: core / status: draft -->

## Acceptance Criteria

- [ ] Gamma awards once <!-- claim: awards-once -->
- [ ] Gamma rejects dupes <!-- claim: rejects-dupes -->

## Scenarios

### Scenario 1: Gamma awards points

**Steps:**
1. Do it

**Expected Results:**
- Awarded

### Scenario 2: Gamma refuses a second award

**Steps:**
1. Do it twice

**Expected Results:**
- Refused
`;

  it('makes no LLM call when claim tags and scenario titles settle everything', async () => {
    await writeFile(path.join(rootDir, 'specs', 'gamma.md'), CLAIM_SPEC);
    await writeFile(
      path.join(rootDir, 'tests', 'gamma.test.ts'),
      [
        "it('gamma awards points @claim:gamma#awards-once', () => {});",
        "it('gamma refuses a second award @claim:gamma#rejects-dupes', () => {});",
      ].join('\n'),
    );
    const result = await runAlign(makeConfig(), { spec: 'gamma' });
    expect(mockedLlm).not.toHaveBeenCalled();
    const entry = result.report.entries[0];
    expect(entry.alignmentScore).toBe(100);
    expect(entry.uncoveredClaims).toEqual([]);
    expect(entry.coveredClaims?.map((c) => c.source)).toEqual(['tag', 'tag']);
  });

  it('sends only uncovered items and only related test files to the LLM', async () => {
    await writeFile(path.join(rootDir, 'specs', 'gamma.md'), CLAIM_SPEC);
    await writeFile(
      path.join(rootDir, 'tests', 'gamma.test.ts'),
      "it('gamma awards points @claim:gamma#awards-once', () => {});\n",
    );
    await writeFile(path.join(rootDir, 'tests', 'unrelated.test.ts'), "it('totally unrelated', () => {});\n");
    mockedLlm.mockResolvedValue({
      coveredScenarios: [],
      uncoveredScenarios: ['Gamma refuses a second award'],
      unmappedTests: [],
      coveredClaims: [],
      uncoveredClaims: ['rejects-dupes'],
    });
    const result = await runAlign(makeConfig(), { spec: 'gamma' });
    expect(mockedLlm).toHaveBeenCalledTimes(1);
    const prompt = mockedLlm.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Gamma refuses a second award');
    expect(prompt).not.toContain('### Scenario 1: Gamma awards points');
    expect(prompt).toContain('rejects-dupes');
    expect(prompt).not.toContain('awards-once: ');
    expect(prompt).toContain('gamma.test.ts');
    expect(prompt).not.toContain('unrelated.test.ts');
    const entry = result.report.entries[0];
    expect(entry.coveredScenarios.map((c) => c.scenario)).toEqual(['Gamma awards points']);
    expect(entry.uncoveredScenarios).toEqual(['Gamma refuses a second award']);
    expect(entry.alignmentScore).toBe(50);
  });
});
