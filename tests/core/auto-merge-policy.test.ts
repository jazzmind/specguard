import { describe, expect, it } from 'vitest';

import { autoMergeDecision, hasRequiredChecks, isManifestFile, majorOf, type AutoMergeInput } from '../../src/core/auto-merge-policy.js';

const ok: AutoMergeInput = {
  configEnabled: true,
  flag: true,
  changeType: 'dependency',
  changedFiles: ['package.json', 'package-lock.json'],
  candidate: { package: 'lodash', fromVersion: '4.17.20', toVersion: '4.17.21', bump: 'patch' },
  verdict: 'PRESERVED',
  verdictReasons: [],
  selectedTests: 4,
  layersNotReproven: [],
  risk: 'low',
  breaking: false,
};
const decide = (over: Partial<AutoMergeInput>) => autoMergeDecision({ ...ok, ...over });

describe('auto-merge policy [auto-merge-policy]', () => {
  // [claims: capabilities/security-and-remediation#auto-merge-policy]
  it('allows a patch bump of manifests and lockfiles that kept every proof', () => {
    expect(decide({})).toEqual({ eligible: true, failed: [] });
    expect(decide({ candidate: { package: 'next', fromVersion: '14.1.0', toVersion: '14.2.0', bump: 'minor' } }).eligible).toBe(true);
  });

  // [claims: capabilities/security-and-remediation#auto-merge-policy]
  it('needs both the config and the flag, and only ever merges dependency fixes', () => {
    expect(decide({ configEnabled: false }).failed[0]).toMatch(/not enabled in .specguard\/config.json/);
    expect(decide({ flag: false }).failed[0]).toMatch(/--auto-merge was not given/);
    expect(decide({ changeType: 'code' }).failed[0]).toMatch(/only dependency fixes/);
  });

  // [claims: capabilities/security-and-remediation#auto-merge-policy]
  it('refuses a change that touches anything but manifests and lockfiles', () => {
    const d = decide({ changedFiles: ['package.json', 'src/index.ts'] });
    expect(d.eligible).toBe(false);
    expect(d.failed.join()).toContain('src/index.ts');
    expect(decide({ changedFiles: [] }).failed.join()).toContain('touches no files');
    for (const f of ['package.json', 'sub/pnpm-lock.yaml', 'requirements-dev.txt', 'go.sum', 'Cargo.lock', 'uv.lock']) expect(isManifestFile(f)).toBe(true);
    for (const f of ['src/package.json.ts', 'README.md', 'requirements.py', 'scripts/install.sh']) expect(isManifestFile(f)).toBe(false);
  });

  // [claims: capabilities/security-and-remediation#auto-merge-policy]
  it('allows patch bumps, minor bumps from 1.0 on, and never major or unknown bumps', () => {
    const bump = (b: AutoMergeInput['candidate']['bump'], to: string) => decide({ candidate: { package: 'x', fromVersion: '1.0.0', toVersion: to, bump: b } });
    expect(bump('patch', '0.3.4').eligible).toBe(true); // a 0.x patch is still a patch
    expect(bump('minor', '1.3.0').eligible).toBe(true);
    expect(bump('minor', '0.4.0').failed.join()).toMatch(/below version 1.0/);
    expect(bump('minor', 'weird').eligible).toBe(false);
    expect(bump('major', '2.0.0').failed.join()).toMatch(/major version bump/);
    expect(bump('unknown', '2.0.0').failed.join()).toMatch(/unknown version bump/);
    expect(decide({ allowMinor: false, candidate: { package: 'x', fromVersion: '1.0.0', toVersion: '1.1.0', bump: 'minor' } }).failed.join()).toMatch(/minor bumps are turned off/);
    expect(decide({ denyPackages: ['lodash'] }).failed.join()).toMatch(/lodash is on remediate.autoMerge.denyPackages/);
    expect(majorOf('v2.1.0-beta.1')).toBe(2);
    expect(majorOf('nope')).toBeUndefined();
  });

  // [claims: capabilities/security-and-remediation#auto-merge-policy]
  it('requires a clean verdict, a selected test, and every layer re-proven', () => {
    expect(decide({ verdict: 'INCONCLUSIVE', verdictReasons: ['flaky: 1 flaky test'] }).failed).toEqual(['the behaviour verdict is INCONCLUSIVE, not PRESERVED', 'verdict reason: flaky: 1 flaky test']);
    expect(decide({ verdict: 'CHANGED' }).eligible).toBe(false);
    expect(decide({ selectedTests: 0 }).failed.join()).toMatch(/no test was selected/);
    const lost = decide({ layersNotReproven: [{ claim: 'capabilities/auth#login', layers: ['e2e', 'functional'] }] });
    expect(lost.eligible).toBe(false);
    expect(lost.failed[0]).toBe('capabilities/auth#login was proven in e2e, functional before the change and not after it');
    expect(decide({ layersNotReproven: Array.from({ length: 8 }, (_, n) => ({ claim: `c#${n}`, layers: ['e2e'] })) }).failed.at(-1)).toBe('3 more claim(s) were not re-proven in a layer');
  });

  // [claims: capabilities/security-and-remediation#auto-merge-policy]
  it('refuses medium or high risk and a flagged breaking change, and lists every failed rule at once', () => {
    expect(decide({ risk: 'medium' }).failed[0]).toBe('risk is medium, not low');
    expect(decide({ breaking: true }).failed[0]).toMatch(/breaking-change analysis/);
    const all = decide({ configEnabled: false, flag: false, changeType: 'code', verdict: 'CHANGED', selectedTests: 0, risk: 'high', breaking: true });
    expect(all.failed.length).toBeGreaterThanOrEqual(7);
  });

  // [claims: capabilities/security-and-remediation#auto-merge-enforcement]
  it('reads branch protection: only a non-empty list of required checks counts', () => {
    expect(hasRequiredChecks('{"strict":true,"contexts":["ci"],"checks":[{"context":"ci"}]}')).toBe(true);
    expect(hasRequiredChecks('{"contexts":[],"checks":[{"context":"build","app_id":1}]}')).toBe(true);
    expect(hasRequiredChecks('{"contexts":[],"checks":[]}')).toBe(false);
    expect(hasRequiredChecks('{"message":"Branch not protected"}')).toBe(false);
    expect(hasRequiredChecks('not json')).toBe(false);
    expect(hasRequiredChecks('')).toBe(false);
  });
});
