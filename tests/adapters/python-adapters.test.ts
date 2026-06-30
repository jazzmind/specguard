import { describe, it, expect, vi, afterEach } from 'vitest';

import { runRuff, ruffRunner } from '../../src/adapters/ruff.js';
import { runPipAudit, pipAuditRunner } from '../../src/adapters/pip-audit.js';

afterEach(() => vi.restoreAllMocks());

describe('runRuff', () => {
  it('parses ruff JSON into eslint-shaped findings', async () => {
    vi.spyOn(ruffRunner, 'run').mockReturnValue({
      status: 1,
      stdout: JSON.stringify([
        { filename: '/repo/app/board.py', code: 'F401', message: 'unused import', location: { row: 3, column: 1 } },
      ]),
    });
    const res = await runRuff('/repo');
    expect(res.ok).toBe(true);
    expect(res.errorCount).toBe(1);
    expect(res.findings[0]).toMatchObject({ file: 'app/board.py', ruleId: 'F401', line: 3 });
  });

  it('returns ok:false when ruff is unavailable', async () => {
    vi.spyOn(ruffRunner, 'run').mockReturnValue({ status: null, stdout: null, error: new Error('ENOENT') });
    const res = await runRuff('/repo');
    expect(res.ok).toBe(false);
    expect(res.findings).toEqual([]);
  });
});

describe('runPipAudit', () => {
  it('parses pip-audit JSON (dependencies form) into SAST findings', async () => {
    vi.spyOn(pipAuditRunner, 'run').mockReturnValue({
      status: 1,
      stdout: JSON.stringify({
        dependencies: [
          { name: 'flask', version: '0.5', vulns: [{ id: 'PYSEC-1', description: 'XSS' }] },
          { name: 'safe', version: '1.0', vulns: [] },
        ],
      }),
    });
    const res = await runPipAudit('/repo');
    expect(res.ok).toBe(true);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].ruleId).toBe('pip-audit/flask');
    expect(res.findings[0].message).toContain('PYSEC-1');
  });

  it('returns ok:false when pip-audit is unavailable', async () => {
    vi.spyOn(pipAuditRunner, 'run').mockReturnValue({ status: null, stdout: null, error: new Error('ENOENT') });
    const res = await runPipAudit('/repo');
    expect(res.ok).toBe(false);
  });
});
