import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { HASH_VERSION } from '../../src/core/claim-hash.js';
import { detectProvenance } from '../../src/core/provenance.js';
import { fileLedgerStore } from '../../src/core/state/ledger-store.js';
import { ingestVerdicts } from '../../src/pipelines/proof.js';
import { makeRepo } from '../helpers/repo.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'sg-store-'));

describe('provenance [provenance]', () => {
  // [claims: capabilities/conformance-testing#proof-provenance]
  it('reads GitHub Actions variables, and never a developer\'s git identity [github]', () => {
    const p = detectProvenance(tmp(), { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/app', GITHUB_REF_NAME: 'main', GITHUB_SHA: 'abc123', GITHUB_ACTOR: 'octocat' });
    expect(p).toEqual({ origin: 'ci', repo: 'acme/app', branch: 'main', commit: 'abc123', actor: 'octocat' });
    // A pull request's branch is the head ref, not the merge ref.
    expect(detectProvenance(tmp(), { GITHUB_ACTIONS: 'true', GITHUB_HEAD_REF: 'feature/x', GITHUB_REF_NAME: '12/merge' }).branch).toBe('feature/x');
  });

  // [claims: capabilities/conformance-testing#proof-provenance]
  it('is ci for any other CI and local otherwise [others]', () => {
    expect(detectProvenance(tmp(), { CI: 'true' }).origin).toBe('ci');
    const local = detectProvenance(tmp(), {});
    expect(local.origin).toBe('local');
    expect(local.actor).toBeUndefined();
  });
});

describe('file ledger store [ledger-store]', () => {
  const sample = (claim: string) => ({ claim, verdict: 'proven' as const, runId: 'r', specHash: 'h', fileHashes: {}, exercised: 1, counterexamples: 0, ingestedAt: 'now' });

  // [claims: capabilities/conformance-testing#proof-provenance]
  it('does not lose concurrent updates [no-lost-updates]', async () => {
    const file = path.join(tmp(), 'proofs.json');
    const store = fileLedgerStore(file);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.update(async (ledger) => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          ledger.proofs[`a#c${i}`] = sample(`a#c${i}`);
        }),
      ),
    );
    expect(Object.keys((await store.read()).proofs)).toHaveLength(25);
  });

  // [claims: capabilities/conformance-testing#proof-provenance]
  it('leaves the file as it was when an update throws, and keeps accepting updates after [failed-update]', async () => {
    const file = path.join(tmp(), 'proofs.json');
    const store = fileLedgerStore(file);
    await store.update((l) => void (l.proofs['a#one'] = sample('a#one')));
    await expect(store.update((l) => { l.proofs['a#two'] = sample('a#two'); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(Object.keys((await store.read()).proofs)).toEqual(['a#one']);
    await store.update((l) => void (l.proofs['a#three'] = sample('a#three')));
    expect(Object.keys((await store.read()).proofs).sort()).toEqual(['a#one', 'a#three']);
  });

  // [claims: capabilities/conformance-testing#proof-provenance]
  it('refuses a newer ledger version instead of reading it as empty [newer-version]', async () => {
    const file = path.join(tmp(), 'proofs.json');
    writeFileSync(file, JSON.stringify({ version: 9, proofs: { 'a#b': sample('a#b') } }));
    const before = readFileSync(file, 'utf8');
    await expect(fileLedgerStore(file).update(() => undefined)).rejects.toThrow(/version 9/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('ingest records provenance [ingest-provenance]', () => {
  const ledger = (dir: string) => JSON.parse(readFileSync(path.join(dir, '.specguard/proofs.json'), 'utf8')).proofs as Record<string, Record<string, unknown>>;

  // [claims: capabilities/conformance-testing#proof-provenance]
  it('stamps each row with its origin, branch, actor and the hash version, taking overrides from the caller [stamp]', async () => {
    const repo = makeRepo();
    await ingestVerdicts({ runId: 'r', verdicts: [{ claim: 'core/awards#award-once', verdict: 'proven' }] }, repo.dir, { provenance: { origin: 'ci', repo: 'acme/app', branch: 'main', actor: 'octocat' } });
    expect(ledger(repo.dir)['core/awards#award-once']).toMatchObject({ origin: 'ci', repo: 'acme/app', branch: 'main', actor: 'octocat', hashVersion: HASH_VERSION });
  });

  // [claims: capabilities/conformance-testing#proof-provenance]
  it('writes to an injected store instead of a file [injected-store]', async () => {
    const repo = makeRepo();
    const kept: Record<string, unknown> = {};
    const store = {
      location: 'memory',
      read: async () => ({ version: 1 as const, proofs: kept as never }),
      update: async <T>(fn: (l: { version: 1; proofs: never }) => T | Promise<T>) => fn({ version: 1, proofs: kept as never }),
    };
    const r = await ingestVerdicts({ runId: 'r', verdicts: [{ claim: 'core/awards#award-once', verdict: 'proven' }] }, repo.dir, { store });
    expect(Object.keys(kept)).toEqual(['core/awards#award-once']);
    expect(r.messages.join('\n')).toContain('ledger memory');
  });
});
