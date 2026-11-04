import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import { RunManifestSchema, type PublishProgress } from '../../src/core/publish-contract.js';
import { digestOf, buildSnapshot, runPublish } from '../../src/pipelines/publish.js';
import { buildRunManifest, HASH_CACHE_FILE } from '../../src/pipelines/publish-evidence.js';
import { startFakeServer, type FakeServer } from '../helpers/fake-publish-server.js';
import { makeRunRepo } from '../helpers/publish-fixture.js';

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const noSleep = async (): Promise<void> => undefined;

const ENV = ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'CI', 'SPECGUARD_SERVER', 'SPECGUARD_TOKEN', 'SPECGUARD_PROJECT'] as const;
const saved: Record<string, string | undefined> = {};
let server: FakeServer | undefined;
beforeEach(() => {
  for (const v of ENV) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(async () => {
  for (const v of ENV) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

async function setup(files: Array<{ name: string; content: string }>, serverOpts: Parameters<typeof startFakeServer>[0] = {}) {
  server = await startFakeServer(serverOpts);
  const made = await makeRunRepo({ server: { url: server.url, project: 'demo' }, files });
  return { ...made, config: await loadConfig(made.repo.dir) };
}

describe('buildRunManifest [publish-evidence]', () => {
  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('lists every attachment with its full sha256, size and kind, and validates against the contract', async () => {
    const { config } = await setup([{ name: 'a.png', content: 'aaaa' }, { name: 'copy.png', content: 'aaaa' }, { name: 'b.png', content: 'bbbbbb' }]);
    const digest = digestOf(await buildSnapshot(config, { project: 'demo' }));
    const built = await buildRunManifest(config, { project: 'demo', digest });
    expect(RunManifestSchema.safeParse(built.manifest).success).toBe(true);
    const entries = Object.entries(built.manifest.files);
    expect(entries).toHaveLength(3);
    for (const [, f] of entries) expect(f).toMatchObject({ kind: 'image', contentType: 'image/png' });
    expect(Object.values(built.manifest.files).map((f) => f.sha256).sort()).toEqual([sha('aaaa'), sha('aaaa'), sha('bbbbbb')].sort());
    // Equal content is one blob to upload.
    expect(built.files.size).toBe(2);
    expect(built.manifest.runId).toBe('run-1');
    expect(built.manifest.digest).toEqual(digest);
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('summary mode carries the report and no files; a missing file is recorded as omitted', async () => {
    const { config, repo } = await setup([{ name: 'a.png', content: 'aaaa' }, { name: 'gone.png', content: 'gg' }]);
    const digest = digestOf(await buildSnapshot(config, { project: 'demo' }));
    const summary = await buildRunManifest(config, { project: 'demo', digest, mode: 'summary' });
    expect(summary.manifest.files).toEqual({});
    expect(summary.manifest.omitted).toEqual([]);
    expect(summary.manifest.report.schema).toBe('specguard-report/1');
    const gone = Object.keys((await buildRunManifest(config, { project: 'demo', digest })).manifest.files).find((k) => k.endsWith('gone.png'))!;
    const { rmSync } = await import('node:fs');
    rmSync(path.join(repo.dir, '.specguard/evidence', gone));
    const again = await buildRunManifest(config, { project: 'demo', digest });
    expect(again.manifest.omitted).toEqual([{ path: gone, reason: 'missing' }]);
    expect(Object.keys(again.manifest.files)).toHaveLength(1);
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('redacts secrets and keeps no absolute paths', async () => {
    const { repo } = await setup([{ name: 'a.png', content: 'aaaa' }]);
    const idxFile = path.join(repo.dir, '.specguard/runs/run-1.json');
    const idx = JSON.parse(readFileSync(idxFile, 'utf8'));
    idx.tests[0].title += ' key sk-abcdefghijklmnopqrstuvwxyz123456';
    idx.tests[0].file = path.join(repo.dir, 'tests/auth.spec.ts');
    writeFileSync(idxFile, JSON.stringify(idx));
    const config = await loadConfig(repo.dir);
    const built = await buildRunManifest(config, { project: 'demo', digest: digestOf(await buildSnapshot(config, { project: 'demo' })) });
    const text = JSON.stringify(built.manifest);
    expect(text).not.toContain('sk-abcdefghijklmnop');
    expect(text).toContain('[KEY]');
    expect(text).not.toContain(repo.dir);
    expect(built.manifest.index.tests[0].file).toBe('tests/auth.spec.ts');
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('caches hashes by path, size and mtime', async () => {
    const { config, repo } = await setup([{ name: 'a.png', content: 'aaaa' }]);
    const digest = digestOf(await buildSnapshot(config, { project: 'demo' }));
    await buildRunManifest(config, { project: 'demo', digest });
    const cacheFile = path.join(repo.dir, HASH_CACHE_FILE);
    expect(existsSync(cacheFile)).toBe(true);
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, string>;
    const [key] = Object.keys(cache);
    expect(cache[key]).toBe(sha('aaaa'));
    // A poisoned entry is returned as is: proof the file was not read again.
    cache[key] = 'f'.repeat(64);
    writeFileSync(cacheFile, JSON.stringify(cache));
    const built = await buildRunManifest(config, { project: 'demo', digest });
    expect(Object.values(built.manifest.files)[0].sha256).toBe('f'.repeat(64));
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('lists files over the server cap as oversized, or omits them with skipOversized', async () => {
    const { config } = await setup([{ name: 'a.png', content: 'aaaa' }, { name: 'big.webm', content: 'x'.repeat(300) }]);
    const digest = digestOf(await buildSnapshot(config, { project: 'demo' }));
    const refused = await buildRunManifest(config, { project: 'demo', digest, limits: { maxFileBytes: 100 } });
    expect(refused.oversized.map((f) => f.size)).toEqual([300]);
    const skipped = await buildRunManifest(config, { project: 'demo', digest, limits: { maxFileBytes: 100 }, skipOversized: true });
    expect(skipped.oversized).toEqual([]);
    expect(skipped.manifest.omitted.map((o) => o.reason)).toEqual(['too-large']);
  });
});

describe('publish --push --evidence [publish-evidence]', () => {
  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('uploads in chunks no larger than the server asks, verifies, commits, and a second publish sends nothing', async () => {
    const big = 'abcdefghij'.repeat(35); // 350 bytes
    const { config } = await setup([{ name: 'a.png', content: big }, { name: 'b.png', content: 'tiny' }], { chunkBytes: 100 });
    const res = await runPublish(config, { push: true, evidence: 'all' });
    expect(res.exitCode, res.messages.join('\n')).toBe(0);
    expect(server!.blobs.get(sha(big))?.toString()).toBe(big);
    expect(Math.max(...server!.putSizes)).toBeLessThanOrEqual(100);
    expect(server!.putSizes.filter((n) => n > 0).length).toBe(5); // 4 chunks + 1
    expect(server!.manifests.get('demo')![0].status).toBe('complete');
    expect(res.publish).toMatchObject({ runs: [{ runId: 'run-1', status: 'complete', files: 2 }] });

    const puts = server!.log.filter((l) => l.startsWith('PUT')).length;
    const again = await runPublish(config, { push: true, evidence: 'all' });
    expect(again.exitCode).toBe(0);
    expect(server!.log.filter((l) => l.startsWith('PUT')).length).toBe(puts);
    expect(again.messages.join('\n')).toContain('0 uploaded');
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('sends only the blobs the server lacks', async () => {
    const { config } = await setup([{ name: 'a.png', content: 'aaaa' }, { name: 'b.png', content: 'bbbbbb' }]);
    server!.blobs.set(sha('aaaa'), Buffer.from('aaaa'));
    const res = await runPublish(config, { push: true, evidence: 'all' });
    expect(res.exitCode, res.messages.join('\n')).toBe(0);
    expect(server!.putSizes).toEqual([6]);
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('resumes a partial upload from the offset the server reports (HEAD)', async () => {
    const body = '0123456789'.repeat(30); // 300 bytes
    const { config } = await setup([{ name: 'a.png', content: body }], { chunkBytes: 100 });
    server!.partials.set(sha(body), Buffer.from(body.slice(0, 200)));
    const res = await runPublish(config, { push: true, evidence: 'all' });
    expect(res.exitCode, res.messages.join('\n')).toBe(0);
    expect(server!.putSizes).toEqual([100]);
    expect(server!.blobs.get(sha(body))?.toString()).toBe(body);
    expect(server!.log.some((l) => l.startsWith('HEAD'))).toBe(true);
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('recovers from an offset mismatch by continuing at the offset the server expects', async () => {
    const body = 'x'.repeat(250);
    const { config } = await setup([{ name: 'a.png', content: body }], { chunkBytes: 100, mismatchOnce: true });
    const res = await runPublish(config, { push: true, evidence: 'all', sleep: noSleep });
    expect(res.exitCode, res.messages.join('\n')).toBe(0);
    expect(server!.blobs.get(sha(body))?.toString()).toBe(body);
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('retries transient failures with backoff, then gives up with a clear message', async () => {
    const { config } = await setup([{ name: 'a.png', content: 'aaaa' }], { failPuts: 2 });
    const waits: number[] = [];
    const ok = await runPublish(config, { push: true, evidence: 'all', sleep: async (ms) => void waits.push(ms) });
    expect(ok.exitCode, ok.messages.join('\n')).toBe(0);
    expect(waits).toEqual([500, 1000]);
    await server!.close();

    server = await startFakeServer({ failPuts: 999 });
    const made = await makeRunRepo({ server: { url: server.url, project: 'demo' }, files: [{ name: 'a.png', content: 'aaaa' }] });
    const bad = await runPublish(await loadConfig(made.repo.dir), { push: true, evidence: 'all', sleep: noSleep });
    expect(bad.failed).toBe(1);
    expect(bad.exitCode).toBe(ExitCode.InternalError);
    expect(bad.messages.join('\n')).toContain('failed after 5 tries');
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('--max-evidence-mb refuses before any byte is uploaded, counting only what the server lacks', async () => {
    const { config } = await setup([{ name: 'a.png', content: 'a'.repeat(1024 * 1024) }, { name: 'b.png', content: 'b'.repeat(1024 * 1024) }]);
    const res = await runPublish(config, { push: true, evidence: 'all', maxEvidenceMb: 1 });
    expect(res.exitCode).toBe(ExitCode.ValidationFailed);
    expect(res.messages.join('\n')).toContain('over --max-evidence-mb 1');
    expect(server!.log.some((l) => l.startsWith('PUT /api/v1/projects/demo/blobs'))).toBe(false);
    // With one blob already there only 1 MB is left, which fits.
    server!.blobs.set(sha('a'.repeat(1024 * 1024)), Buffer.alloc(1));
    const ok = await runPublish(config, { push: true, evidence: 'all', maxEvidenceMb: 1 });
    expect(ok.exitCode, ok.messages.join('\n')).toBe(0);
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('fails on files over the server per-file cap with the list, unless --skip-oversized (recorded as omitted)', async () => {
    const { config } = await setup([{ name: 'a.png', content: 'aaaa' }, { name: 'big.webm', content: 'x'.repeat(300) }], { maxFileBytes: 100 });
    const refused = await runPublish(config, { push: true, evidence: 'all' });
    expect(refused.exitCode).toBe(ExitCode.ValidationFailed);
    expect(refused.messages.join('\n')).toMatch(/big\.webm \(300 bytes\)/);
    expect(server!.blobs.size).toBe(0);
    const skipped = await runPublish(config, { push: true, evidence: 'all', skipOversized: true });
    expect(skipped.exitCode, skipped.messages.join('\n')).toBe(0);
    expect(server!.manifests.get('demo')![0].manifest.omitted).toEqual([expect.objectContaining({ reason: 'too-large' })]);
    expect(skipped.messages.join('\n')).toContain('1 file(s) omitted');
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('summary publishes the manifest and report with no blobs', async () => {
    const { config } = await setup([{ name: 'a.png', content: 'aaaa' }]);
    const res = await runPublish(config, { push: true, evidence: 'summary' });
    expect(res.exitCode, res.messages.join('\n')).toBe(0);
    expect(server!.blobs.size).toBe(0);
    expect(server!.manifests.get('demo')![0].status).toBe('complete');
    expect(server!.manifests.get('demo')![0].manifest.files).toEqual({});
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('reports progress as hash, upload and commit events, and as NDJSON on stderr with progressJson', async () => {
    const { config } = await setup([{ name: 'a.png', content: 'aaaa' }, { name: 'b.png', content: 'bbbb' }]);
    const events: PublishProgress[] = [];
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    const res = await runPublish(config, { push: true, evidence: 'all', progressJson: true, key: 'es', onProgress: (p) => events.push(p) });
    expect(res.exitCode, res.messages.join('\n')).toBe(0);
    expect(new Set(events.map((e) => e.phase))).toEqual(new Set(['hash', 'upload', 'commit']));
    expect(events.every((e) => e.sg === 'progress' && e.key === 'es')).toBe(true);
    expect(events.filter((e) => e.phase === 'hash').pop()).toMatchObject({ done: 2, total: 2 });
    expect(events.filter((e) => e.phase === 'upload').pop()).toMatchObject({ done: 2, total: 2, bytes: 8 });
    const parsed = lines.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(events.length);
    expect(parsed[0]).toMatchObject({ sg: 'progress', key: 'es' });
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('needs --push, and a recorded run, before it touches anything', async () => {
    const { config } = await setup([{ name: 'a.png', content: 'aaaa' }]);
    const nopush = await runPublish(config, { evidence: 'all' });
    expect(nopush.exitCode).toBe(ExitCode.ValidationFailed);
    const norun = await makeRunRepo({ server: { url: server!.url, project: 'demo' } });
    const res = await runPublish(await loadConfig(norun.repo.dir), { push: true, evidence: 'all' });
    expect(res.exitCode).toBe(ExitCode.ValidationFailed);
    expect(res.messages.join('\n')).toContain('no recorded runs');
    expect(server!.snapshots.size).toBe(0);
    const wrong = await runPublish(config, { push: true, evidence: 'all', run: 'nope' });
    expect(wrong.exitCode).toBe(ExitCode.ValidationFailed);
  });

  // [claims: capabilities/team-server#publish-back-compat]
  it('without --evidence a push behaves exactly as before: one snapshot POST and no run routes', async () => {
    const { config } = await setup([{ name: 'a.png', content: 'aaaa' }]);
    const res = await runPublish(config, { push: true });
    expect(res.exitCode).toBe(0);
    expect(server!.log.filter((l) => l.startsWith('POST') || l.startsWith('PUT'))).toEqual(['POST /api/v1/projects/demo/snapshots']);
    expect(server!.manifests.size).toBe(0);
  });
});
