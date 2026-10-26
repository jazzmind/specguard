import { describe, expect, it } from 'vitest';

import { baseCandidates, isSafeBaseRef, pickBase, shortenRemoteRef } from '../../src/core/change-base.js';

const known = (refs: Record<string, string>) => (ref: string): string | undefined => refs[ref];

describe('base resolution [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#base-resolution]
  it('orders candidates: flag, record, config, origin/HEAD, origin/main, main, master', () => {
    const out = baseCandidates({ flag: 'f', recordBaseRef: 'r', configBaseRef: 'c', originHead: 'refs/remotes/origin/develop' });
    expect(out.map((c) => [c.source, c.ref])).toEqual([
      ['flag', 'f'], ['record', 'r'], ['config', 'c'], ['origin-head', 'origin/develop'], ['origin-main', 'origin/main'], ['main', 'main'], ['master', 'master'],
    ]);
    expect(baseCandidates({}).map((c) => c.ref)).toEqual(['origin/main', 'main', 'master']);
  });

  // [claims: capabilities/spec-first-changes#base-resolution]
  it('drops empty values and repeats, the first source of a ref winning', () => {
    const out = baseCandidates({ flag: ' ', recordBaseRef: 'origin/main', configBaseRef: 'origin/main', originHead: 'refs/remotes/origin/main' });
    expect(out.map((c) => [c.source, c.ref])).toEqual([['record', 'origin/main'], ['main', 'main'], ['master', 'master']]);
    expect(shortenRemoteRef('refs/remotes/origin/main\n')).toBe('origin/main');
    expect(shortenRemoteRef('origin/main')).toBe('origin/main');
  });

  // [claims: capabilities/spec-first-changes#base-resolution]
  it('picks the first candidate that resolves and reports the ones it skipped', () => {
    const out = pickBase({ recordBaseRef: 'gone', originHead: 'refs/remotes/origin/trunk' }, known({ main: 'sha-main', master: 'sha-master' }));
    expect(out).toEqual({
      ok: true,
      ref: 'main',
      source: 'main',
      sha: 'sha-main',
      skipped: [
        { ref: 'gone', source: 'record', reason: 'unresolved' },
        { ref: 'origin/trunk', source: 'origin-head', reason: 'unresolved' },
        { ref: 'origin/main', source: 'origin-main', reason: 'unresolved' },
      ],
    });
  });

  // [claims: capabilities/spec-first-changes#base-resolution]
  it('the record base beats config and the defaults when it resolves', () => {
    const out = pickBase({ recordBaseRef: 'release', configBaseRef: 'develop' }, known({ release: 'r', develop: 'd', main: 'm' }));
    expect(out).toMatchObject({ ok: true, ref: 'release', source: 'record', sha: 'r', skipped: [] });
  });

  // [claims: capabilities/spec-first-changes#base-resolution]
  it('refuses refs that look like options, and never passes them to the resolver', () => {
    for (const bad of ['--output=/etc/x', '-x', '', ' a', 'a b', 'a;b', 'a\nb', '$(x)', 'x'.repeat(300)]) expect(isSafeBaseRef(bad), bad).toBe(false);
    for (const ok of ['main', 'origin/main', 'HEAD~3', 'v1.2.3', 'a'.repeat(40), 'feature/x@{u}']) expect(isSafeBaseRef(ok), ok).toBe(true);
    const seen: string[] = [];
    const out = pickBase({ recordBaseRef: '--upload-pack=x' }, (ref) => {
      seen.push(ref);
      return ref === 'main' ? 'm' : undefined;
    });
    expect(out).toMatchObject({ ok: true, ref: 'main', skipped: [{ ref: '--upload-pack=x', source: 'record', reason: 'unsafe' }, { ref: 'origin/main', reason: 'unresolved' }] });
    expect(seen).not.toContain('--upload-pack=x');
  });

  // [claims: capabilities/spec-first-changes#base-resolution]
  it('an explicit --base that is unsafe or does not resolve is an error, not a fall-through', () => {
    const resolver = known({ main: 'm' });
    expect(pickBase({ flag: '--evil' }, resolver)).toMatchObject({ ok: false, error: expect.stringContaining('not a usable ref') });
    expect(pickBase({ flag: 'nope' }, resolver)).toMatchObject({ ok: false, error: expect.stringContaining('does not resolve') });
    expect(pickBase({ flag: 'main' }, resolver)).toMatchObject({ ok: true, ref: 'main', source: 'flag' });
  });

  // [claims: capabilities/spec-first-changes#base-resolution]
  it('fails with a pass --base hint when nothing resolves', () => {
    const out = pickBase({}, () => undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain('--base');
      expect(out.skipped.map((s) => s.ref)).toEqual(['origin/main', 'main', 'master']);
    }
  });
});
