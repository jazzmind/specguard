import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { eslintRunner } from '../../src/plugins/quality/eslint.js';
import { ruffRunner } from '../../src/plugins/quality/ruff.js';
import { knipRunner } from '../../src/plugins/quality/knip.js';
import { runCodeQuality } from '../../src/plugins/quality/code-quality.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

afterEach(() => vi.restoreAllMocks());

const config = (language = 'typescript'): SpecGuardConfig => ({
  rootDir: mkdtempSync(path.join(os.tmpdir(), 'sg-qf-')),
  apps: [{ name: 'a', repo: '.', language, specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 'tests/' }],
  llm: { provider: 'none', model: 'n', apiKeyEnv: 'N' },
});

describe('quality --fix', () => {
  // [claims: capabilities/integration-surfaces#code-quality]
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
