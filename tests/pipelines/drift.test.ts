import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { runDrift, driftGit } from '../../src/pipelines/drift.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

let rootDir: string;

/** Config rooted at the temp dir with one app mirroring SpecGuard's own. */
function makeConfig(): SpecGuardConfig {
  return {
    rootDir,
    apps: [
      {
        name: 'specguard-core',
        repo: '.',
        specDir: 'specs/core',
        sources: {
          api: ['src/core/**/*.ts'],
        },
        framework: 'vitest',
        testOutput: 'tests/',
      },
    ],
    llm: { provider: 'anthropic', model: 'claude-test', apiKeyEnv: 'TEST_KEY' },
  };
}

async function writeFileAt(rel: string, content = 'export const x = 1;\n'): Promise<string> {
  const abs = path.join(rootDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
  return abs;
}

/** Set both atime and mtime to a fixed Date. */
async function setMtime(abs: string, date: Date): Promise<void> {
  await utimes(abs, date, date);
}

const OLD = new Date('2020-01-01T00:00:00Z');
const NEW = new Date('2022-01-01T00:00:00Z');

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'specguard-drift-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true });
});

describe('runDrift', () => {
  it('flags drift when the source is newer than its spec (exit 3)', async () => {
    const src = await writeFileAt('src/core/foo.ts');
    const spec = await writeFileAt('specs/core/foo.md', '# Foo\n');
    await setMtime(spec, OLD);
    await setMtime(src, NEW);

    vi.spyOn(driftGit, 'getChangedFiles').mockReturnValue(['src/core/foo.ts']);

    const result = await runDrift(makeConfig());

    expect(result.exitCode).toBe(ExitCode.DriftDetected);
    expect(result.exitCode).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ key: 'specguard-core/foo', status: 'failed' });
    expect(result.messages.some((m) => m.includes('[drift]'))).toBe(true);
  });

  it('reports no drift when the spec is newer than the source (exit 0)', async () => {
    const src = await writeFileAt('src/core/foo.ts');
    const spec = await writeFileAt('specs/core/foo.md', '# Foo\n');
    await setMtime(src, OLD);
    await setMtime(spec, NEW);

    vi.spyOn(driftGit, 'getChangedFiles').mockReturnValue(['src/core/foo.ts']);

    const result = await runDrift(makeConfig());

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.failed).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it('flags drift when a changed source has no spec at all (exit 3)', async () => {
    await writeFileAt('src/core/bar.ts');
    // No specs/core/bar.md written.

    vi.spyOn(driftGit, 'getChangedFiles').mockReturnValue(['src/core/bar.ts']);

    const result = await runDrift(makeConfig());

    expect(result.exitCode).toBe(ExitCode.DriftDetected);
    expect(result.failed).toBe(1);
    expect(result.items[0]).toMatchObject({ key: 'specguard-core/bar', status: 'failed' });
    expect(result.items[0]?.message).toContain('no spec');
  });

  it('ignores changed files that match no source glob', async () => {
    await writeFileAt('README.md', '# readme\n');
    await writeFileAt('src/core/foo.ts');
    await writeFileAt('specs/core/foo.md', '# Foo\n');

    // README is changed but does not match `src/core/**/*.ts`.
    vi.spyOn(driftGit, 'getChangedFiles').mockReturnValue(['README.md']);

    const result = await runDrift(makeConfig());

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.items).toHaveLength(0);
  });

  it('uses the provided `since` ref to build the git range', async () => {
    await writeFileAt('src/core/foo.ts');
    await writeFileAt('specs/core/foo.md', '# Foo\n');

    const spy = vi.spyOn(driftGit, 'getChangedFiles').mockReturnValue([]);

    await runDrift(makeConfig(), { since: 'abc123' });

    expect(spy).toHaveBeenCalledWith('abc123..HEAD', rootDir);
  });

  it('filters to a single spec key via opts.spec', async () => {
    const foo = await writeFileAt('src/core/foo.ts');
    const fooSpec = await writeFileAt('specs/core/foo.md', '# Foo\n');
    const bar = await writeFileAt('src/core/bar.ts');
    const barSpec = await writeFileAt('specs/core/bar.md', '# Bar\n');
    // Both sources are stale.
    await setMtime(fooSpec, OLD);
    await setMtime(foo, NEW);
    await setMtime(barSpec, OLD);
    await setMtime(bar, NEW);

    vi.spyOn(driftGit, 'getChangedFiles').mockReturnValue(['src/core/foo.ts', 'src/core/bar.ts']);

    const result = await runDrift(makeConfig(), { spec: 'specguard-core/foo' });

    expect(result.failed).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.key).toBe('specguard-core/foo');
  });

  it('falls back to scanning all sources when git fails (no throw)', async () => {
    const src = await writeFileAt('src/core/foo.ts');
    const spec = await writeFileAt('specs/core/foo.md', '# Foo\n');
    await setMtime(spec, OLD);
    await setMtime(src, NEW);

    vi.spyOn(driftGit, 'getChangedFiles').mockImplementation(() => {
      throw new Error('fatal: bad revision HEAD~1');
    });

    const result = await runDrift(makeConfig());

    // Drift still detected against the full source set.
    expect(result.exitCode).toBe(ExitCode.DriftDetected);
    expect(result.failed).toBe(1);
    expect(result.messages.some((m) => m.includes('[warn]') && m.includes('falling back'))).toBe(
      true,
    );
  });
});
