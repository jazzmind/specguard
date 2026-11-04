import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { snapshotDigest, type Snapshot } from '../../src/core/snapshot.js';
import { buildSnapshot } from '../../src/pipelines/publish.js';
import { fileBackend } from '../../src/server/central/file-backend.js';
import type { EvidenceSettings } from '../../src/server/central/config.js';
import { startCentralServer, type RunningCentralServer } from '../../src/server/central/server.js';
import type { RateLimitConfig } from '../../src/server/central/rate-limit.js';
import type { Backend } from '../../src/server/central/backend.js';
import { makeV2Repo } from '../helpers/v2-repo.js';

const BOOTSTRAP = 'bootstrap-secret-for-tests';
const ADA = { 'x-deploykit-email': 'ada@acme.test' };

let server: RunningCentralServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

interface Started {
  base: string;
  backend: Backend;
  maint: Record<string, string>;
  viewer: Record<string, string>;
  scopedA: Record<string, string>;
}

async function start(evidence: Partial<EvidenceSettings> = {}, rateLimit?: RateLimitConfig): Promise<Started> {
  const backend = fileBackend(mkdtempSync(path.join(os.tmpdir(), 'sg-evidence-')));
  server = await startCentralServer({
    backend,
    llm: { provider: 'litellm', model: 'fast', apiKeyEnv: 'NOKEY' },
    port: 0,
    host: '127.0.0.1',
    workDir: mkdtempSync(path.join(os.tmpdir(), 'sg-evidence-work-')),
    auth: { bootstrapToken: BOOTSTRAP, maintainerEmails: ['ada@acme.test'], allowedDomain: 'acme.test', trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] },
    evidence,
    ...(rateLimit ? { rateLimit } : {}),
  });
  const base = server.url;
  const admin = { authorization: `Bearer ${BOOTSTRAP}` };
  for (const name of ['a', 'b']) {
    const res = await fetch(`${base}/api/v1/projects`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    expect(res.status).toBe(201);
  }
  const mint = async (body: Record<string, unknown>): Promise<Record<string, string>> => {
    const res = await fetch(`${base}/api/v1/admin/tokens`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { authorization: `Bearer ${((await res.json()) as { token: string }).token}` };
  };
  return { base, backend, maint: await mint({ name: 'm', role: 'maintainer' }), viewer: await mint({ name: 'v', role: 'viewer' }), scopedA: await mint({ name: 's', role: 'maintainer', project: 'a' }) };
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const bytes = (n: number, fill: number): Buffer => Buffer.alloc(n, fill);

interface Ev {
  path: string;
  buf: Buffer;
  contentType: string;
  kind: 'image' | 'video' | 'trace' | 'file';
}
const ev = (p: string, buf: Buffer, contentType = 'image/png', kind: Ev['kind'] = 'image'): Ev => ({ path: p, buf, contentType, kind });

const emptyGaps = { failed: 0, untested: 0, 'linked-not-executed': 0, 'weak-only': 0, partial: 0, proven: 1 };
function reportFor(runId: string, files: Ev[]): Record<string, unknown> {
  return {
    schema: 'specguard-report/1',
    generatedAt: '2026-11-04T10:00:00.000Z',
    run: { runId, ingestedAt: '2026-11-04T10:00:00.000Z', layers: ['e2e'], formats: ['json'] },
    totals: { tests: { total: 2, pass: 1, fail: 1, skip: 0, byLayer: {} }, claims: { proven: 1, failed: 0, unexercised: 0, untested: 0, byLayer: {} } },
    capabilities: [
      {
        id: 'auth',
        title: 'Sign in',
        counts: emptyGaps,
        claims: [
          {
            ref: 'capabilities/auth#login',
            text: 'A user signs in',
            verdict: 'proven',
            proof: 'proven',
            gap: 'proven',
            reason: 'passed',
            tests: [{ title: 'signs in', file: 'tests/e2e/login.spec.ts', status: 'pass', durationMs: 120, attachments: files.map((f) => ({ name: f.path, kind: f.kind, path: f.path, href: `evidence/${f.path.split('/').map(encodeURIComponent).join('/')}` })) }],
            partialTests: [],
          },
        ],
      },
    ],
    regression: { baseline: null, claims: { newlyFailing: [], newlyProven: [], newlyUnexercised: [], removed: [] }, tests: { newlyFailing: [], newlyPassing: [], added: [], removed: [] }, flaky: [] },
    gaps: { counts: emptyGaps, top: [] },
  };
}

function manifest(project: string, runId: string, files: Ev[], over: Record<string, unknown> = {}, digestTotal = 'digest-1'): Record<string, unknown> {
  return {
    schema: 'specguard-run/1',
    project,
    runId,
    ingestedAt: `2026-11-04T10:00:0${runId.length % 10}.000Z`,
    digest: { v: 1, total: digestTotal, sections: { specs: 's', trace: 't', ledger: 'l', plans: 'p', contracts: 'c' }, files: {} },
    index: { runId, tests: [], claims: [] },
    report: reportFor(runId, files),
    files: Object.fromEntries(files.map((f) => [f.path, { sha256: sha(f.buf), size: f.buf.length, contentType: f.contentType, kind: f.kind }])),
    omitted: [],
    ...over,
  };
}

async function call(base: string, p: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; raw?: Buffer } = {}) {
  const res = await fetch(`${base}${p}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json, buf };
}

const put = (base: string, headers: Record<string, string>, project: string, buf: Buffer, offset = 0, total = buf.length, name = sha(buf)) =>
  call(base, `/api/v1/projects/${project}/blobs/${name}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'upload-offset': String(offset), 'upload-length': String(total) }, raw: buf });

/** Offer a manifest, upload every missing blob in one go, commit. */
async function publishRun(s: Started, project: string, runId: string, files: Ev[], digestTotal = 'digest-1') {
  const offer = await call(s.base, `/api/v1/projects/${project}/runs`, { method: 'POST', headers: s.maint, body: manifest(project, runId, files, {}, digestTotal) });
  expect(offer.status, offer.text).toBe(200);
  for (const hash of offer.json.missing as string[]) {
    const f = files.find((x) => sha(x.buf) === hash)!;
    expect((await put(s.base, s.maint, project, f.buf)).status).toBe(201);
  }
  const commit = await call(s.base, `/api/v1/projects/${project}/runs/${runId}/commit`, { method: 'POST', headers: s.maint });
  return { offer, commit };
}

describe('team server: publish state and digest [evidence]', () => {
  // [claims: capabilities/team-server#publish-digest-check]
  it('lists its features and limits in /health, and answers publish-state with the digest it computed itself [publish-state]', async () => {
    const s = await start({ keepRuns: 3 });
    const health = await call(s.base, '/api/v1/health');
    expect(health.json.features).toEqual(expect.arrayContaining(['publish-state', 'evidence']));
    expect(health.json.limits).toMatchObject({ keepRuns: 3, chunkBytes: 768 * 1024 });

    const none = await call(s.base, '/api/v1/projects/a/publish-state', { headers: s.viewer });
    expect(none.status).toBe(200);
    expect(none.json).toMatchObject({ project: 'a', snapshot: null, runs: [], caller: { role: 'viewer' } });
    expect((await call(s.base, '/api/v1/projects/ghost/publish-state', { headers: s.viewer })).status).toBe(404);

    const snapshot: Snapshot = await buildSnapshot(await loadConfig(makeV2Repo().dir), { project: 'a' });
    // A digest sent by a client is not trusted: the server hashes the content.
    const sent = { ...snapshot, digest: { v: 1, total: 'forged', sections: {}, files: {} } };
    const posted = await call(s.base, '/api/v1/projects/a/snapshots', { method: 'POST', headers: s.maint, body: sent });
    expect(posted.status, posted.text).toBe(201);
    const stored = (await s.backend.snapshots.latest('a'))!;
    expect(posted.json.digest.total).toBe(snapshotDigest(stored.snapshot).total);
    expect(posted.json.digest.total).not.toBe('forged');
    const state = await call(s.base, '/api/v1/projects/a/publish-state', { headers: s.viewer });
    expect(state.json.snapshot.digest.total).toBe(posted.json.digest.total);
    expect(state.json.snapshot.id).toBe(posted.json.snapshotId);
    expect(state.json.features).toContain('evidence');
    expect(state.json.limits.keepRuns).toBe(3);
    // A credential limited to another project cannot ask.
    expect((await call(s.base, '/api/v1/projects/b/publish-state', { headers: s.scopedA })).status).toBe(403);
  });
});

describe('team server: evidence upload and limits [evidence]', () => {
  // [claims: capabilities/team-server#evidence-limits-and-retention]
  it('needs a maintainer, the browser header for sessions, and the right project [evidence-auth]', async () => {
    const s = await start();
    const png = ev('r1/a.png', bytes(100, 1));
    const url = '/api/v1/projects/a/runs';
    expect((await call(s.base, url, { method: 'POST', body: manifest('a', 'r1', [png]) })).status).toBe(401);
    expect((await call(s.base, url, { method: 'POST', headers: s.viewer, body: manifest('a', 'r1', [png]) })).status).toBe(403);
    expect((await call(s.base, url, { method: 'POST', headers: s.scopedA, body: manifest('b', 'r1', [png]) })).status).toBe(400);
    expect((await call(s.base, '/api/v1/projects/b/runs', { method: 'POST', headers: s.scopedA, body: manifest('b', 'r1', [png]) })).status).toBe(403);
    // A signed-in browser session is a maintainer here but must send X-Requested-With for any change.
    expect((await call(s.base, url, { method: 'POST', headers: ADA, body: manifest('a', 'r1', [png]) })).status).toBe(403);
    expect((await call(s.base, url, { method: 'POST', headers: { ...ADA, 'x-requested-with': 'specguard' }, body: manifest('a', 'r1', [png]) })).status).toBe(200);
    const blob = `/api/v1/projects/a/blobs/${sha(png.buf)}`;
    expect((await call(s.base, blob, { method: 'PUT', headers: { ...ADA, 'upload-offset': '0', 'upload-length': '100' }, raw: png.buf })).status).toBe(403);
    expect((await call(s.base, blob, { method: 'PUT', headers: { ...s.viewer, 'upload-offset': '0', 'upload-length': '100' }, raw: png.buf })).status).toBe(403);
    expect((await put(s.base, s.scopedA, 'b', png.buf)).status).toBe(403);
    expect((await call(s.base, blob, { method: 'HEAD', headers: s.scopedA })).status).toBe(404);
    expect((await call(s.base, `/api/v1/projects/b/blobs/${sha(png.buf)}`, { method: 'HEAD', headers: s.scopedA })).status).toBe(403);
    expect((await call(s.base, `${url}/r1`, { method: 'DELETE', headers: s.viewer })).status).toBe(403);
    expect((await call(s.base, url, { headers: s.viewer })).status).toBe(200);
  });

  // [claims: capabilities/team-server#evidence-limits-and-retention]
  it('uploads in chunks, resumes from the offset it reports, verifies the hash and commits only a complete run [chunks]', async () => {
    const s = await start({ chunkBytes: 1000 });
    const big = ev('r1/big.png', Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251)));
    const small = ev('r1/small.webm', bytes(300, 9), 'video/webm', 'video');
    const offer = await call(s.base, '/api/v1/projects/a/runs', { method: 'POST', headers: s.maint, body: manifest('a', 'r1', [big, small]) });
    expect(offer.json).toMatchObject({ runId: 'r1', status: 'pending', chunkBytes: 1000 });
    expect(offer.json.missing.sort()).toEqual([sha(big.buf), sha(small.buf)].sort());

    const head = (h: string) => call(s.base, `/api/v1/projects/a/blobs/${h}`, { method: 'HEAD', headers: s.viewer });
    expect((await head(sha(big.buf))).status).toBe(404);
    const first = await put(s.base, s.maint, 'a', big.buf.subarray(0, 1000), 0, 2500, sha(big.buf));
    expect(first.status).toBe(204);
    expect(first.headers.get('upload-offset')).toBe('1000');
    const partial = await head(sha(big.buf));
    expect(partial.status).toBe(204);
    expect(partial.headers.get('upload-offset')).toBe('1000');
    // A resend of the same chunk, or a skipped one, is told where to resume.
    const again = await put(s.base, s.maint, 'a', big.buf.subarray(0, 1000), 0, 2500, sha(big.buf));
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: 'offset-mismatch', expectedOffset: 1000 });
    expect((await put(s.base, s.maint, 'a', big.buf.subarray(2000), 2000, 2500, sha(big.buf))).json.expectedOffset).toBe(1000);
    // The run is not complete yet.
    const early = await call(s.base, '/api/v1/projects/a/runs/r1/commit', { method: 'POST', headers: s.maint });
    expect(early.status).toBe(409);
    expect(early.json).toMatchObject({ code: 'incomplete' });
    expect(early.json.missing).toHaveLength(2);
    expect((await put(s.base, s.maint, 'a', big.buf.subarray(1000, 2000), 1000, 2500, sha(big.buf))).status).toBe(204);
    const last = await put(s.base, s.maint, 'a', big.buf.subarray(2000), 2000, 2500, sha(big.buf));
    expect(last.status).toBe(201);
    expect((await head(sha(big.buf))).status).toBe(200);
    expect((await put(s.base, s.maint, 'a', small.buf)).status).toBe(201);
    const done = await call(s.base, '/api/v1/projects/a/runs/r1/commit', { method: 'POST', headers: s.maint });
    expect(done.json).toMatchObject({ runId: 'r1', status: 'complete', files: 2, bytes: 2800, pruned: { runs: [], blobs: 0 } });
    // Offering the same run again is a no-op that is already complete.
    const redo = await call(s.base, '/api/v1/projects/a/runs', { method: 'POST', headers: s.maint, body: manifest('a', 'r1', [big, small]) });
    expect(redo.json).toMatchObject({ status: 'complete', missing: [] });
    const runs = await call(s.base, '/api/v1/projects/a/runs', { headers: s.viewer });
    expect(runs.json).toHaveLength(1);
    expect(runs.json[0]).toMatchObject({ runId: 'r1', status: 'complete', files: 2, bytes: 2800, tests: { total: 2, pass: 1, fail: 1 } });
  });

  // [claims: capabilities/team-server#evidence-limits-and-retention]
  it('refuses a blob nobody asked for, a bad name, and bytes that do not hash to their name, discarding the partial [refusals]', async () => {
    const s = await start();
    const good = ev('r1/a.png', bytes(500, 3));
    await call(s.base, '/api/v1/projects/a/runs', { method: 'POST', headers: s.maint, body: manifest('a', 'r1', [good]) });
    const stray = bytes(10, 7);
    expect((await put(s.base, s.maint, 'a', stray)).json).toMatchObject({ code: 'not-requested' });
    expect((await put(s.base, s.maint, 'a', stray, 0, 10, 'abc')).status).toBe(400);
    expect((await call(s.base, '/api/v1/projects/a/blobs/abc', { method: 'HEAD', headers: s.viewer })).status).toBe(400);
    // Other bytes sent under the requested name.
    const wrong = await put(s.base, s.maint, 'a', bytes(500, 4), 0, 500, sha(good.buf));
    expect(wrong.status).toBe(422);
    expect(wrong.json.code).toBe('hash-mismatch');
    expect((await call(s.base, `/api/v1/projects/a/blobs/${sha(good.buf)}`, { method: 'HEAD', headers: s.viewer })).status).toBe(404);
    expect((await put(s.base, s.maint, 'a', good.buf)).status).toBe(201);
    // Missing headers.
    expect((await call(s.base, `/api/v1/projects/a/blobs/${sha(good.buf)}`, { method: 'PUT', headers: s.maint, raw: good.buf })).status).toBe(400);
    // A manifest that is not one, or is for another project.
    expect((await call(s.base, '/api/v1/projects/a/runs', { method: 'POST', headers: s.maint, body: { schema: 'nope' } })).status).toBe(400);
    expect((await call(s.base, '/api/v1/projects/a/runs', { method: 'POST', headers: s.maint, body: manifest('b', 'r9', []) })).status).toBe(400);
    expect((await call(s.base, '/api/v1/projects/ghost/runs', { method: 'POST', headers: s.maint, body: manifest('ghost', 'r9', []) })).status).toBe(404);
  });

  // [claims: capabilities/team-server#evidence-limits-and-retention]
  it('refuses a chunk over the limit (a 1 MB body), a file over the cap, a run over its cap and a full store with structured errors [limits]', async () => {
    const one = await start();
    const mb = bytes(1024 * 1024, 5);
    await call(one.base, '/api/v1/projects/a/runs', { method: 'POST', headers: one.maint, body: manifest('a', 'r1', [ev('r1/mb.webm', mb, 'video/webm', 'video')]) });
    const big = await put(one.base, one.maint, 'a', mb);
    expect(big.status).toBe(413);
    expect(big.json).toMatchObject({ code: 'chunk-too-large', limit: 768 * 1024 });
    await server?.close();

    const small = await start({ maxFileBytes: 1500, maxRunBytes: 2000, maxTotalBytes: 3000 });
    const files = [ev('r/a.png', bytes(1600, 1)), ev('r/b.png', bytes(1000, 2))];
    const fileRes = await call(small.base, '/api/v1/projects/a/runs', { method: 'POST', headers: small.maint, body: manifest('a', 'r1', files) });
    expect(fileRes.status).toBe(413);
    expect(fileRes.json).toMatchObject({ code: 'file-too-large', limit: 1500, files: [{ path: 'r/a.png', size: 1600 }] });
    const runRes = await call(small.base, '/api/v1/projects/a/runs', { method: 'POST', headers: small.maint, body: manifest('a', 'r1', [ev('r/1', bytes(1000, 1)), ev('r/2', bytes(1000, 2)), ev('r/3', bytes(1000, 3))]) });
    expect(runRes.status).toBe(413);
    expect(runRes.json).toMatchObject({ code: 'run-too-large', bytes: 3000, limit: 2000 });
    expect((await put(small.base, small.maint, 'a', bytes(1600, 1))).status).toBe(413);
    expect((await put(small.base, small.maint, 'a', bytes(900, 1))).status).toBe(409);
    // Room for one run, not two.
    expect((await publishRun(small, 'a', 'ok', [ev('r/x', bytes(1000, 5)), ev('r/y', bytes(1000, 6))])).commit.status).toBe(200);
    const full = await call(small.base, '/api/v1/projects/b/runs', { method: 'POST', headers: small.maint, body: manifest('b', 'r1', [ev('r/z', bytes(1200, 8))]) });
    expect(full.status).toBe(507);
    expect(full.json.code).toBe('storage-full');
  });

  // [claims: capabilities/team-server#evidence-limits-and-retention]
  it('keeps the newest runs, deletes blobs no kept run refers to and old partial uploads, and scopes blobs to a project [retention]', async () => {
    const s = await start({ keepRuns: 2 });
    const shared = ev('r/shared.png', bytes(200, 1));
    const own = (n: number) => ev(`r/own${n}.png`, bytes(200, 10 + n));
    for (const n of [1, 2, 3]) {
      const { commit } = await publishRun(s, 'a', `run-${n}`, [shared, own(n)]);
      expect(commit.status, commit.text).toBe(200);
      if (n === 3) expect(commit.json.pruned).toEqual({ runs: ['run-1'], blobs: 1 });
    }
    const list = (await call(s.base, '/api/v1/projects/a/runs', { headers: s.viewer })).json.map((r: { runId: string }) => r.runId);
    expect(list).toEqual(['run-3', 'run-2']);
    const head = (p: string, b: Buffer) => call(s.base, `/api/v1/projects/${p}/blobs/${sha(b)}`, { method: 'HEAD', headers: s.viewer }).then((r) => r.status);
    expect(await head('a', own(1).buf)).toBe(404);
    expect(await head('a', own(2).buf)).toBe(200);
    expect(await head('a', shared.buf)).toBe(200);
    // Another project does not see a's blobs, and is asked for them again.
    expect(await head('b', shared.buf)).toBe(404);
    const offer = await call(s.base, '/api/v1/projects/b/runs', { method: 'POST', headers: s.maint, body: manifest('b', 'r1', [shared]) });
    expect(offer.json.missing).toEqual([sha(shared.buf)]);
    // A partial upload nobody finishes goes after a day.
    const half = bytes(400, 77);
    await call(s.base, '/api/v1/projects/b/runs', { method: 'POST', headers: s.maint, body: manifest('b', 'r2', [ev('r/half.png', half)]) });
    expect((await put(s.base, s.maint, 'b', half.subarray(0, 100), 0, 400, sha(half))).status).toBe(204);
    const store = s.backend.evidence('b');
    expect((await store.gc(2)).blobs).toBe(0);
    await store.deleteRun('r2');
    const swept = await store.gc(2, Date.now() + 25 * 60 * 60 * 1000);
    expect(swept.blobs).toBeGreaterThanOrEqual(1);
    expect(await store.blobState(sha(half))).toBeUndefined();
    // Deleting a run frees its blobs; deleting again is a 404.
    const del = await call(s.base, '/api/v1/projects/a/runs/run-2', { method: 'DELETE', headers: s.maint });
    expect(del.status).toBe(200);
    expect(await head('a', own(2).buf)).toBe(404);
    expect((await call(s.base, '/api/v1/projects/a/runs/run-2', { method: 'DELETE', headers: s.maint })).status).toBe(404);
    // Every change is in the audit trail.
    const actions = (await s.backend.readAudit(100)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['run.publish', 'run.prune', 'run.delete']));
  });

  // [claims: capabilities/team-server#evidence-limits-and-retention]
  it('counts blob requests in their own rate bucket, not the general one [upload-bucket]', async () => {
    const s = await start({}, { perMinute: 5, docsPerMinute: 30, anonymousPerMinute: 60, uploadPerMinute: 1000 });
    const h = ev('r/h.png', bytes(50, 2));
    const blob = `/api/v1/projects/a/blobs/${sha(h.buf)}`;
    for (let i = 0; i < 12; i += 1) expect((await call(s.base, blob, { method: 'HEAD', headers: s.maint })).status).toBe(404);
    // Everything else still counts against the 5 a minute.
    let last = 0;
    for (let i = 0; i < 8; i += 1) last = (await call(s.base, '/api/v1/projects/a/runs', { headers: s.maint })).status;
    expect(last).toBe(429);
  });
});

describe('team server: serving a run [evidence]', () => {
  const png = ev('r1/shot.png', Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
  const svg = ev('r1/pic.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml', 'image');
  const webm = ev('r1/clip.webm', bytes(500, 4), 'video/webm', 'video');
  const trace = ev('r1/trace.zip', bytes(300, 6), 'application/zip', 'trace');
  const page = ev('r1/page.html', Buffer.from('<h1>hi</h1>'), 'text/html', 'file');
  const files = [png, svg, webm, trace, page];

  async function withRun() {
    const s = await start();
    expect((await publishRun(s, 'a', 'r1', files)).commit.status).toBe(200);
    return s;
  }
  const evUrl = (id: string, p: string) => `/api/v1/projects/a/runs/${id}/report/evidence/${p.split('/').map(encodeURIComponent).join('/')}`;

  // [claims: capabilities/team-server#evidence-serving-safety]
  it('shows images and video in place, makes everything else a download, and marks every blob response as inert [inline-vs-attachment]', async () => {
    const s = await withRun();
    const image = await call(s.base, evUrl('r1', png.path), { headers: s.viewer });
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('content-disposition')).toBe('inline');
    expect(image.buf.equals(png.buf)).toBe(true);
    expect((await call(s.base, evUrl('latest', webm.path), { headers: s.viewer })).headers.get('content-disposition')).toBe('inline');
    for (const f of [svg, trace, page]) {
      const res = await call(s.base, evUrl('r1', f.path), { headers: s.viewer });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition'), f.path).toMatch(/^attachment; filename="/);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
    }
    for (const f of files) {
      const res = await call(s.base, evUrl('r1', f.path), { headers: s.viewer });
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe('sandbox');
      expect(res.headers.get('cache-control')).toMatch(/^private/);
      expect(res.headers.get('etag')).toBe(`"${sha(f.buf)}"`);
    }
    const again = await call(s.base, evUrl('r1', png.path), { headers: { ...s.viewer, 'if-none-match': `"${sha(png.buf)}"` } });
    expect(again.status).toBe(304);
    expect((await call(s.base, evUrl('r1', png.path))).status).toBe(401);
  });

  // [claims: capabilities/team-server#evidence-serving-safety]
  it('honours byte ranges [range]', async () => {
    const s = await withRun();
    const url = evUrl('r1', png.path);
    const r = await call(s.base, url, { headers: { ...s.viewer, range: 'bytes=10-19' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.buf.equals(png.buf.subarray(10, 20))).toBe(true);
    const tail = await call(s.base, url, { headers: { ...s.viewer, range: 'bytes=-5' } });
    expect(tail.buf.equals(png.buf.subarray(995))).toBe(true);
    const open = await call(s.base, url, { headers: { ...s.viewer, range: 'bytes=990-' } });
    expect(open.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect((await call(s.base, url, { headers: { ...s.viewer, range: 'bytes=5000-6000' } })).status).toBe(416);
    expect((await call(s.base, url, { method: 'HEAD', headers: s.viewer })).headers.get('content-length')).toBe('1000');
  });

  // [claims: capabilities/team-server#evidence-serving-safety]
  it('looks evidence up in the manifest only, so a path that climbs or is not listed is a 404 [traversal]', async () => {
    const s = await withRun();
    const base = '/api/v1/projects/a/runs/r1/report/evidence';
    for (const p of ['..%2F..%2Fetc%2Fpasswd', '%2e%2e/%2e%2e/%2e%2e/etc/passwd', '..%5C..%5Csecret', 'r1/nope.png', '%2Fetc%2Fpasswd', 'r1%2F..%2Fr1%2Fshot.png', '__proto__', 'constructor', `${sha(png.buf)}`]) {
      const res = await call(s.base, `${base}/${p}`, { headers: s.viewer });
      expect(res.status, p).toBe(404);
      expect(res.buf.length < 300, p).toBe(true);
    }
    expect((await call(s.base, evUrl('missing-run', png.path), { headers: s.viewer })).status).toBe(404);
    // A project-scoped credential of another project cannot read it either.
    expect((await call(s.base, evUrl('r1', png.path), { headers: s.scopedA })).status).toBe(200);
    expect((await call(s.base, `/api/v1/projects/b/runs/r1/report/evidence/${png.path}`, { headers: s.scopedA })).status).toBe(403);
  });

  // [claims: capabilities/team-server#server-test-report]
  it('renders the run report from the stored data, with links that stay on the server and no local file links [report]', async () => {
    const s = await withRun();
    for (const id of ['r1', 'latest']) {
      const res = await call(s.base, `/api/v1/projects/a/runs/${id}/report/index.html`, { headers: s.viewer });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(res.text).toContain('SpecGuard test report');
      expect(res.text).toContain('capabilities/auth#login');
      expect(res.text).toContain('href="evidence/r1/shot.png"');
      expect(res.text).not.toContain('file://');
    }
    const data = await call(s.base, '/api/v1/projects/a/runs/latest/report/report.json', { headers: s.viewer });
    expect(data.json.schema).toBe('specguard-report/1');
    const run = await call(s.base, '/api/v1/projects/a/runs/r1', { headers: s.viewer });
    expect(run.json).toMatchObject({ runId: 'r1', status: 'complete' });
    expect(Object.keys(run.json.files)).toContain('r1/shot.png');
    expect((await call(s.base, '/api/v1/projects/b/runs/latest/report/index.html', { headers: s.viewer })).status).toBe(404);
  });

  // [claims: capabilities/team-server#server-test-report]
  it('masks credentials in what a client published before storing it [redaction]', async () => {
    const s = await start();
    const secret = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
    const m = manifest('a', 'r1', [], { label: `ci ${secret}`, index: { runId: 'r1', tests: [{ title: `uses ${secret}` }], claims: [] } });
    expect((await call(s.base, '/api/v1/projects/a/runs', { method: 'POST', headers: s.maint, body: m })).status).toBe(200);
    const stored = await call(s.base, '/api/v1/projects/a/runs/r1', { headers: s.viewer });
    expect(stored.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCDEF');
  });

  // [claims: capabilities/team-server#server-test-report]
  it('builds a workspace report from each member project\'s newest run, with a drill-down and the evidence behind it [workspace-report]', async () => {
    const s = await withRun();
    const def = { projects: [{ project: 'a', key: 'alpha', role: 'app' }, { project: 'b', key: 'beta' }] };
    expect((await call(s.base, '/api/v1/workspaces/sys', { method: 'PUT', headers: s.maint, body: def })).status).toBe(200);
    const index = await call(s.base, '/api/v1/workspaces/sys/report/index.html', { headers: s.viewer });
    expect(index.status).toBe(200);
    expect(index.text).toContain('sys');
    expect(index.text).toContain('href="repos/alpha/index.html"');
    expect(index.text).toContain('beta');
    expect(index.text).toContain('no test run has been published');
    expect(index.text).not.toContain('file://');
    const json = await call(s.base, '/api/v1/workspaces/sys/workspace-report.json', { headers: s.viewer });
    expect(json.json).toMatchObject({ schema: 'specguard-workspace-report/1', workspace: 'sys', totals: { repos: 2, tests: 2 } });
    const repo = await call(s.base, '/api/v1/workspaces/sys/report/repos/alpha/index.html', { headers: s.viewer });
    expect(repo.status).toBe(200);
    expect(repo.text).toContain('href="../../index.html"');
    expect(repo.text).toContain('href="evidence/r1/shot.png"');
    const image = await call(s.base, `/api/v1/workspaces/sys/report/repos/alpha/evidence/r1/shot.png`, { headers: s.viewer });
    expect(image.status).toBe(200);
    expect(image.buf.equals(png.buf)).toBe(true);
    expect((await call(s.base, '/api/v1/workspaces/sys/report/repos/beta/index.html', { headers: s.viewer })).status).toBe(404);
    expect((await call(s.base, '/api/v1/workspaces/none/report/index.html', { headers: s.viewer })).status).toBe(404);
    // A credential limited to one project reaches only a workspace made of that project alone.
    expect((await call(s.base, '/api/v1/workspaces/sys/report/index.html', { headers: s.scopedA })).status).toBe(404);
  });
});
