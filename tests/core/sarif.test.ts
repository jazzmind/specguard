import { describe, expect, it } from 'vitest';

import { planToSarif } from '../../src/core/sarif.js';
import type { RemediationPlan } from '../../src/core/remediation-schema.js';

const item = (over: Record<string, unknown>) => ({
  id: 'i1', title: 'Prototype pollution in lodash', severity: 'high', type: 'dependency', change: 'dependency', summary: 'Upgrade lodash to 4.17.21.',
  findings: [{ id: 'GHSA-1', detector: 'advisory', ruleId: 'GHSA-35jh-r3h4-6jhm', message: 'm', file: 'package.json', line: 12 }],
  claims: ['capabilities/auth#login'], files: ['package.json', 'package-lock.json'], verify: { scope: 'all-proven', claims: [] },
  status: 'open', statusHistory: [], fingerprint: 'fp', capability: 'auth', ...over,
});
const plan = (items: unknown[]): RemediationPlan => ({ version: 1, id: 'scan-1', createdAt: '2026-10-22T00:00:00.000Z', tool: { name: 'specguard', version: '0.3.0' }, items } as unknown as RemediationPlan);

describe('SARIF export [sarif]', () => {
  // [claims: capabilities/security-and-remediation#sarif-export]
  it('turns unresolved items into results with a stable fingerprint, a level and a location', () => {
    const log = planToSarif(plan([item({}), item({ id: 'i2', severity: 'low', findings: [{ id: 'x', detector: 'semgrep', ruleId: 'js.xss', message: 'm', file: 'src/a.ts', line: 3 }], files: ['src/a.ts'], title: 'XSS' })]));
    expect(log.version).toBe('2.1.0');
    const run = log.runs[0];
    expect(run.tool.driver).toMatchObject({ name: 'SpecGuard', version: '0.3.0' });
    expect(run.results).toHaveLength(2);
    expect(run.results[0]).toMatchObject({
      ruleId: 'GHSA-35jh-r3h4-6jhm', level: 'error', partialFingerprints: { 'specguard/planItem/v1': 'i1' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'package.json' }, region: { startLine: 12 } } }, { physicalLocation: { artifactLocation: { uri: 'package-lock.json' } } }],
    });
    expect(run.results[1]).toMatchObject({ level: 'note', locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.ts' }, region: { startLine: 3 } } }] });
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(['GHSA-35jh-r3h4-6jhm', 'js.xss']);
    expect((run.tool.driver.rules[0].properties as Record<string, unknown>)['security-severity']).toBe('8.0');
  });

  // [claims: capabilities/security-and-remediation#sarif-export]
  it('leaves out resolved items so their alerts close, and maps every severity to a level', () => {
    const log = planToSarif(plan([item({ status: 'fixed' }), item({ id: 'v', status: 'verified' }), item({ id: 'w', status: 'wont-fix' })]));
    expect(log.runs[0].results).toEqual([]);
    const levels = ['critical', 'high', 'moderate', 'low', 'info'].map((severity) => (planToSarif(plan([item({ severity })])).runs[0].results[0] as { level: string }).level);
    expect(levels).toEqual(['error', 'error', 'warning', 'note', 'note']);
  });

  // [claims: capabilities/security-and-remediation#sarif-export]
  it('still gives an item with no file or rule a location and a rule id', () => {
    const log = planToSarif(plan([item({ findings: [{ id: 'x', detector: 'spec-review', message: 'm' }], files: [] })]));
    expect(log.runs[0].results[0]).toMatchObject({ ruleId: 'spec-review/dependency', locations: [{ physicalLocation: { artifactLocation: { uri: '.' } } }] });
  });
});
