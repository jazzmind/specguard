import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { runStatus } from '../../src/pipelines/status.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

let rootDir: string;

/** Build a config rooted at the temp dir with one app. */
function makeConfig(): SpecGuardConfig {
  return {
    rootDir,
    apps: [
      {
        name: 'core',
        repo: '.',
        specDir: 'specs/core',
        sources: {
          api: ['src/core/**/*.ts'],
          tests: ['tests/core/**/*.test.ts'],
        },
        framework: 'vitest',
        testOutput: 'tests/core/',
      },
    ],
    llm: { provider: 'anthropic', model: 'claude-test', apiKeyEnv: 'TEST_KEY' },
  };
}

async function writeRel(rel: string, content = 'export const x = 1;\n'): Promise<void> {
  const abs = path.join(rootDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'specguard-status-'));
});

describe('runStatus', () => {
  it('scenario 1: exit 0 when all source files have specs', async () => {
    await writeRel('src/core/a.ts');
    await writeRel('src/core/b.ts');
    await writeRel('specs/core/a.md', '# A\n');
    await writeRel('specs/core/b.md', '# B\n');

    const res = await runStatus(makeConfig());

    expect(res.items).toHaveLength(2);
    expect(res.items.every((i) => i.status === 'ok')).toBe(true);
    expect(res.failed).toBe(0);
    expect(res.exitCode).toBe(ExitCode.Success);
    expect(res.messages.some((m) => m.includes('TOTAL: 2 source files, 2 specs (100%)'))).toBe(true);
  });

  it('scenario 2: exit 4 when a spec is missing', async () => {
    await writeRel('src/core/a.ts');
    await writeRel('src/core/b.ts');
    await writeRel('specs/core/a.md', '# A\n');
    // No spec for b.

    const res = await runStatus(makeConfig());

    expect(res.failed).toBe(1);
    expect(res.exitCode).toBe(ExitCode.MissingSpecs);

    const aItem = res.items.find((i) => i.key === 'core/a');
    const bItem = res.items.find((i) => i.key === 'core/b');
    expect(aItem?.status).toBe('ok');
    expect(bItem?.status).toBe('failed');
    expect(bItem?.message).toContain('missing spec');
    expect(res.messages.some((m) => m.includes('missing specs: b'))).toBe(true);
    expect(res.messages.some((m) => m.includes('1 specs (50%)'))).toBe(true);
  });

  it('scenario 3: reports test coverage', async () => {
    await writeRel('src/core/a.ts');
    await writeRel('specs/core/a.md', '# A\n');
    await writeRel('tests/core/a.test.ts', '');

    const res = await runStatus(makeConfig());

    expect(res.exitCode).toBe(ExitCode.Success);
    const aItem = res.items.find((i) => i.key === 'core/a');
    expect(aItem?.status).toBe('ok');
    expect(aItem?.message).toBeUndefined();
    expect(res.messages.some((m) => m.includes('1 tests (100%)'))).toBe(true);
  });

  it('scenario 4: excludes the tests group from the needs-a-spec set', async () => {
    await writeRel('src/core/a.ts');
    await writeRel('specs/core/a.md', '# A\n');
    // A test file that matches the `tests` group — must NOT count as a source file.
    await writeRel('tests/core/a.test.ts', '');

    const res = await runStatus(makeConfig());

    // Only the single src file is counted as a feature needing a spec.
    expect(res.items).toHaveLength(1);
    expect(res.items[0].key).toBe('core/a');
    expect(res.exitCode).toBe(ExitCode.Success);
  });

  it('scenario 5: empty repo reports zero and exit 0', async () => {
    const res = await runStatus(makeConfig());

    expect(res.items).toHaveLength(0);
    expect(res.failed).toBe(0);
    expect(res.exitCode).toBe(ExitCode.Success);
    expect(res.messages.some((m) => m.includes('TOTAL: 0 source files'))).toBe(true);
  });
});
