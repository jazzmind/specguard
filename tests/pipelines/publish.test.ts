import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { MAX_SNAPSHOT_BYTES, parseSnapshot } from '../../src/core/snapshot.js';
import { runHistoryAdd } from '../../src/pipelines/history.js';
import { ingestVerdicts } from '../../src/pipelines/proof.js';
import { buildSnapshot, runPublish } from '../../src/pipelines/publish.js';
import { makeV2Repo } from '../helpers/v2-repo.js';

describe('publish [publish]', () => {
  // [claims: capabilities/team-server#publish-snapshot]
  it('writes a snapshot a server would accept: specs, history, trace, proofs, and no source code [snapshot]', async () => {
    const repo = makeV2Repo();
    repo.write('.gitignore', '.specguard/\n');
    await ingestVerdicts({ runId: 'r1', verdicts: [{ claim: 'capabilities/auth#login-valid-code', verdict: 'proven' }] }, repo.dir, { provenance: { origin: 'ci', branch: 'main' } });
    await runHistoryAdd(await loadConfig(repo.dir), { decision: 'Login needs a code', affects: ['auth'] });
    const r = await runPublish(await loadConfig(repo.dir), { project: 'demo' });
    expect(r.exitCode).toBe(0);
    const text = readFileSync(path.join(repo.dir, '.specguard/publish/snapshot.json'), 'utf8');
    const parsed = parseSnapshot(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const snap = parsed.snapshot;
    expect(snap).toMatchObject({ project: 'demo', specsRoot: 'specs', hashVersion: 1 });
    expect(Object.keys(snap.files).sort()).toEqual(expect.arrayContaining(['specs/capabilities/auth.md', 'specs/capabilities/shop.md', 'specs/system.md']));
    expect(Object.keys(snap.files).some((f) => f.startsWith('specs/history/'))).toBe(true);
    // No source code, only the spec tree.
    expect(Object.keys(snap.files).every((f) => f.startsWith('specs/') && f.endsWith('.md'))).toBe(true);
    expect(text).not.toContain('export const login');
    expect(snap.trace.nodes.map((n) => n.id).sort()).toEqual(['auth', 'shop', 'system']);
    expect(snap.ledger['capabilities/auth#login-valid-code']).toMatchObject({ verdict: 'proven', origin: 'ci', branch: 'main' });
  });

  // [claims: capabilities/team-server#publish-snapshot]
  it('redacts credentials from every file and leaves the v1 archive out [redaction]', async () => {
    const repo = makeV2Repo();
    repo.write('specs/capabilities/auth.md', readFileSync(path.join(repo.dir, 'specs/capabilities/auth.md'), 'utf8').replace('Only approved people sign in.', 'Only approved people sign in. The service key is sk-abcdefghijklmnopqrstuvwxyz123456.'));
    repo.write('specs/_archive/v1/old.md', '# old');
    const snap = await buildSnapshot(await loadConfig(repo.dir));
    expect(snap.files['specs/capabilities/auth.md']).toContain('[KEY]');
    expect(snap.files['specs/capabilities/auth.md']).not.toContain('sk-abcdefghijklmnop');
    expect(Object.keys(snap.files).some((f) => f.includes('_archive'))).toBe(false);
  });

  // [claims: capabilities/team-server#publish-snapshot]
  it('names the project from the flag, then config, then the directory [project-name]', async () => {
    const repo = makeV2Repo({ server: { project: 'from-config' } });
    expect((await buildSnapshot(await loadConfig(repo.dir))).project).toBe('from-config');
    expect((await buildSnapshot(await loadConfig(repo.dir), { project: 'flag' })).project).toBe('flag');
    const plain = makeV2Repo();
    expect((await buildSnapshot(await loadConfig(plain.dir))).project).toBe(path.basename(plain.dir));
  });
});

describe('snapshot validation [snapshot-validation]', () => {
  const base = async () => JSON.parse(JSON.stringify(await buildSnapshot(await loadConfig(makeV2Repo().dir), { project: 'demo' })));

  // [claims: capabilities/team-server#publish-snapshot]
  it('rejects paths that leave the spec tree, non-markdown files and bad project names [paths]', async () => {
    for (const bad of ['../etc/passwd.md', '/abs/x.md', 'specs/../../x.md', 'specs/a.txt', 'other/a.md', 'specs\\a.md', 'specs//a.md']) {
      const snap = await base();
      snap.files[bad] = 'x';
      expect(parseSnapshot(JSON.stringify(snap)).ok, bad).toBe(false);
    }
    for (const name of ['../x', 'a b', '', 'x'.repeat(65), '-lead']) {
      const snap = await base();
      snap.project = name;
      expect(parseSnapshot(JSON.stringify(snap)).ok, name).toBe(false);
    }
    expect((await base()).project).toBe('demo');
    expect(parseSnapshot(JSON.stringify(await base())).ok).toBe(true);
  });

  // [claims: capabilities/team-server#publish-snapshot]
  it('rejects malformed, oversized and wrong-version input without throwing [malformed]', async () => {
    expect(parseSnapshot('{ nope')).toMatchObject({ ok: false, error: 'snapshot is not valid JSON' });
    expect(parseSnapshot('{}').ok).toBe(false);
    const snap = await base();
    snap.version = 2;
    expect(parseSnapshot(JSON.stringify(snap)).ok).toBe(false);
    expect(parseSnapshot('x'.repeat(MAX_SNAPSHOT_BYTES + 1))).toMatchObject({ ok: false });
    const noTrace = await base();
    delete noTrace.trace;
    expect(parseSnapshot(JSON.stringify(noTrace))).toMatchObject({ ok: false });
  });
});
