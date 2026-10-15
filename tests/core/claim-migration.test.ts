import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { rewriteClaimRefs } from '../../src/core/claim-tags.js';
import { aliasRef, mergeClaims, normalizeClaimId, rekeyLedger, rekeyRegistry, type ClaimMigration } from '../../src/core/claim-migration.js';
import type { DriftRegistry } from '../../src/core/drift-registry.js';
import type { ProofLedger, ProofRecord } from '../../src/core/proof-ledger.js';
import { runResultsIngest } from '../../src/pipelines/results.js';
import { makeRepo } from '../helpers/repo.js';

const c = (text: string, id?: string) => ({ text, id });
const suggest = (text: string, suggestedId: string) => ({ text, suggestedId });

describe('mergeClaims [claim-merge]', () => {
  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('keeps unique slugs and merges identical text into one claim [keep-and-merge]', () => {
    const out = mergeClaims([
      { specKey: 'core/reader', claims: [c('Reads a file', 'reads-file'), c('Rejects a missing file', 'rejects-missing')] },
      { specKey: 'core/writer', claims: [c('Reads a file', 'reads-file-too'), c('Writes atomically', 'writes-atomically')] },
    ]);
    expect(out.claims.map((x) => x.id)).toEqual(['reads-file', 'rejects-missing', 'writes-atomically']);
    // Both old refs of the merged claim point at the single surviving claim.
    expect(out.aliases['core/reader#reads-file']).toBe('reads-file');
    expect(out.aliases['core/writer#reads-file-too']).toBe('reads-file');
  });

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('prefixes every contender with its spec leaf when slugs collide, never numeric suffixes [prefix-on-collision]', () => {
    const out = mergeClaims([
      { specKey: 'core/reader', claims: [c('Handles empty input', 'handles-empty')] },
      { specKey: 'pipelines/matrix', claims: [c('Handles empty specs gracefully', 'handles-empty')] },
    ]);
    expect(out.claims.map((x) => x.id)).toEqual(['reader-handles-empty', 'matrix-handles-empty']);
    expect(out.aliases['pipelines/matrix#handles-empty']).toBe('matrix-handles-empty');
    expect(out.claims.every((x) => !/-\d+$/.test(x.id))).toBe(true);
  });

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('is independent of the order the specs are merged in [order-independent]', () => {
    const a = { specKey: 'a/one', claims: [c('First behaviour', 'same-slug')] };
    const b = { specKey: 'b/two', claims: [c('Second behaviour', 'same-slug')] };
    const fwd = mergeClaims([a, b]).aliases;
    const rev = mergeClaims([b, a]).aliases;
    expect(fwd).toEqual(rev);
  });

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('uses an id the model suggested, made valid, and falls back to a slug of the text when there is none [suggested-ids]', () => {
    const out = mergeClaims([
      { specKey: 'cap', claims: [suggest('Acknowledgement is recorded once per user', 'Acknowledgement Recorded Once!'), suggest('Rejects a second submission', 'Rejects Second'), c('Plain text with no id')] },
    ]);
    expect(out.claims.map((x) => x.id)).toEqual(['acknowledgement-recorded-once', 'rejects-second', 'plain-text-with-no-id']);
    expect(normalizeClaimId('3rd party')).toBe('claim-3rd-party');
    expect(normalizeClaimId('already-valid-id')).toBe('already-valid-id');
    expect(normalizeClaimId('x'.repeat(80)).length).toBeLessThanOrEqual(48);
    expect(normalizeClaimId('!!!')).toBe('claim');
  });

  it('derives slugs for bullets without ids and caps ids at 48 characters [derive-and-clip]', () => {
    const out = mergeClaims([{ specKey: 'x/y', claims: [c('A very long requirement sentence that goes on and on past the limit of words')] }]);
    expect(out.claims[0].id.length).toBeLessThanOrEqual(48);
    expect(out.claims[0].id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(out.aliases).toEqual({});
  });
});

describe('ids that collide even after prefixing [collision-hash]', () => {
  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('tells apart several bullets from one spec by a hash of their text, whatever their order [same-spec]', () => {
    const lead = 'When a POST request is made to the login endpoint with a malformed value';
    const bullets = [c(`${lead} the endpoint returns 400`), c(`${lead} the endpoint returns 429 when rate limited`), c(`${lead} the endpoint logs the attempt`)];
    const fwd = mergeClaims([{ specKey: 'identity-and-access', claims: bullets }]);
    const rev = mergeClaims([{ specKey: 'identity-and-access', claims: [...bullets].reverse() }]);
    const ids = fwd.claims.map((x) => x.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(id.length).toBeLessThanOrEqual(48);
    }
    const byText = (r: ReturnType<typeof mergeClaims>) => Object.fromEntries(r.claims.map((x) => [x.text, x.id]));
    expect(byText(fwd)).toEqual(byText(rev));
  });
});

describe('refs naming another repo [other-repo-refs]', () => {
  const migration = { aliases: { 'core/a#one': 'caps/x#merged' } };

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('aliases a ref prefixed with this repo, and leaves a same-named spec in another repo alone', () => {
    expect(aliasRef('app:core/a#one', migration, ['app'])).toBe('app:caps/x#merged');
    expect(aliasRef('other:core/a#one', migration, ['app'])).toBeUndefined();
    expect(aliasRef('core/a#one', migration, ['app'])).toBe('caps/x#merged');
  });

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('an anchored claim keeps its anchor id even when another suggestion would be nicer', () => {
    const out = mergeClaims([{ specKey: 'core/a', claims: [{ text: 'Does the thing', id: 'does-thing', suggestedId: 'something-else' }] }]);
    expect(out.claims[0].id).toBe('does-thing');
  });
});

describe('rewriting refs [claim-rewrite]', () => {
  const migration = { aliases: { 'core/claim-tags#extract-forms': 'capabilities/conformance-testing#extract-forms' } };
  const map = (ref: string) => aliasRef(ref, migration, ['app']);

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('rewrites @claim tags, bracket tags and keeps a repo prefix, leaving other text alone [tag-forms]', () => {
    const src = [
      "it('a @claim:core/claim-tags#extract-forms', () => {});",
      "// [claim: core/claim-tags#extract-forms]",
      "// [claims: other/spec#x, core/claim-tags#extract-forms]",
      "it('b @claim:app:core/claim-tags#extract-forms', () => {});",
      "const s = 'core/claim-tags#extract-forms is mentioned here untagged';",
    ].join('\n');
    const { text, changed } = rewriteClaimRefs(src, map);
    expect(changed).toBe(4);
    expect(text).toContain('@claim:capabilities/conformance-testing#extract-forms');
    expect(text).toContain('// [claim: capabilities/conformance-testing#extract-forms]');
    expect(text).toContain('[claims: other/spec#x, capabilities/conformance-testing#extract-forms]');
    expect(text).toContain('@claim:app:capabilities/conformance-testing#extract-forms');
    expect(text).toContain("'core/claim-tags#extract-forms is mentioned here untagged'");
  });
});

describe('rekeying state [claim-rekey]', () => {
  const record = (claim: string, ingestedAt: string): ProofRecord => ({
    claim,
    verdict: 'proven',
    runId: 'r',
    specHash: 'old-hash',
    fileHashes: {},
    exercised: 1,
    counterexamples: 0,
    ingestedAt,
  });

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('moves ledger rows to the new refs and keeps the newest when two merge [ledger]', () => {
    const ledger: ProofLedger = {
      version: 1,
      proofs: {
        'core/a#one': record('core/a#one', '2026-01-01'),
        'core/b#two': record('core/b#two', '2026-02-01'),
        'app:core/a#one': record('app:core/a#one', '2026-01-01'),
        'core/z#keep': record('core/z#keep', '2026-01-01'),
      },
    };
    const migration = { aliases: { 'core/a#one': 'caps/x#merged', 'core/b#two': 'caps/x#merged' } };
    const { ledger: next, moved } = rekeyLedger(ledger, migration, ['app']);
    expect(moved).toBe(3);
    expect(Object.keys(next.proofs).sort()).toEqual(['app:caps/x#merged', 'caps/x#merged', 'core/z#keep']);
    expect(next.proofs['caps/x#merged'].ingestedAt).toBe('2026-02-01');
    expect(next.proofs['caps/x#merged'].claim).toBe('caps/x#merged');
    // The old spec hash is kept, so the proof goes stale against the new spec file rather than lying.
    expect(next.proofs['caps/x#merged'].specHash).toBe('old-hash');
  });

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('merges registry entries of absorbed specs into the capability [registry]', () => {
    const entry = (specKey: string, file: string) => ({ specKey, specHash: 'h', files: { [file]: { hash: 'f', lastChecked: 't', lastVerdict: 'ok' } } });
    const registry = { 'core/a': entry('core/a', 'src/a.ts'), 'core/b': entry('core/b', 'src/b.ts'), 'core/z': entry('core/z', 'src/z.ts') } as unknown as DriftRegistry;
    const { registry: next, moved } = rekeyRegistry(registry, { 'core/a': 'caps/x', 'core/b': 'caps/x' });
    expect(moved).toBe(2);
    expect(Object.keys(next).sort()).toEqual(['caps/x', 'core/z']);
    expect(Object.keys(next['caps/x'].files).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('registry merge keeps the target\'s own files [registry-target]', () => {
  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('does not drop a capability\'s own entry when an absorbed spec comes first, and does not share the input objects', () => {
    const entry = (specKey: string, specHash: string, file: string) => ({ specKey, specHash, files: { [file]: { hash: 'f', lastChecked: 't', lastVerdict: 'ok' } } });
    const registry = { 'old/a': entry('old/a', 'h-old', 'src/a.ts'), 'cap/x': entry('cap/x', 'h-cap', 'src/x.ts') } as unknown as DriftRegistry;
    const { registry: next } = rekeyRegistry(registry, { 'old/a': 'cap/x' });
    expect(Object.keys(next)).toEqual(['cap/x']);
    expect(Object.keys(next['cap/x'].files).sort()).toEqual(['src/a.ts', 'src/x.ts']);
    expect(next['cap/x'].specHash).toBe('h-cap');
    next['cap/x'].files['src/new.ts'] = { hash: 'n', lastChecked: 't', lastVerdict: 'ok' } as never;
    expect(Object.keys(registry['cap/x'].files)).toEqual(['src/x.ts']);
  });
});

describe('accepting old tags on ingest [ingest-aliases]', () => {
  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('maps a result tagged with the pre-consolidation ref onto the new claim for one release [accept-old-tags]', async () => {
    const repo = makeRepo();
    const migration: ClaimMigration = { version: 1, generated: 't', aliases: { 'old/spec#award-once': 'core/awards#award-once' }, specs: {} };
    repo.write('.specguard/claim-migration.json', JSON.stringify(migration));
    repo.write('a.xml', '<testsuite name="s"><testcase classname="c" name="t @claim:old/spec#award-once"/></testsuite>');
    await runResultsIngest(['a.xml'], repo.dir);
    const proofs = JSON.parse(readFileSync(path.join(repo.dir, '.specguard/proofs.json'), 'utf8')).proofs;
    expect(Object.keys(proofs)).toEqual(['core/awards#award-once']);
    expect(proofs['core/awards#award-once'].verdict).toBe('proven');
  });
});
