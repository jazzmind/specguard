import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { buildSnapshot } from '../../src/pipelines/publish.js';
import { fileBackend } from '../../src/server/central/file-backend.js';
import { createPuller, findSnapshotInZip } from '../../src/server/central/puller.js';
import { centralRegistry } from '../../src/server/central/registry.js';
import { makeV2Repo } from '../helpers/v2-repo.js';

const LLM = { provider: 'litellm', model: 'fast', apiKeyEnv: 'NOKEY' };

async function setup() {
  const backend = fileBackend(mkdtempSync(path.join(os.tmpdir(), 'sg-puller-')));
  const registry = centralRegistry({ backend, llm: LLM, workDir: mkdtempSync(path.join(os.tmpdir(), 'sg-puller-work-')) });
  const snapshot = await buildSnapshot(await loadConfig(makeV2Repo().dir), { project: 'something-else' });
  const zipOf = (text: string, root = 'publish') => zipSync({ [`${root}/snapshot.json`]: strToU8(text), [`${root}/readme.txt`]: strToU8('hi') });
  return { backend, registry, snapshot, zipOf };
}

type Artifact = { id: number; created_at: string; sha: string; branch?: string; expired?: boolean; fork?: boolean; zip: Uint8Array | 'fail'; size?: number };

/** A fake GitHub: an artifact list and downloads. */
function github(artifacts: Artifact[]) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/actions/artifacts?')) {
      return new Response(
        JSON.stringify({
          artifacts: artifacts.map((a) => ({
            id: a.id, name: 'specguard-evidence', expired: a.expired ?? false, size_in_bytes: a.size ?? 1000, created_at: a.created_at,
            archive_download_url: `https://api.github.com/download/${a.id}`,
            workflow_run: { id: a.id, repository_id: 1, head_repository_id: a.fork ? 2 : 1, head_branch: a.branch, head_sha: a.sha },
          })),
        }),
        { status: 200 },
      );
    }
    const id = Number(u.split('/').pop());
    const hit = artifacts.find((a) => a.id === id);
    if (!hit || hit.zip === 'fail') return new Response('nope', { status: 500 });
    return new Response(hit.zip as unknown as BodyInit, { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe('GitHub artifact puller [puller]', () => {
  // [claims: capabilities/team-server#artifact-puller]
  it('publishes each new artifact under the configured project, with commit and branch from the run [publish]', async () => {
    const { backend, registry, snapshot, zipOf } = await setup();
    const gh = github([{ id: 1, created_at: '2026-10-15T10:00:00Z', sha: 'aaaa1111bbbb2222', branch: 'main', zip: zipOf(JSON.stringify(snapshot)) }]);
    const puller = createPuller({ sources: [{ repo: 'acme/app', project: 'app' }], token: 'ghp_test', registry, backend, fetchImpl: gh.fetchImpl });
    const [result] = await puller.pollOnce();
    expect(result).toMatchObject({ repo: 'acme/app', published: 1, skipped: 0 });
    const latest = await backend.snapshots.latest('app');
    expect(latest!.record).toMatchObject({ project: 'app', commit: 'aaaa1111bbbb2222', branch: 'main', origin: 'ci' });
    expect(latest!.snapshot).toMatchObject({ project: 'app', repo: 'acme/app', commit: 'aaaa1111bbbb2222' });
    // The token goes to GitHub as a bearer credential.
    const call = (gh.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((call[1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer ghp_test');
    expect((await backend.readAudit()).map((a) => a.action)).toEqual(['snapshot.pull']);
  });

  // [claims: capabilities/team-server#artifact-puller]
  it('does not fetch what it already has, and skips expired, forked, oversized and broken artifacts [skips]', async () => {
    const { backend, registry, snapshot, zipOf } = await setup();
    const good = zipOf(JSON.stringify(snapshot));
    const gh = github([
      { id: 1, created_at: '2026-10-15T10:00:00Z', sha: 'sha-good', branch: 'main', zip: good },
      { id: 2, created_at: '2026-10-15T10:01:00Z', sha: 'sha-expired', branch: 'main', expired: true, zip: good },
      { id: 3, created_at: '2026-10-15T10:02:00Z', sha: 'sha-fork', branch: 'main', fork: true, zip: good },
      { id: 4, created_at: '2026-10-15T10:03:00Z', sha: 'sha-big', branch: 'main', size: 500 * 1024 * 1024, zip: good },
      { id: 5, created_at: '2026-10-15T10:04:00Z', sha: 'sha-broken', branch: 'main', zip: zipOf('{ not json') },
      { id: 6, created_at: '2026-10-15T10:05:00Z', sha: 'sha-fails', branch: 'main', zip: 'fail' },
      { id: 7, created_at: '2026-10-15T10:06:00Z', sha: 'sha-nosnap', branch: 'main', zip: zipSync({ 'other.txt': strToU8('x') }) },
    ]);
    const puller = createPuller({ sources: [{ repo: 'acme/app', project: 'app' }], registry, backend, fetchImpl: gh.fetchImpl });
    expect((await puller.pollOnce())[0]).toMatchObject({ published: 1, skipped: 6 });
    // A second poll downloads nothing it has already stored; only the retryable failures are tried again.
    const downloads = () => gh.calls.filter((c) => c.includes('/download/')).map((c) => c.split('/').pop());
    gh.calls.length = 0;
    expect((await puller.pollOnce())[0]).toMatchObject({ published: 0 });
    expect(downloads()).not.toContain('1');
    expect(downloads()).not.toContain('2');
    expect(downloads()).not.toContain('3');
  });

  // [claims: capabilities/team-server#artifact-puller]
  it('reports a GitHub error for one repository and carries on with the next [error-isolation]', async () => {
    const { backend, registry, snapshot, zipOf } = await setup();
    const ok = github([{ id: 9, created_at: '2026-10-15T10:00:00Z', sha: 'sha9', branch: 'main', zip: zipOf(JSON.stringify(snapshot)) }]);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/repos/acme/broken/')) return new Response('forbidden', { status: 403 });
      return (ok.fetchImpl as unknown as (u: unknown, i?: unknown) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const puller = createPuller({ sources: [{ repo: 'acme/broken', project: 'broken' }, { repo: 'acme/app', project: 'app' }], registry, backend, fetchImpl, log: (l) => lines.push(l) });
    const results = await puller.pollOnce();
    expect(results[0].error).toContain('403');
    expect(results[1]).toMatchObject({ published: 1 });
    expect(lines.join('\n')).toContain('acme/broken');
  });

  // [claims: capabilities/team-server#artifact-puller]
  it('finds the snapshot wherever the upload put the archive root [zip-layouts]', async () => {
    const { snapshot } = await setup();
    const text = JSON.stringify(snapshot);
    for (const root of ['publish', '.specguard/publish', 'a/b/publish']) {
      expect(findSnapshotInZip(zipSync({ [`${root}/snapshot.json`]: strToU8(text) }))).toBe(text);
    }
    expect(findSnapshotInZip(zipSync({ 'snapshot.json': strToU8(text) }))).toBe(text);
    expect(findSnapshotInZip(zipSync({ 'readme.txt': strToU8('x') }))).toBeUndefined();
  });
});
