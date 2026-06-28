import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile as fsWriteFile, readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const GENERATED_SPEC = `# My Feature

<!-- module:  -->
<!-- type: feature -->
<!-- status: draft -->

## Overview
Feature overview.

## Acceptance Criteria
- AC 1

## Scenarios

### Scenario 1: Basic
**Steps:**
1. Step one

**Expected Results:**
- Works
`;

vi.mock('../../src/core/llm.js', () => ({
  llmGenerateText: vi.fn(async () => GENERATED_SPEC),
}));

import { llmGenerateText } from '../../src/core/llm.js';
import { runImport, fetchUrl } from '../../src/pipelines/import.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

const mockedLlm = llmGenerateText as unknown as ReturnType<typeof vi.fn>;

let rootDir: string;

function makeConfig(): SpecGuardConfig {
  return {
    rootDir,
    apps: [
      {
        name: 'myapp',
        repo: '.',
        specDir: 'specs',
        sources: { api: ['src/**/*.ts'] },
        framework: 'vitest',
        testOutput: 'tests',
      },
    ],
    llm: { provider: 'anthropic', model: 'claude-test', apiKeyEnv: 'TEST_KEY' },
  };
}

const PRD_CONTENT = `# My Feature

This feature allows users to do something useful.

## Requirements
- Users must be able to log in
- Users must see a dashboard
`;

async function writePrd(rel: string, content = PRD_CONTENT): Promise<void> {
  const abs = path.join(rootDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await fsWriteFile(abs, content, 'utf-8');
}

beforeEach(async () => {
  vi.restoreAllMocks();
  mockedLlm.mockReset();
  mockedLlm.mockResolvedValue(GENERATED_SPEC);
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'specguard-import-'));
});

describe('runImport', () => {
  it('scenario 1: imports a Markdown file and creates a spec', async () => {
    await writePrd('docs/feature.md');

    const res = await runImport(makeConfig(), { source: 'docs/feature.md' });

    expect(mockedLlm).toHaveBeenCalledOnce();
    expect(res.created).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.exitCode).toBe(0);

    const promptArg = mockedLlm.mock.calls[0][0] as { prompt: string };
    expect(promptArg.prompt).toContain('My Feature');
  });

  it('scenario 2: skips if spec already exists and --force not set', async () => {
    await writePrd('docs/feature.md');
    await mkdir(path.join(rootDir, 'specs'), { recursive: true });
    await fsWriteFile(path.join(rootDir, 'specs', 'my-feature.md'), '# Existing\n', 'utf-8');

    const res = await runImport(makeConfig(), { source: 'docs/feature.md' });

    expect(mockedLlm).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(res.created).toBe(0);
  });

  it('force overwrites existing spec', async () => {
    await writePrd('docs/feature.md');
    await mkdir(path.join(rootDir, 'specs'), { recursive: true });
    await fsWriteFile(path.join(rootDir, 'specs', 'my-feature.md'), '# Old\n', 'utf-8');

    const res = await runImport(makeConfig(), { source: 'docs/feature.md', force: true });

    expect(res.created).toBe(1);
    const content = await fsReadFile(path.join(rootDir, 'specs', 'my-feature.md'), 'utf-8');
    expect(content).toContain('My Feature');
  });

  it('--out overrides the output path', async () => {
    await writePrd('docs/feature.md');
    const outPath = path.join(rootDir, 'custom-out.md');

    const res = await runImport(makeConfig(), { source: 'docs/feature.md', out: outPath });

    expect(res.created).toBe(1);
    const content = await fsReadFile(outPath, 'utf-8');
    expect(content).toContain('My Feature');
  });

  it('throws when no source provided', async () => {
    await expect(runImport(makeConfig(), { source: '' })).rejects.toThrow();
  });

  it('returns failed when source file not found', async () => {
    const res = await runImport(makeConfig(), { source: 'nonexistent/file.md' });
    expect(res.failed).toBe(1);
    expect(res.exitCode).not.toBe(0);
  });

  it('LLM failure records failed result', async () => {
    await writePrd('docs/feature.md');
    mockedLlm.mockRejectedValueOnce(new Error('LLM down'));

    const res = await runImport(makeConfig(), { source: 'docs/feature.md' });
    expect(res.failed).toBe(1);
    const item = res.items.find((i) => i.status === 'failed');
    expect(item?.message).toContain('LLM down');
  });
});

describe('fetchUrl', () => {
  it('rejects non-http protocols', async () => {
    await expect(fetchUrl('file:///etc/passwd')).rejects.toThrow('Unsupported protocol');
  });
});
