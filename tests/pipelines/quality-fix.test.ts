import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { eslintRunner } from '../../src/adapters/eslint.js';
import { ruffRunner } from '../../src/adapters/ruff.js';
import { knipRunner } from '../../src/adapters/knip.js';
import { runCodeQuality } from '../../src/pipelines/code-quality.js';
import { runAnalyze, AUTO_FIX_SAFE } from '../../src/pipelines/analyze.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

afterEach(() => vi.restoreAllMocks());

const config = (language = 'typescript'): SpecGuardConfig => ({
  rootDir: mkdtempSync(path.join(os.tmpdir(), 'sg-qf-')),
  apps: [{ name: 'a', repo: '.', language, specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 'tests/' }],
  llm: { provider: 'none', model: 'n', apiKeyEnv: 'N' },
});

describe('quality --fix', () => {
  it('passes --fix to eslint and to ruff, and only then', async () => {
    const eslint = vi.spyOn(eslintRunner, 'run').mockReturnValue({ stdout: '[]', status: 0 });
    vi.spyOn(knipRunner, 'run').mockReturnValue({ stdout: '{}', status: 0 });
    await runCodeQuality(config(), { fix: true });
    expect(eslint).toHaveBeenLastCalledWith(expect.any(String), { fix: true });
    await runCodeQuality(config(), {});
    expect(eslint).toHaveBeenLastCalledWith(expect.any(String), { fix: undefined });
    const ruff = vi.spyOn(ruffRunner, 'run').mockReturnValue({ stdout: '[]', status: 0 });
    await runCodeQuality(config('python'), { fix: true });
    expect(ruff).toHaveBeenCalledWith(expect.any(String), { fix: true });
  });
});

describe('analyze --auto-fix', () => {
  it('runs only the safe recommended pipelines', () => {
    expect(AUTO_FIX_SAFE).toEqual(['quality', 'matrix']);
  });

  it('runs quality --fix when it is recommended and leaves LLM pipelines as recommendations', async () => {
    const cfg = config();
    // two lint errors make `quality` a recommendation; no specs exist so other recommendations follow
    const eslint = vi.spyOn(eslintRunner, 'run').mockReturnValue({
      status: 1,
      stdout: JSON.stringify([{ filePath: `${cfg.rootDir}/x.ts`, errorCount: 1, warningCount: 0, messages: [{ ruleId: 'no-x', severity: 2, message: 'm', line: 1, column: 1 }] }]),
    });
    vi.spyOn(knipRunner, 'run').mockReturnValue({ stdout: '{}', status: 0 });
    const res = await runAnalyze(cfg, { autoFix: true });
    expect(res.analysisReport.recommendations.some((r) => r.pipeline === 'quality')).toBe(true);
    const fixCall = eslint.mock.calls.find((c) => c[1]?.fix === true);
    expect(fixCall).toBeDefined();
    expect(res.messages.some((m) => m.startsWith('[auto-fix] quality: ran'))).toBe(true);
    // without the flag nothing is run automatically
    eslint.mockClear();
    const plain = await runAnalyze(cfg, {});
    expect(plain.messages.some((m) => m.startsWith('[auto-fix]'))).toBe(false);
  }, 30_000); // runs the real (unmocked) analyze pipelines twice, which spawn git; the 5s default is too tight on loaded CI runners
});
