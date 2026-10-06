import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/core/llm.js', () => ({
  llmGenerateText: vi.fn(async () => "import { it } from 'vitest'; it('x', () => {});\n"),
}));

import { pipAuditRunner, pipSeverity, runPipAudit } from '../../src/adapters/pip-audit.js';
import { npmAuditRunner, runNpmAudit } from '../../src/adapters/npm-audit.js';
import { normalizeAudit } from '../../src/pipelines/dep-check.js';
import { runSecurity, sast, type SecurityReport } from '../../src/pipelines/security.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

afterEach(() => vi.restoreAllMocks());

describe('npm-audit keeps the detail the tool gives', () => {
  it('keeps isDirect, range, fixAvailable and advisory urls', async () => {
    vi.spyOn(npmAuditRunner, 'run').mockReturnValue({
      status: 1,
      stdout: JSON.stringify({
        vulnerabilities: {
          lodash: {
            severity: 'high',
            isDirect: true,
            range: '<4.17.21',
            fixAvailable: { name: 'lodash', version: '4.17.21', isSemVerMajor: false },
            via: [{ title: 'Prototype Pollution', url: 'https://github.com/advisories/GHSA-x' }, 'transitive-name'],
          },
        },
      }),
    });
    const [f] = (await runNpmAudit('/p')).findings;
    expect(f).toMatchObject({
      source: 'npm-audit',
      package: 'lodash',
      isDirect: true,
      range: '<4.17.21',
      fixAvailable: { version: '4.17.21' },
      via: [{ title: 'Prototype Pollution', url: 'https://github.com/advisories/GHSA-x' }],
    });
  });
});

describe('pip-audit keeps fix versions and a real severity', () => {
  it('reads fix_versions, links, and severity from the report', async () => {
    vi.spyOn(pipAuditRunner, 'run').mockReturnValue({
      status: 1,
      stdout: JSON.stringify({
        dependencies: [
          { name: 'flask', version: '0.5', vulns: [
            { id: 'PYSEC-1', description: 'XSS', fix_versions: ['1.0', '2.0'], severity: 'critical', aliases: ['CVE-2020-1'] },
            { id: 'GHSA-aaaa-bbbb-cccc', description: 'DoS', fix_versions: [], cvss: 7.5 },
            { id: 'PYSEC-3', description: 'unrated' },
          ] },
        ],
      }),
    });
    const findings = (await runPipAudit('/p')).findings;
    expect(findings.map((f) => f.severity)).toEqual(['CRITICAL', 'HIGH', 'UNKNOWN']);
    expect(findings[0]).toMatchObject({ fixVersions: ['1.0', '2.0'], package: 'flask', source: 'pip-audit' });
    expect(findings[1].via?.[0].url).toBe('https://github.com/advisories/GHSA-aaaa-bbbb-cccc');
  });

  it('maps severity shapes', () => {
    expect(pipSeverity({ severity: 'moderate' })).toBe('MEDIUM');
    expect(pipSeverity({ severity: '9.8' })).toBe('CRITICAL');
    expect(pipSeverity({ severity: { score: 4.3 } })).toBe('MEDIUM');
    expect(pipSeverity({ severity: [{ type: 'CVSS_V3', score: 2.1 }] })).toBe('LOW');
    expect(pipSeverity({})).toBe('UNKNOWN');
  });
});

describe('dep-check labels findings by their tool', () => {
  it('uses the finding source, else the runner, and rates unknown as medium', () => {
    const out = normalizeAudit(
      [
        { ruleId: 'a', path: 'x', message: 'm', severity: 'UNKNOWN', source: 'pip-audit', fixVersions: ['1'], via: [{ url: 'u' }] },
        { ruleId: 'b', path: 'x', message: 'm', severity: 'HIGH' },
      ],
      'npm-audit',
    );
    expect(out.map((f) => [f.source, f.severity])).toEqual([['pip-audit', 'medium'], ['npm-audit', 'high']]);
    expect(out[0]).toMatchObject({ fixVersions: ['1'], references: ['u'] });
  });
});

describe('security uses the language audit runner and writes its report', () => {
  let root: string;
  const config = (language: string): SpecGuardConfig => ({
    rootDir: root,
    apps: [{ name: 'svc', repo: '.', language, specDir: 'specs', sources: {}, framework: language === 'python' ? 'pytest' : 'vitest', testOutput: 'tests/' }],
    llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'K' },
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'sg-sec-'));
    await mkdir(path.join(root, 'specs'), { recursive: true });
    await writeFile(path.join(root, 'specs/auth.md'), '# Auth\n\n## Overview\nx\n\n## Security Notes\nTokens expire.\n');
    vi.spyOn(sast, 'run').mockResolvedValue({ ok: true, findings: [{ ruleId: 'r1', path: 'a.py', line: 3, message: 'm', severity: 'ERROR' }] });
  });

  it('a Python app is audited with pip-audit, not npm audit', async () => {
    const pip = vi.spyOn(pipAuditRunner, 'run').mockReturnValue({
      status: 1,
      stdout: JSON.stringify([{ name: 'django', version: '2', vulns: [{ id: 'PYSEC-9', description: 'bad', fix_versions: ['3'], severity: 'high' }] }]),
    });
    const npm = vi.spyOn(npmAuditRunner, 'run');
    const res = await runSecurity(config('python'), { all: true, withSast: true });
    expect(pip).toHaveBeenCalled();
    expect(npm).not.toHaveBeenCalled();
    expect(res.messages.some((m) => m.includes('[pip-audit] svc: 1 vulnerable dep'))).toBe(true);
    const report = JSON.parse(await readFile(path.join(root, '.specguard/security.json'), 'utf8')) as SecurityReport;
    expect(report.withSast).toBe(true);
    expect(report.findings.map((f) => f.source)).toEqual(['semgrep', 'pip-audit']);
    expect(report.findings[1].fixVersions).toEqual(['3']);
    expect(report.counts.total).toBe(2);
    expect(report.counts.bySeverity).toEqual({ ERROR: 1, HIGH: 1 });
    expect(report.tests[0].status).toBe('created');
  });

  it('a Go app (no audit runner) skips the dependency scan', async () => {
    const npm = vi.spyOn(npmAuditRunner, 'run');
    const pip = vi.spyOn(pipAuditRunner, 'run');
    const res = await runSecurity(config('go'), { all: true, withSast: true });
    expect(npm).not.toHaveBeenCalled();
    expect(pip).not.toHaveBeenCalled();
    expect(res.messages.some((m) => m.includes('no dependency-audit runner for go'))).toBe(true);
  });

  it('the report exists even without --with-sast', async () => {
    const res = await runSecurity(config('typescript'), { all: true });
    expect(res.exitCode).toBe(0);
    const report = JSON.parse(await readFile(path.join(root, '.specguard/security.json'), 'utf8')) as SecurityReport;
    expect(report.withSast).toBe(false);
    expect(report.findings).toEqual([]);
  });
});
