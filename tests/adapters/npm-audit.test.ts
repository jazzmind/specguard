import { describe, it, expect, vi, beforeEach } from 'vitest';
import { npmAuditRunner, runNpmAudit } from '../../src/adapters/npm-audit.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

const V2_JSON = JSON.stringify({
  vulnerabilities: {
    lodash: {
      severity: 'high',
      via: [{ title: 'Prototype Pollution in lodash', url: 'https://npmjs.com/advisories/1523' }],
    },
    axios: {
      severity: 'moderate',
      via: [{ title: 'Server-Side Request Forgery', url: '' }],
    },
  },
});

const V1_JSON = JSON.stringify({
  advisories: {
    1234: {
      module_name: 'lodash',
      title: 'Prototype Pollution',
      severity: 'high',
    },
  },
});

const CLEAN_JSON = JSON.stringify({ vulnerabilities: {} });

describe('runNpmAudit', () => {
  it('scenario 1: parses v2 format vulnerabilities', async () => {
    vi.spyOn(npmAuditRunner, 'run').mockReturnValue({ stdout: V2_JSON, status: 1 });

    const result = await runNpmAudit('/project');

    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].ruleId).toBe('npm-audit/lodash');
    expect(result.findings[0].path).toBe('package.json');
    expect(result.findings[0].severity).toBe('HIGH');
    expect(result.findings[0].message).toContain('Prototype Pollution');
  });

  it('parses v1 format advisories', async () => {
    vi.spyOn(npmAuditRunner, 'run').mockReturnValue({ stdout: V1_JSON, status: 1 });

    const result = await runNpmAudit('/project');

    expect(result.ok).toBe(true);
    expect(result.findings[0].ruleId).toBe('npm-audit/lodash');
    expect(result.findings[0].message).toBe('Prototype Pollution');
  });

  it('scenario 2: returns empty findings for clean output', async () => {
    vi.spyOn(npmAuditRunner, 'run').mockReturnValue({ stdout: CLEAN_JSON, status: 0 });

    const result = await runNpmAudit('/project');

    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('scenario 3: returns ok:false when npm unavailable', async () => {
    vi.spyOn(npmAuditRunner, 'run').mockReturnValue({
      stdout: null,
      status: null,
      error: new Error('spawn npm ENOENT'),
    });

    const result = await runNpmAudit('/project');

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  it('returns ok:false when output is not valid JSON', async () => {
    vi.spyOn(npmAuditRunner, 'run').mockReturnValue({ stdout: 'not json', status: 1 });

    const result = await runNpmAudit('/project');

    expect(result.ok).toBe(false);
  });

  it('never throws', async () => {
    vi.spyOn(npmAuditRunner, 'run').mockImplementation(() => { throw new Error('unexpected'); });

    await expect(runNpmAudit('/project')).resolves.toEqual({ ok: false, findings: [] });
  });
});
