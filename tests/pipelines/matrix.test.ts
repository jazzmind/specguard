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
    // canonical key: relative to the specs root, not to the app's specDir
    expect(entry.specKey).toBe('one/parser');
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

describe('matrix claim linkage', () => {
  it('links claims to tests by tag, honours sources.tests and extraTestSources, and reads result files', async () => {
    const { makeRepo } = await import('../helpers/repo.js');
    const repo = makeRepo();
    repo.write('tests/awards.test.ts', "it('awards once @claim:core/awards#award-once', () => {});\n");
    repo.write('integration/odd-name.spec.ts', "// [claim: core/awards#no-dupes]\nit('dupes', () => {});\n");
    repo.write('elsewhere/more.test.ts', "it('x @claim:core/awards#award-once', () => {});\n");
    repo.write(
      'report.xml',
      '<testsuite name="s"><testcase classname="c" name="t @claim:core/awards#untested" time="0.1"/></testsuite>',
    );
    const { loadConfig } = await import('../../src/core/config.js');
    const config = await loadConfig(repo.dir);
    config.apps[0].sources.tests = ['integration/**/*.spec.ts'];
    config.apps[0].extraTestSources = ['elsewhere/*.test.ts'];
    config.apps[0].specDir = 'specs';
    const result = await runMatrix(config, { results: ['report.xml'], out: 'out/trace.json' });
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import('node:fs');
    const matrix = JSON.parse(readFileSync(path.join(repo.dir, 'out/trace.json'), 'utf8'));
    const entry = matrix.entries.find((e: { specKey: string }) => e.specKey === 'core/awards');
    const byId = Object.fromEntries(entry.claims.map((c: { id: string }) => [c.id, c]));
    expect(byId['award-once'].tests.map((t: { file: string }) => t.file).sort()).toEqual(['elsewhere/more.test.ts', 'tests/awards.test.ts']);
    expect(byId['no-dupes'].tests[0]).toMatchObject({ file: 'integration/odd-name.spec.ts', title: 'dupes' });
    expect(byId['untested'].tests[0]).toMatchObject({ origin: 'result', file: 'report.xml', status: 'pass' });
    expect(entry.tests.map((t: string) => path.basename(t)).sort()).toEqual(['awards.test.ts', 'more.test.ts', 'odd-name.spec.ts']);
  });
});
