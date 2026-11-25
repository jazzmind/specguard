import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  findingId,
  findingIdsByKey,
  findingIdsForAdvisories,
  findingIdsFromRemote,
  MAX_FINDING_IDS,
  renderFindingLinksBlock,
  renderFindingTrailers,
  repoSlugFromRemote,
} from '../../src/pipelines/remediate/finding-links.js';

const FP = '3f9a1c0e7b2d';
const ID = `sg:example-org/example-app:${FP}`;

describe('finding links [finding-links]', () => {
  // [claims: capabilities/security-and-remediation#finding-links]
  it('builds sg:owner/repo:fingerprint from each origin URL form, lower-cases the slug, and rejects one it cannot parse', () => {
    expect(findingId('example-org/example-app', FP)).toBe(ID);
    expect(findingId('Example-Org/Example-App', FP)).toBe(ID);
    expect(repoSlugFromRemote('git@host:example-org/example-app.git')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('git@host:example-org/example-app')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('git@host:Example-Org/Example-App.git')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('https://host/example-org/example-app.git')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('https://host/example-org/example-app')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('https://host/example-org/example-app.git/')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('https://host/Example-Org/Example-App.git')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('ssh://git@host/example-org/example-app.git')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('ssh://git@host/example-org/example-app')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('ssh://git@host:22/example-org/example-app.git')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('ssh://git@host:22/Example-Org/Example-App.git')).toBe('example-org/example-app');
    for (const url of [
      '/tmp/origin.git',
      'not a url',
      'https://host/example-org/example-app/extra',
      'http://host/example-org/example-app.git',
      'ssh://git@host:abc/example-org/example-app.git',
      'https://host/./example-app.git',
      'https://host/example-org/..',
      'https://host/../example-app.git',
      'git@host:../example-app.git',
      'git@host:example-org/..',
      'ssh://git@host/./example-app.git',
      'ssh://git@host:22/example-org/../other.git',
      '',
    ]) {
      expect(repoSlugFromRemote(url), url).toBeUndefined();
    }
    expect(findingId('.', FP)).toBeUndefined();
    expect(findingId('../example-app', FP)).toBeUndefined();
    expect(findingId('example-org/..', FP)).toBeUndefined();
  });

  // [claims: capabilities/security-and-remediation#finding-links]
  it('renders one trailer per id after a blank line, and the same ids as a JSON array in the body block', () => {
    expect(renderFindingTrailers([ID])).toBe(`\n\nResolves-Finding: ${ID}\n`);
    expect(renderFindingLinksBlock([ID])).toBe(`<!-- finding-links\n["${ID}"]\n-->\n`);
    const second = 'sg:example-org/example-app:aaaaaaaaaaaa';
    expect(renderFindingTrailers([second, ID])).toBe(`\n\nResolves-Finding: ${ID}\nResolves-Finding: ${second}\n`);
    expect(renderFindingLinksBlock([second, ID])).toBe(`<!-- finding-links\n["${ID}","${second}"]\n-->\n`);
    expect(renderFindingTrailers([`sg:Example-Org/Example-App:${FP}`])).toBe(`\n\nResolves-Finding: ${ID}\n`);
  });

  // [claims: capabilities/security-and-remediation#finding-links]
  it('keeps at most 50 ids, drops duplicates, and writes them in a stable order', () => {
    const fingerprints = ['aaaaaa', 'bbbbbb', 'aaaaaa', ...Array.from({ length: 60 }, (_, n) => n.toString(16).padStart(6, '0'))];
    const linked = findingIdsFromRemote('https://host/example-org/example-app', fingerprints);
    const all = [...new Set(fingerprints.map((fp) => findingId('example-org/example-app', fp)!))].sort();
    expect(linked.ids).toEqual(all.slice(0, MAX_FINDING_IDS));
    expect(linked.ids).toHaveLength(50);
    expect(linked.reason).toBeUndefined();
    expect(linked.dropped).toBeUndefined();
    expect(renderFindingTrailers(linked.ids ?? []).match(/Resolves-Finding:/g)).toHaveLength(50);
    expect(renderFindingLinksBlock(['sg:example-org/example-app:bbbbbb', 'sg:example-org/example-app:aaaaaa', 'sg:example-org/example-app:aaaaaa'])).toBe(
      '<!-- finding-links\n["sg:example-org/example-app:aaaaaa","sg:example-org/example-app:bbbbbb"]\n-->\n',
    );
  });

  // [claims: capabilities/security-and-remediation#finding-links]
  it('drops a fingerprint that could forge a trailer or close the comment, and git sees only well-formed Resolves-Finding trailers', () => {
    const newline = `${FP}\nSigned-off-by: forged`;
    const comment = '3f9a1c-->';
    const quoted = 'abcdef"';
    const linked = findingIdsFromRemote('git@host:example-org/example-app.git', [FP, newline, comment, quoted]);
    expect(linked.dropped).toBe(true);
    expect(linked.ids).toEqual([ID]);
    expect(JSON.stringify(linked)).not.toContain('Signed-off-by');
    expect(JSON.stringify(linked)).not.toContain('-->');
    expect(JSON.stringify(linked)).not.toContain('abcdef"');
    const rendered = renderFindingTrailers([ID, `sg:example-org/example-app:${newline}`, `sg:example-org/example-app:${comment}`, `sg:example-org/example-app:${quoted}`]);
    expect(rendered).toBe(`\n\nResolves-Finding: ${ID}\n`);
    expect(renderFindingLinksBlock([ID, `sg:example-org/example-app:${comment}`, `sg:example-org/example-app:${quoted}`])).toBe(`<!-- finding-links\n["${ID}"]\n-->\n`);
    const message = `fix(deps): bump example 1.0.0 -> 1.0.1 (GHSA-1)\n\nSpecGuard remediate run rem-1. Verdict: PRESERVED.\n${rendered}`;
    const parsed = spawnSync('git', ['interpret-trailers', '--parse'], { input: message, encoding: 'utf8' });
    expect(parsed.status).toBe(0);
    expect(parsed.stdout).toBe(`Resolves-Finding: ${ID}\n`);
    expect(parsed.stdout).not.toContain('Signed-off-by');
    expect(parsed.stdout).not.toContain('-->');
    expect(parsed.stdout).not.toContain('"');
  });

  // [claims: capabilities/security-and-remediation#finding-links]
  it('writes nothing when no fingerprint is supplied, and a reason instead of ids when origin cannot be used', () => {
    const message = 'fix(deps): bump example 1.0.0 -> 1.0.1 (GHSA-1)\n\nSpecGuard remediate run rem-1. Verdict: PRESERVED.\nA person reviews and merges unless the auto-merge policy allowed it (see the pull request comment).';
    const body = '## SpecGuard remediation: PRESERVED\n\nA person reviews and merges.\n';
    expect(message + renderFindingTrailers(undefined)).toBe(message);
    expect(body + renderFindingLinksBlock(undefined)).toBe(body);
    expect(message + renderFindingTrailers([])).toBe(message);
    expect(body + renderFindingLinksBlock([])).toBe(body);

    const absent = findingIdsFromRemote(undefined, [FP]);
    expect(absent.ids).toBeUndefined();
    expect(absent.reason).toBe('finding links omitted: the origin remote could not be read');
    const blank = findingIdsFromRemote('   ', [FP]);
    expect(blank.reason).toBe('finding links omitted: the origin remote could not be read');
    const unparsed = findingIdsFromRemote('/tmp/origin.git', [FP]);
    expect(unparsed.ids).toBeUndefined();
    expect(unparsed.reason).toBe('finding links omitted: the origin remote URL could not be parsed');
    expect(findingIdsFromRemote('git@host:example-org/example-app.git', [])).toEqual({});
    expect(findingIdsFromRemote('git@host:example-org/example-app.git', ['  '])).toEqual({});
  });

  // [claims: capabilities/security-and-remediation#finding-links]
  it('keeps each plan item\'s id under its own key, and a remediate item not in the map gets none', () => {
    const other = 'bbbbbb222222';
    const linked = findingIdsByKey('ssh://git@host:22/Example-Org/Example-App.git', [
      { key: 'GHSA-test-vuln-0001', fingerprint: FP },
      { key: 'GHSA-test-vuln-0002', fingerprint: other },
      { key: 'GHSA-test-broke-0004', fingerprint: 'cccccc\nForged: x' },
    ]);
    expect(linked.reason).toBeUndefined();
    expect(linked.dropped).toBe(true);
    expect(linked.byItem).toEqual({
      'GHSA-test-vuln-0001': [ID],
      'GHSA-test-vuln-0002': [`sg:example-org/example-app:${other}`],
    });
    expect(JSON.stringify(linked)).not.toContain('Forged');
    expect(findingIdsForAdvisories(linked.byItem, ['GHSA-test-vuln-0001']).ids).toEqual([ID]);
    expect(findingIdsForAdvisories(linked.byItem, ['GHSA-test-extra-0005'])).toEqual({ ids: [], dropped: false });
    expect(findingIdsForAdvisories(undefined, ['GHSA-test-vuln-0001'])).toEqual({ ids: [], dropped: false });
  });
});
