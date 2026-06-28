import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock the LLM chokepoint so no real network/provider calls occur.
vi.mock('../../src/core/llm.js', () => ({
  llmGenerateText: vi.fn(async () => '# Mock Spec\n\n<!-- module: x / type: pipeline / status: draft -->\n\n## Overview\nGenerated.\n'),
}));

import { llmGenerateText } from '../../src/core/llm.js';
import { runReverseGenerate } from '../../src/pipelines/reverse-generate.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

const mockedLlm = llmGenerateText as unknown as ReturnType<typeof vi.fn>;

const DEFAULT_SPEC =
  '# Mock Spec\n\n<!-- module: x / type: pipeline / status: draft -->\n\n## Overview\nGenerated.\n';

let rootDir: string;

/** Build a config rooted at the temp dir with one app. */
function makeConfig(): SpecGuardConfig {
  return {
    rootDir,
    apps: [
      {
        name: 'my-app',
        repo: '.',
        specDir: 'specs/my-app',
        sources: {
          pages: ['src/pages/**/*.tsx'],
        },
        framework: 'vitest',
        testOutput: 'tests/',
      },
    ],
    llm: { provider: 'anthropic', model: 'claude-test', apiKeyEnv: 'TEST_KEY' },
  };
}

async function writeSource(rel: string, content = 'export const x = 1;\n'): Promise<void> {
  const abs = path.join(rootDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

beforeEach(async () => {
  // Reset implementation too — mockRejectedValue persists across clearAllMocks.
  mockedLlm.mockReset();
  mockedLlm.mockResolvedValue(DEFAULT_SPEC);
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'specguard-reverse-'));
});

describe('runReverseGenerate', () => {
  it('throws SpecGuardError for an unknown app', async () => {
    await expect(runReverseGenerate(makeConfig(), { app: 'nope' })).rejects.toThrow();
  });

  it('scenario 1: generates a spec for a new file', async () => {
    await writeSource('src/pages/checkout.tsx');
    const res = await runReverseGenerate(makeConfig(), { app: 'my-app' });

    expect(mockedLlm).toHaveBeenCalledOnce();
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.failed).toBe(0);
    const specPath = path.join(rootDir, 'specs/my-app/checkout.md');
    expect(existsSync(specPath)).toBe(true);
    expect(res.messages.some((m) => m.includes('[gen] my-app/checkout'))).toBe(true);
  });

  it('scenario 2: skips an existing spec without --force', async () => {
    await writeSource('src/pages/checkout.tsx');
    await mkdir(path.join(rootDir, 'specs/my-app'), { recursive: true });
    await writeFile(path.join(rootDir, 'specs/my-app/checkout.md'), '# existing\n', 'utf-8');

    const res = await runReverseGenerate(makeConfig(), { app: 'my-app' });

    expect(mockedLlm).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(res.created).toBe(0);
    // Existing spec untouched.
    const content = await readFile(path.join(rootDir, 'specs/my-app/checkout.md'), 'utf-8');
    expect(content).toBe('# existing\n');
    expect(res.messages.some((m) => m.includes('[skip] my-app/checkout — spec already exists'))).toBe(
      true,
    );
  });

  it('scenario 3: overwrites an existing spec with --force', async () => {
    await writeSource('src/pages/checkout.tsx');
    await mkdir(path.join(rootDir, 'specs/my-app'), { recursive: true });
    await writeFile(path.join(rootDir, 'specs/my-app/checkout.md'), '# existing\n', 'utf-8');

    const res = await runReverseGenerate(makeConfig(), { app: 'my-app', force: true });

    expect(mockedLlm).toHaveBeenCalledOnce();
    expect(res.created).toBe(1);
    const content = await readFile(path.join(rootDir, 'specs/my-app/checkout.md'), 'utf-8');
    expect(content).toContain('Mock Spec');
  });

  it('scenario 4: --file targets a single source file', async () => {
    await writeSource('src/pages/login.tsx');
    await writeSource('src/pages/checkout.tsx');

    const res = await runReverseGenerate(makeConfig(), { app: 'my-app', file: 'src/pages/login.tsx' });

    expect(mockedLlm).toHaveBeenCalledOnce();
    expect(res.created).toBe(1);
    expect(res.items[0].key).toBe('my-app/login');
    expect(existsSync(path.join(rootDir, 'specs/my-app/login.md'))).toBe(true);
    expect(existsSync(path.join(rootDir, 'specs/my-app/checkout.md'))).toBe(false);
  });

  it('scenario 5: missing source file warns and does not throw', async () => {
    const res = await runReverseGenerate(makeConfig(), {
      app: 'my-app',
      file: 'src/pages/missing.tsx',
    });

    expect(mockedLlm).not.toHaveBeenCalled();
    expect(res.created).toBe(0);
    expect(res.failed).toBe(0);
    expect(res.messages.some((m) => m.includes('[warn]') && m.includes('not found'))).toBe(true);
  });

  it('scenario 6: LLM error records a failure and continues', async () => {
    await writeSource('src/pages/a.tsx');
    await writeSource('src/pages/b.tsx');
    mockedLlm.mockRejectedValueOnce(new Error('llm boom'));

    const res = await runReverseGenerate(makeConfig(), { app: 'my-app' });

    // Two files attempted: one fails, one succeeds → pipeline continues.
    expect(res.failed).toBe(1);
    expect(res.created).toBe(1);
    const failedItem = res.items.find((i) => i.status === 'failed');
    expect(failedItem?.message).toContain('llm boom');
    // Not all attempts failed → exit code stays success.
    expect(res.exitCode).toBe(0);
  });

  it('exit code is non-zero when every attempted spec fails', async () => {
    await writeSource('src/pages/a.tsx');
    mockedLlm.mockRejectedValue(new Error('always boom'));

    const res = await runReverseGenerate(makeConfig(), { app: 'my-app' });

    expect(res.created).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.exitCode).not.toBe(0);
  });

  it('warns when source contains secret-like patterns', async () => {
    await writeSource('src/pages/secret.tsx', 'const k = process.env.SECRET;\n');

    const res = await runReverseGenerate(makeConfig(), { app: 'my-app' });

    expect(res.messages.some((m) => m.includes('[warn]') && m.includes('secret'))).toBe(true);
    expect(res.created).toBe(1);
  });
});
