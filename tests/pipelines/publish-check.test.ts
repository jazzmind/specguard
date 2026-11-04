import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import { PUBLISH_CHECK_SCHEMA } from '../../src/core/publish-contract.js';
import { checkPublish, compareDigests, runPublish } from '../../src/pipelines/publish.js';
import { gitCommit } from '../helpers/v2-repo.js';
import { startFakeServer, type FakeServer } from '../helpers/fake-publish-server.js';
import { makeRunRepo } from '../helpers/publish-fixture.js';

const CI_VARS = ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REF_NAME', 'GITHUB_HEAD_REF', 'GITHUB_SHA', 'GITHUB_ACTOR', 'CI', 'SPECGUARD_SERVER', 'SPECGUARD_TOKEN', 'SPECGUARD_PROJECT'] as const;
const saved: Record<string, string | undefined> = {};
let server: FakeServer | undefined;
beforeEach(() => {
  for (const v of CI_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(async () => {
  for (const v of CI_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  await server?.close();
  server = undefined;
});

describe('publish --check [publish-check]', () => {
  // [claims: capabilities/team-server#publish-state-check]
  it('is up to date right after a publish, and sends nothing itself', async () => {
    server = await startFakeServer();
    const { repo } = await makeRunRepo({ server: { url: server.url, project: 'demo' } });
    const config = await loadConfig(repo.dir);
    await runPublish(config, { push: true });
    const before = server.log.length;
    const check = await checkPublish(config);
    expect(check).toMatchObject({ schema: PUBLISH_CHECK_SCHEMA, project: 'demo', needsPublish: false, exact: true, reasons: [], commitDiffers: false });
    expect(check.server).toMatchObject({ reachable: true, signedIn: true, role: 'maintainer', features: ['publish-state', 'evidence'] });
    expect(check.remote?.digest?.total).toBe(check.local.digest.total);
    // Only reads: health and publish-state.
    expect(server.log.slice(before).every((l) => l.startsWith('GET '))).toBe(true);
  });

  // [claims: capabilities/team-server#publish-state-check]
  it('says never-published for a project the server has no snapshot of', async () => {
    server = await startFakeServer();
    const { repo } = await makeRunRepo({ server: { url: server.url, project: 'demo' } });
    const check = await checkPublish(await loadConfig(repo.dir));
    expect(check).toMatchObject({ needsPublish: true, exact: true, reasons: ['never-published'], remote: null });
  });

  // [claims: capabilities/team-server#publish-state-check]
  it('names what changed: a spec edit, a new spec file and a removed one, even when the commit is the same', async () => {
    server = await startFakeServer();
    const { repo } = await makeRunRepo({ server: { url: server.url, project: 'demo' } });
    await runPublish(await loadConfig(repo.dir), { push: true });
    repo.write('specs/capabilities/auth.md', 'x'); // replaces content: modified
    repo.write('specs/capabilities/extra.md', '---\nid: extra\nkind: capability\nparent: system\nvalue: v\nstatus: active\n---\n# Extra\n');
    const check = await checkPublish(await loadConfig(repo.dir));
    expect(check.commitDiffers).toBe(false); // nothing was committed: only the digest sees it
    expect(check.needsPublish).toBe(true);
    expect(check.reasons).toContain('specs-changed');
    expect(check.specFiles.added).toEqual(['specs/capabilities/extra.md']);
    expect(check.specFiles.modified).toEqual(['specs/capabilities/auth.md']);
    expect(check.specFiles.removed).toEqual([]);
  });

  // [claims: capabilities/team-server#publish-state-check]
  it('compareDigests reports changed sections, proofs included', () => {
    const d = (specs: string, ledger: string, files: Record<string, string>) => ({ v: 1 as const, total: specs + ledger, sections: { specs, trace: 't', ledger, plans: 'p', contracts: 'c' }, files });
    const diff = compareDigests(d('s2', 'l2', { 'specs/a.md': '2', 'specs/n.md': '1' }), d('s1', 'l1', { 'specs/a.md': '1', 'specs/r.md': '1' }));
    expect(diff.reasons).toEqual(['specs-changed', 'proofs-changed']);
    expect(diff.specFiles).toEqual({ added: ['specs/n.md'], removed: ['specs/r.md'], modified: ['specs/a.md'] });
  });

  // [claims: capabilities/team-server#publish-state-check]
  it('asks for a run publish when the newest local run is not on the server, and counts its files and bytes', async () => {
    server = await startFakeServer();
    const { repo } = await makeRunRepo({ server: { url: server.url, project: 'demo' }, files: [{ name: 'a.png', content: 'aaaa' }, { name: 'b.png', content: 'bbbbbb' }] });
    const config = await loadConfig(repo.dir);
    await runPublish(config, { push: true });
    const check = await checkPublish(config);
    expect(check.reasons).toEqual(['new-run']);
    expect(check.local.latestRun).toEqual({ runId: 'run-1', files: 2, bytes: 10 });
    // After the evidence is published, the same check is clean.
    const sent = await runPublish(config, { push: true, evidence: 'all' });
    expect(sent.exitCode, sent.messages.join('\n')).toBe(0);
    expect((await checkPublish(config)).needsPublish).toBe(false);
  });

  // [claims: capabilities/team-server#publish-state-check]
  it('reports a run whose evidence never finished as run-evidence-incomplete', async () => {
    server = await startFakeServer();
    const { repo } = await makeRunRepo({ server: { url: server.url, project: 'demo' }, files: [{ name: 'a.png', content: 'aaaa' }] });
    const config = await loadConfig(repo.dir);
    await runPublish(config, { push: true });
    // The offer is made (pending) but nothing is uploaded: a manifest the server holds without its blobs.
    const failing = await startFakeServer({ failPuts: 999 });
    failing.snapshots.set('demo', server.snapshots.get('demo')!);
    const cfgFailing = await loadConfig(repo.dir);
    const res = await runPublish({ ...cfgFailing, server: { ...cfgFailing.server!, url: failing.url } }, { push: true, evidence: 'all', sleep: async () => undefined });
    expect(res.failed).toBe(1);
    const check = await checkPublish({ ...cfgFailing, server: { ...cfgFailing.server!, url: failing.url } });
    expect(check.reasons).toContain('run-evidence-incomplete');
    await failing.close();
  });

  // [claims: capabilities/team-server#publish-back-compat]
  it('against a server without publish-state compares commits only (exact false, server-cannot-compare)', async () => {
    server = await startFakeServer({ modern: false });
    const { repo } = await makeRunRepo({ server: { url: server.url, project: 'demo' } });
    const config = await loadConfig(repo.dir);
    const first = await checkPublish(config);
    expect(first).toMatchObject({ needsPublish: true, exact: false });
    expect(first.reasons).toEqual(['never-published', 'server-cannot-compare']);

    await runPublish(config, { push: true });
    const same = await checkPublish(config);
    expect(same).toMatchObject({ needsPublish: false, exact: false, reasons: ['server-cannot-compare'], commitDiffers: false });
    expect(same.server.features).toEqual([]);

    repo.write('src/new.ts', 'export const n = 1;\n');
    gitCommit(repo.dir, 'second');
    const moved = await checkPublish(await loadConfig(repo.dir));
    expect(moved).toMatchObject({ needsPublish: true, exact: false, commitDiffers: true });
  });

  // [claims: capabilities/team-server#publish-back-compat]
  it('an old server refuses evidence only after the snapshot is pushed, with exit code 2', async () => {
    server = await startFakeServer({ modern: false });
    const { repo } = await makeRunRepo({ server: { url: server.url, project: 'demo' }, files: [{ name: 'a.png', content: 'aaaa' }] });
    const res = await runPublish(await loadConfig(repo.dir), { push: true, evidence: 'all' });
    expect(res.exitCode).toBe(ExitCode.ValidationFailed);
    expect(res.messages.join('\n')).toContain('server does not accept test evidence; upgrade it');
    expect(server.snapshots.get('demo')).toHaveLength(1);
  });

  // [claims: capabilities/team-server#publish-state-check]
  it('reports an unreachable server, a missing configuration and a refused credential as errors, not exceptions', async () => {
    const { repo } = await makeRunRepo({ server: { url: 'http://127.0.0.1:9', project: 'demo' } });
    const down = await checkPublish(await loadConfig(repo.dir));
    expect(down.server.reachable).toBe(false);
    expect(down.error).toContain('cannot reach');

    const bare = await makeRunRepo();
    const none = await checkPublish(await loadConfig(bare.repo.dir));
    expect(none.error).toContain('no team server is configured');
    expect(none.server.url).toBe('');

    server = await startFakeServer({ token: 'secret' });
    const locked = await makeRunRepo({ server: { url: server.url, project: 'demo' } });
    const refused = await checkPublish(await loadConfig(locked.repo.dir));
    expect(refused).toMatchObject({ server: { reachable: true, signedIn: false } });
    expect(refused.error).toContain('not signed in');
    // The token comes from the environment.
    const ok = await checkPublish(await loadConfig(locked.repo.dir), { env: { ...process.env, SPECGUARD_TOKEN: 'secret' } });
    expect(ok.error).toBeUndefined();
    expect(ok.server.signedIn).toBe(true);
  });

  // [claims: capabilities/team-server#publish-state-check]
  it('as a command result: exit 9 when a publish is needed, 0 when up to date, 1 on an error', async () => {
    server = await startFakeServer();
    const { repo } = await makeRunRepo({ server: { url: server.url, project: 'demo' } });
    const config = await loadConfig(repo.dir);
    const needs = await runPublish(config, { check: true });
    expect(needs.exitCode).toBe(9);
    expect(needs.publish).toMatchObject({ schema: PUBLISH_CHECK_SCHEMA, needsPublish: true });
    expect(server.snapshots.size).toBe(0);
    await runPublish(config, { push: true });
    expect((await runPublish(config, { check: true })).exitCode).toBe(0);
    const bare = await makeRunRepo();
    expect((await runPublish(await loadConfig(bare.repo.dir), { check: true })).exitCode).toBe(ExitCode.InternalError);
  });
});
