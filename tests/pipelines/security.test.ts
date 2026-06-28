import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock the LLM chokepoint so no real network/provider calls occur. The mock
// returns a stub that carries an OWASP annotation comment we assert is kept.
const DEFAULT_TEST_FILE = [
  "import { describe, it, expect } from 'vitest';",
  "describe('security', () => {",
  '  // OWASP A01: Broken Access Control',
  "  it('rejects unauthorized access', () => { expect(true).toBe(true); });",
  '});',
  '',
].join('\n');

vi.mock('../../src/core/llm.js', () => ({
  llmGenerateText: vi.fn(async () => DEFAULT_TEST_FILE),
}));

import { llmGenerateText } from '../../src/core/llm.js';
import { runSecurity, sast } from '../../src/pipelines/security.js';
import type { SpecGuardConfig } from '../../src/core/types.js';
import { ExitCode } from '../../src/core/exit-codes.js';

const mockedLlm = llmGenerateText as unknown as ReturnType<typeof vi.fn>;

let rootDir: string;

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
  '# LLM Adapter',
  '',
  '<!-- module: src/core/llm.ts / type: core / status: draft -->',
  '',
  '## Overview',
  'The LLM adapter.',
  '',
  '## Security Notes',
  'The resolved API key value must never be logged.',
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
  vi.restoreAllMocks();
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'specguard-security-'));
});

describe('runSecurity', () => {
  it('throws when neither --spec nor --all is provided', async () => {
    await expect(runSecurity(makeConfig(), {})).rejects.toThrow();
  });

  it('scenario 1: generates OWASP-annotated stubs from a single spec', async () => {
    await writeSpec('specs/core/llm.md');

    const res = await runSecurity(makeConfig(), { spec: 'core/llm' });

    expect(mockedLlm).toHaveBeenCalledOnce();
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.failed).toBe(0);
    expect(res.exitCode).toBe(0);

    const testPath = path.join(rootDir, 'tests/security/llm.test.ts');
    expect(existsSync(testPath)).toBe(true);
    const content = await readFile(testPath, 'utf-8');
    expect(content).toContain('// OWASP A01: Broken Access Control');
    expect(res.messages.some((m) => m.includes('[gen] specguard-core/llm'))).toBe(true);
  });

  it('scenario 2: --all generates one stub per spec across apps', async () => {
    await writeSpec('specs/core/llm.md');
    await writeSpec('specs/core/reader.md');
    await writeSpec('specs/pipelines/drift.md');

    const res = await runSecurity(makeConfig(), { all: true });

    expect(res.created).toBe(3);
    expect(mockedLlm).toHaveBeenCalledTimes(3);
    expect(existsSync(path.join(rootDir, 'tests/security/llm.test.ts'))).toBe(true);
    expect(existsSync(path.join(rootDir, 'tests/security/reader.test.ts'))).toBe(true);
    expect(existsSync(path.join(rootDir, 'tests/security/drift.test.ts'))).toBe(true);
  });

  it('scenario 3: skips an existing security test file', async () => {
    await writeSpec('specs/core/llm.md');
    await mkdir(path.join(rootDir, 'tests/security'), { recursive: true });
    await writeFile(path.join(rootDir, 'tests/security/llm.test.ts'), '// existing\n', 'utf-8');

    const res = await runSecurity(makeConfig(), { spec: 'core/llm' });

    expect(mockedLlm).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(res.created).toBe(0);
    const content = await readFile(path.join(rootDir, 'tests/security/llm.test.ts'), 'utf-8');
    expect(content).toBe('// existing\n');
    expect(res.messages.some((m) => m.includes('[skip] specguard-core/llm'))).toBe(true);
  });

  it('scenario 4: strips Markdown fences from LLM output', async () => {
    await writeSpec('specs/core/llm.md');
    mockedLlm.mockResolvedValueOnce('```ts\n' + DEFAULT_TEST_FILE + '\n```');

    const res = await runSecurity(makeConfig(), { spec: 'core/llm' });

    expect(res.created).toBe(1);
    const content = await readFile(path.join(rootDir, 'tests/security/llm.test.ts'), 'utf-8');
    expect(content.startsWith('```')).toBe(false);
    expect(content.trimStart().startsWith('import')).toBe(true);
    expect(content).not.toContain('```');
  });

  it('scenario 5: --with-sast with findings sets exitCode 5 and reports them', async () => {
    await writeSpec('specs/core/llm.md');
    const sastSpy = vi.spyOn(sast, 'run').mockResolvedValue({
      ok: true,
      findings: [
        {
          ruleId: 'eval-injection',
          path: 'src/core/llm.ts',
          line: 42,
          message: 'Detected eval of user input',
          severity: 'ERROR',
        },
      ],
    });

    const res = await runSecurity(makeConfig(), { spec: 'core/llm', withSast: true });

    expect(sastSpy).toHaveBeenCalled();
    expect(res.created).toBe(1);
    expect(res.exitCode).toBe(ExitCode.SecurityIssues);
    expect(res.messages.some((m) => m.includes('eval-injection'))).toBe(true);

    // Findings should have been fed into the LLM prompt.
    const promptArg = mockedLlm.mock.calls[0][0] as { prompt: string };
    expect(promptArg.prompt).toContain('eval-injection');
  });

  it('scenario 6: --with-sast when tool unavailable does not throw, exitCode 0', async () => {
    await writeSpec('specs/core/llm.md');
    const sastSpy = vi.spyOn(sast, 'run').mockResolvedValue({ ok: false, findings: [] });

    const res = await runSecurity(makeConfig(), { spec: 'core/llm', withSast: true });

    expect(sastSpy).toHaveBeenCalled();
    expect(res.created).toBe(1);
    expect(res.exitCode).toBe(0);
    expect(res.messages.some((m) => m.includes('[warn] SAST unavailable'))).toBe(true);
  });

  it('scenario 7: LLM error records a failure and continues', async () => {
    await writeSpec('specs/core/llm.md');
    await writeSpec('specs/core/reader.md');
    mockedLlm.mockRejectedValueOnce(new Error('llm boom'));

    const res = await runSecurity(makeConfig(), { all: true, app: 'specguard-core' });

    expect(res.failed).toBe(1);
    expect(res.created).toBe(1);
    const failedItem = res.items.find((i) => i.status === 'failed');
    expect(failedItem?.message).toContain('llm boom');
  });
});
