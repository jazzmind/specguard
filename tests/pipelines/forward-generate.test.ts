import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock the LLM chokepoint so no real network/provider calls occur.
const DEFAULT_TEST_FILE =
  "import {describe,it,expect} from 'vitest'; describe('x',()=>{it('s1',()=>{expect(1).toBe(1)})})";

vi.mock('../../src/core/llm.js', () => ({
  llmGenerateText: vi.fn(async () => DEFAULT_TEST_FILE),
}));

import { llmGenerateText } from '../../src/core/llm.js';
import { runForwardGenerate } from '../../src/pipelines/forward-generate.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

const mockedLlm = llmGenerateText as unknown as ReturnType<typeof vi.fn>;

let rootDir: string;

/** Build a config rooted at the temp dir with two apps. */
function makeConfig(): SpecGuardConfig {
  return {
    rootDir,
    apps: [
      {
        name: 'specguard-core',
        repo: '.',
        specDir: 'specs/core',
        sources: { api: ['src/core/**/*.ts'] },
        framework: 'vitest',
        testOutput: 'tests/core/',
      },
      {
        name: 'specguard-pipelines',
        repo: '.',
        specDir: 'specs/pipelines',
        sources: { api: ['src/pipelines/**/*.ts'] },
        framework: 'vitest',
        testOutput: 'tests/pipelines/',
      },
    ],
    llm: { provider: 'anthropic', model: 'claude-test', apiKeyEnv: 'TEST_KEY' },
  };
}

const SPEC_BODY = [
  '# Spec Parser',
  '',
  '<!-- module: src/core/spec-parser.ts / type: core / status: draft -->',
  '',
  '## Overview',
  'Parses specs.',
  '',
  '## Scenarios',
  '',
  '### Scenario 1: parses a title',
  '**Steps:**',
  '1. Call the parser',
  '',
  '**Expected Results:**',
  '- Title is returned',
  '',
].join('\n');

async function writeSpec(rel: string, content = SPEC_BODY): Promise<void> {
  const abs = path.join(rootDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

beforeEach(async () => {
  mockedLlm.mockReset();
  mockedLlm.mockResolvedValue(DEFAULT_TEST_FILE);
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'specguard-forward-'));
});

describe('runForwardGenerate', () => {
  it('throws when neither --spec nor --all is provided', async () => {
    await expect(runForwardGenerate(makeConfig(), {})).rejects.toThrow();
  });

  it('scenario 1: generates a test from a single spec via --spec', async () => {
    await writeSpec('specs/core/spec-parser.md');

    const res = await runForwardGenerate(makeConfig(), { spec: 'core/spec-parser' });

    expect(mockedLlm).toHaveBeenCalledOnce();
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.failed).toBe(0);
    const testPath = path.join(rootDir, 'tests/core/spec-parser.test.ts');
    expect(existsSync(testPath)).toBe(true);
    expect(res.messages.some((m) => m.includes('[gen] specguard-core/spec-parser'))).toBe(true);
  });

  it('scenario 2: --all processes multiple specs across apps', async () => {
    await writeSpec('specs/core/spec-parser.md');
    await writeSpec('specs/core/reader.md');
    await writeSpec('specs/pipelines/drift.md');

    const res = await runForwardGenerate(makeConfig(), { all: true });

    expect(res.created).toBe(3);
    expect(mockedLlm).toHaveBeenCalledTimes(3);
    expect(existsSync(path.join(rootDir, 'tests/core/spec-parser.test.ts'))).toBe(true);
    expect(existsSync(path.join(rootDir, 'tests/core/reader.test.ts'))).toBe(true);
    expect(existsSync(path.join(rootDir, 'tests/pipelines/drift.test.ts'))).toBe(true);
  });

  it('scenario 3: skips an existing test file without --force', async () => {
    await writeSpec('specs/core/spec-parser.md');
    await mkdir(path.join(rootDir, 'tests/core'), { recursive: true });
    await writeFile(path.join(rootDir, 'tests/core/spec-parser.test.ts'), '// existing\n', 'utf-8');

    const res = await runForwardGenerate(makeConfig(), { spec: 'core/spec-parser' });

    expect(mockedLlm).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(res.created).toBe(0);
    const content = await readFile(path.join(rootDir, 'tests/core/spec-parser.test.ts'), 'utf-8');
    expect(content).toBe('// existing\n');
    expect(res.messages.some((m) => m.includes('[skip] specguard-core/spec-parser'))).toBe(true);
  });

  it('scenario 4: overwrites an existing test file with --force', async () => {
    await writeSpec('specs/core/spec-parser.md');
    await mkdir(path.join(rootDir, 'tests/core'), { recursive: true });
    await writeFile(path.join(rootDir, 'tests/core/spec-parser.test.ts'), '// existing\n', 'utf-8');

    const res = await runForwardGenerate(makeConfig(), { spec: 'core/spec-parser', force: true });

    expect(mockedLlm).toHaveBeenCalledOnce();
    expect(res.created).toBe(1);
    const content = await readFile(path.join(rootDir, 'tests/core/spec-parser.test.ts'), 'utf-8');
    expect(content).toContain('expect(1).toBe(1)');
  });

  it('scenario 6: strips Markdown fences from LLM output', async () => {
    await writeSpec('specs/core/spec-parser.md');
    mockedLlm.mockResolvedValueOnce('```ts\n' + DEFAULT_TEST_FILE + '\n```');

    const res = await runForwardGenerate(makeConfig(), { spec: 'core/spec-parser' });

    expect(res.created).toBe(1);
    const content = await readFile(path.join(rootDir, 'tests/core/spec-parser.test.ts'), 'utf-8');
    expect(content.startsWith('```')).toBe(false);
    expect(content.trimStart().startsWith('import')).toBe(true);
    expect(content).not.toContain('```');
  });

  it('scenario 7: LLM error records a failure and continues', async () => {
    await writeSpec('specs/core/spec-parser.md');
    await writeSpec('specs/core/reader.md');
    mockedLlm.mockRejectedValueOnce(new Error('llm boom'));

    const res = await runForwardGenerate(makeConfig(), { all: true, app: 'specguard-core' });

    expect(res.failed).toBe(1);
    expect(res.created).toBe(1);
    const failedItem = res.items.find((i) => i.status === 'failed');
    expect(failedItem?.message).toContain('llm boom');
    expect(res.exitCode).toBe(0);
  });

  it('exit code is non-zero when every attempted spec fails', async () => {
    await writeSpec('specs/core/spec-parser.md');
    mockedLlm.mockRejectedValue(new Error('always boom'));

    const res = await runForwardGenerate(makeConfig(), { spec: 'core/spec-parser' });

    expect(res.created).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.exitCode).not.toBe(0);
  });
});
