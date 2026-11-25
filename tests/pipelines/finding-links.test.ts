import { describe, expect, it } from 'vitest';

import {
  findingId,
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
  it('builds sg:owner/repo:fingerprint from both origin URL forms, and rejects one it cannot parse', () => {
    expect(findingId('example-org/example-app', FP)).toBe(ID);
    expect(repoSlugFromRemote('git@host:example-org/example-app.git')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('git@host:example-org/example-app')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('https://host/example-org/example-app.git')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('https://host/example-org/example-app')).toBe('example-org/example-app');
    expect(repoSlugFromRemote('https://host/example-org/example-app.git/')).toBe('example-org/example-app');
    for (const url of ['/tmp/origin.git', 'not a url', 'ssh://git@host/example-org/example-app.git', 'https://host/example-org/example-app/extra', 'http://host/example-org/example-app.git', '']) {
      expect(repoSlugFromRemote(url)).toBeUndefined();
    }
  });

  // [claims: capabilities/security-and-remediation#finding-links]
  it('renders one trailer per id after a blank line, and the same ids as a JSON array in the body block', () => {
    expect(renderFindingTrailers([ID])).toBe(`\n\nResolves-Finding: ${ID}\n`);
    expect(renderFindingLinksBlock([ID])).toBe(`<!-- finding-links\n["${ID}"]\n-->\n`);
    const second = 'sg:example-org/example-app:aaaaaaaaaaaa';
    expect(renderFindingTrailers([second, ID])).toBe(`\n\nResolves-Finding: ${ID}\nResolves-Finding: ${second}\n`);
    expect(renderFindingLinksBlock([second, ID])).toBe(`<!-- finding-links\n["${ID}","${second}"]\n-->\n`);
  });

  // [claims: capabilities/security-and-remediation#finding-links]
  it('keeps at most 50 ids, drops duplicates, and writes them in a stable order', () => {
    const fingerprints = ['m', 'a', 'm', 'b', ...Array.from({ length: 60 }, (_, n) => n.toString(16).padStart(2, '0'))];
    const linked = findingIdsFromRemote('https://host/example-org/example-app', fingerprints);
    const all = [...new Set(fingerprints.map((fp) => findingId('example-org/example-app', fp)))].sort();
    expect(linked.ids).toEqual(all.slice(0, MAX_FINDING_IDS));
    expect(linked.ids).toHaveLength(50);
    expect(linked.reason).toBeUndefined();
    expect(renderFindingTrailers(linked.ids ?? []).match(/Resolves-Finding:/g)).toHaveLength(50);
    // Input order and duplicates do not change the block.
    expect(renderFindingLinksBlock(['sg:example-org/example-app:b', 'sg:example-org/example-app:a', 'sg:example-org/example-app:a'])).toBe(
      '<!-- finding-links\n["sg:example-org/example-app:a","sg:example-org/example-app:b"]\n-->\n',
    );
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
});
