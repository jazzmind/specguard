import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyIgnore,
  dedupeAdvisories,
  loadIgnoreFile,
  meetsThreshold,
  normalizeSeverity,
  sortAdvisories,
  severityFromCvss,
  type Advisory,
} from '../../src/core/advisory.js';
import { RemediateExit, remediateExitLabel } from '../../src/core/exit-codes.js';

const adv = (over: Partial<Advisory> = {}): Advisory => ({
  id: 'GHSA-aaaa',
  aliases: [],
  ecosystem: 'npm',
  package: 'lodash',
  installedVersion: '4.17.20',
  vulnerableRange: '<4.17.21',
  fixedVersions: ['4.17.21'],
  severity: 'high',
  direct: true,
  dependencyPath: [],
  source: 'npm-audit',
  ...over,
});

describe('advisory', () => {
  it('orders severities and thresholds', () => {
    // claim: severity-order
    expect(meetsThreshold('critical', 'high')).toBe(true);
    expect(meetsThreshold('high', 'high')).toBe(true);
    expect(meetsThreshold('moderate', 'high')).toBe(false);
    expect(meetsThreshold('unknown', 'high')).toBe(true); // fail closed
    expect(meetsThreshold('unknown', 'critical')).toBe(false);
    expect(normalizeSeverity('MEDIUM')).toBe('moderate');
    expect(severityFromCvss(9.8)).toBe('critical');
  });

  it('merges by shared alias and keeps highest severity', () => {
    // claim: dedupe-merge
    const merged = dedupeAdvisories([
      adv({ id: 'GHSA-aaaa', aliases: ['CVE-1'], severity: 'moderate', source: 'npm-audit' }),
      adv({ id: 'CVE-1', aliases: [], severity: 'critical', fixedVersions: ['4.17.22'], source: 'osv-scanner' }),
      adv({ id: 'GHSA-zzzz', package: 'other' }),
    ]);
    expect(merged).toHaveLength(2);
    const m = merged.find((a) => a.package === 'lodash')!;
    expect(m.severity).toBe('critical');
    expect(m.aliases).toContain('CVE-1');
    expect(m.fixedVersions.sort()).toEqual(['4.17.21', '4.17.22']);
    expect(m.source).toBe('npm-audit,osv-scanner');
  });

  it('does not merge different ecosystems', () => {
    expect(dedupeAdvisories([adv(), adv({ ecosystem: 'pip' })])).toHaveLength(2);
  });

  it('sorts deterministically', () => {
    // claim: advisory-sort
    const sorted = sortAdvisories([adv({ id: 'b', severity: 'low' }), adv({ id: 'a', severity: 'critical' }), adv({ id: 'c', severity: 'critical', package: 'aaa' })]);
    expect(sorted.map((a) => a.id)).toEqual(['c', 'a', 'b']);
  });

  it('applies ignore entries by id or alias, only while unexpired', () => {
    // claim: ignore-match
    // claim: ignore-expiry
    const now = new Date('2026-10-06T00:00:00Z');
    const list = [adv({ id: 'GHSA-aaaa', aliases: ['CVE-1'] }), adv({ id: 'GHSA-bbbb' }), adv({ id: 'GHSA-cccc' }), adv({ id: 'GHSA-dddd' })];
    const { kept, suppressed } = applyIgnore(
      list,
      [
        { id: 'cve-1', reason: 'n/a', expires: '2027-01-01' },
        { id: 'GHSA-bbbb', reason: 'expired', expires: '2026-01-01' },
        { id: 'GHSA-cccc', reason: 'no expiry' },
        { id: 'GHSA-dddd', reason: 'bad', expires: 'soon' },
      ],
      now,
    );
    expect(suppressed.map((s) => s.advisory.id)).toEqual(['GHSA-aaaa']);
    expect(kept.map((a) => a.id)).toEqual(['GHSA-bbbb', 'GHSA-cccc', 'GHSA-dddd']);
  });

  it('loads and validates the ignore file', () => {
    // claim: ignore-malformed
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-ign-'));
    expect(loadIgnoreFile(dir)).toEqual([]);
    mkdirSync(path.join(dir, '.specguard'));
    writeFileSync(path.join(dir, '.specguard/vuln-ignore.json'), '{"ignore":[{"id":"X","reason":"r","expires":"2099-01-01"}]}');
    expect(loadIgnoreFile(dir)).toHaveLength(1);
    writeFileSync(path.join(dir, '.specguard/vuln-ignore.json'), '{nope');
    expect(() => loadIgnoreFile(dir)).toThrow(/vuln-ignore\.json/);
  });
});

describe('remediate exit codes', () => {
  it('maps', () => {
    // claim: exit-map
    expect([RemediateExit.Preserved, RemediateExit.Changed, RemediateExit.Inconclusive, RemediateExit.SetupError]).toEqual([8, 9, 10, 11]);
    expect(remediateExitLabel(9)).toBe('changed');
    expect(remediateExitLabel(5)).toBe('security issues');
  });
});
