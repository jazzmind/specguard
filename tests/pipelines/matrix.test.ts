import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runMatrix } from '../../src/pipelines/matrix.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

const SPEC_CONTENT = (title: string) => `# ${title}

<!-- module: src/core/${title.toLowerCase()}.ts -->
<!-- type: core -->
<!-- status: stable -->

## Overview
${title} overview.

## Acceptance Criteria
- AC 1

## Scenarios

### Scenario 1: Basic
**Steps:**
1. Call the function

**Expected Results:**
- Works correctly
`;

let rootDir: string;

function makeConfig(): SpecGuardConfig {
  return {
    rootDir,
    apps: [
      {
        name: 'app-one',
        repo: '.',
        specDir: 'specs/one',
        sources: { api: ['src/one/**/*.ts'] },
        framework: 'vitest',
        testOutput: 'tests/one',
      },
      {
        name: 'app-two',
        repo: '.',
        specDir: 'specs/two',
        sources: { api: ['src/two/**/*.ts'] },
        framework: 'vitest',
        testOutput: 'tests/two',
      },
    ],
    llm: { provider: 'anthropic', model: 'claude-test', apiKeyEnv: 'TEST_KEY' },
    matrix: { format: 'json', output: '.specguard/traceability.json' },
  };
}

async function writeSpec(rel: string, title: string): Promise<void> {
  const abs = path.join(rootDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, SPEC_CONTENT(title), 'utf-8');
}

async function writeTestFile(rel: string): Promise<void> {
  const abs = path.join(rootDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, '// test file\n', 'utf-8');
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'specguard-matrix-'));
});

describe('runMatrix', () => {
  it('scenario 1: builds matrix for all apps', async () => {
    await writeSpec('specs/one/parser.md', 'Parser');
    await writeSpec('specs/two/validator.md', 'Validator');

    const res = await runMatrix(makeConfig(), {});

    expect(res.exitCode).toBe(0);
    expect(res.created).toBe(2);
    expect(res.messages.some((m) => m.includes('parser'))).toBe(true);
    expect(res.messages.some((m) => m.includes('validator'))).toBe(true);
    // Traceability JSON written
    expect(res.messages.some((m) => m.includes('traceability.json'))).toBe(true);
  });

  it('scenario 2: csv format output', async () => {
    await writeSpec('specs/one/parser.md', 'Parser');

    const res = await runMatrix(makeConfig(), { format: 'csv' });

    expect(res.exitCode).toBe(0);
    expect(res.messages.some((m) => m.includes('.csv'))).toBe(true);
  });

  it('scenario 3: spec with no matching test has tests: []', async () => {
    await writeSpec('specs/one/parser.md', 'Parser');

    const outPath = path.join(rootDir, 'traceability.json');
    await runMatrix(makeConfig(), { out: outPath, format: 'json' });

    const { readFile } = await import('node:fs/promises');
    const content = JSON.parse(await readFile(outPath, 'utf-8'));
    const entry = content.entries[0];
    expect(entry.tests).toEqual([]);
    expect(entry.specKey).toBe('parser');
  });

  it('finds matching test file by basename convention', async () => {
    await writeSpec('specs/one/parser.md', 'Parser');
    await writeTestFile('tests/one/parser.test.ts');

    const outPath = path.join(rootDir, 'traceability.json');
    await runMatrix(makeConfig(), { out: outPath, format: 'json' });

    const { readFile } = await import('node:fs/promises');
    const content = JSON.parse(await readFile(outPath, 'utf-8'));
    const entry = content.entries[0];
    expect(entry.tests.length).toBeGreaterThan(0);
    expect(entry.tests[0]).toContain('parser.test.ts');
  });

  it('--app scopes to single app', async () => {
    await writeSpec('specs/one/parser.md', 'Parser');
    await writeSpec('specs/two/validator.md', 'Validator');

    const res = await runMatrix(makeConfig(), { app: 'app-one' });

    expect(res.created).toBe(1);
    expect(res.messages.some((m) => m.includes('parser'))).toBe(true);
    expect(res.messages.some((m) => m.includes('validator'))).toBe(false);
  });

  it('throws for unknown --app', async () => {
    await expect(runMatrix(makeConfig(), { app: 'nonexistent' })).rejects.toThrow('Unknown app');
  });
});
