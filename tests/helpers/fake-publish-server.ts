import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';

import { snapshotDigest, type Snapshot } from '../../src/core/snapshot.js';

/**
 * A small in-memory stand-in for the team server's publish routes (snapshots, publish-state, runs, blobs, workspaces),
 * speaking the wire protocol in the plan. Chunk uploads are checked for offsets and the final hash like the real server.
 */
export interface FakeServerOpts {
  /** `false` answers 404 to `publish-state` and omits `features` from health (an older server). */
  modern?: boolean;
  features?: string[];
  chunkBytes?: number;
  maxFileBytes?: number;
  /** Fail this many PUTs with 503 before accepting any. */
  failPuts?: number;
  /** Answer the first PUT with 409 offset-mismatch (expectedOffset 0) once. */
  mismatchOnce?: boolean;
  /** Require this bearer token on /api/v1 routes except health. */
  token?: string;
}

export interface FakeServer {
  url: string;
  close(): Promise<void>;
  snapshots: Map<string, Snapshot[]>;
  manifests: Map<string, Array<{ manifest: any; status: 'pending' | 'complete' }>>;
  blobs: Map<string, Buffer>;
  partials: Map<string, Buffer>;
  workspaces: Map<string, any>;
  /** Every request as `METHOD path`, in order. */
  log: string[];
  putSizes: number[];
  opts: FakeServerOpts;
}

export async function startFakeServer(opts: FakeServerOpts = {}): Promise<FakeServer> {
  const modern = opts.modern !== false;
  const state: FakeServer = { url: '', close: async () => undefined, snapshots: new Map(), manifests: new Map(), blobs: new Map(), partials: new Map(), workspaces: new Map(), log: [], putSizes: [], opts };
  const chunkBytes = opts.chunkBytes ?? 768 * 1024;
  let failPuts = opts.failPuts ?? 0;
  let mismatchOnce = opts.mismatchOnce ?? false;
  const limits = { maxFileBytes: opts.maxFileBytes ?? 100 * 1024 * 1024, maxRunBytes: 1024 * 1024 * 1024, chunkBytes, keepRuns: 5 };
  const features = opts.features ?? ['publish-state', 'evidence'];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    state.log.push(`${req.method} ${p}`);
    const send = (status: number, json?: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers });
      res.end(json === undefined ? undefined : JSON.stringify(json));
    };
    if (p === '/api/v1/health') return send(200, { ok: true, version: 1, apiVersion: 1, engineVersion: 'x', hashVersion: 1, writable: true, ...(modern ? { features, limits } : {}) });
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return send(401, { error: 'sign in' });

    const parts = p.replace('/api/v1/', '').split('/').map(decodeURIComponent);
    if (parts[0] === 'workspaces' && parts.length === 2) {
      if (req.method === 'PUT') {
        state.workspaces.set(parts[1], JSON.parse(body.toString()));
        return send(200, state.workspaces.get(parts[1]));
      }
      const def = state.workspaces.get(parts[1]);
      return def ? send(200, def) : send(404, { error: 'no workspace' });
    }
    if (parts[0] !== 'projects') return send(404, { error: 'no route' });
    const project = parts[1];
    const rest = parts.slice(2);
    const snaps = state.snapshots.get(project) ?? [];
    const latest = snaps[snaps.length - 1];
    const runs = state.manifests.get(project) ?? [];

    if (rest.length === 0 && req.method === 'GET') {
      if (!latest) return send(200, { name: project, kind: 'pending' });
      return send(200, { name: project, kind: 'snapshot', commit: latest.commit, branch: latest.branch, updatedAt: latest.createdAt });
    }
    if (rest[0] === 'publish-state') {
      if (!modern) return send(404, { error: 'no route' });
      return send(200, {
        project,
        caller: { user: 'ada@acme.test', role: 'maintainer' },
        snapshot: latest ? { id: `snap-${snaps.length}`, createdAt: latest.createdAt, commit: latest.commit, branch: latest.branch, digest: snapshotDigest(latest) } : null,
        runs: runs.map((r) => ({ runId: r.manifest.runId, label: r.manifest.label, ingestedAt: r.manifest.ingestedAt, status: r.status, files: Object.keys(r.manifest.files).length, bytes: Object.values<any>(r.manifest.files).reduce((n, f) => n + f.size, 0), createdAt: r.manifest.ingestedAt })),
        limits,
        features,
      });
    }
    if (rest[0] === 'snapshots' && req.method === 'POST') {
      const snap = JSON.parse(body.toString()) as Snapshot;
      state.snapshots.set(project, [...snaps, snap]);
      return send(201, { snapshotId: `snap-${snaps.length + 1}`, project });
    }
    if (rest[0] === 'runs' && rest.length === 1 && req.method === 'POST') {
      const manifest = JSON.parse(body.toString());
      const big = Object.entries<any>(manifest.files).filter(([, f]) => f.size > limits.maxFileBytes).map(([path, f]) => ({ path, size: f.size }));
      if (big.length > 0) return send(413, { code: 'file-too-large', files: big, limit: limits.maxFileBytes });
      const missing = [...new Set(Object.values<any>(manifest.files).map((f) => f.sha256))].filter((sha) => !state.blobs.has(sha));
      const existing = runs.find((r) => r.manifest.runId === manifest.runId);
      if (existing) existing.manifest = manifest;
      else state.manifests.set(project, [...runs, { manifest, status: 'pending' }]);
      const status = missing.length === 0 && existing?.status === 'complete' ? 'complete' : 'pending';
      return send(200, { runId: manifest.runId, status, missing, chunkBytes });
    }
    if (rest[0] === 'runs' && rest[2] === 'commit' && req.method === 'POST') {
      const run = runs.find((r) => r.manifest.runId === rest[1]);
      if (!run) return send(404, { error: 'no run' });
      const missing = Object.values<any>(run.manifest.files).map((f) => f.sha256).filter((sha) => !state.blobs.has(sha));
      if (missing.length > 0) return send(409, { code: 'incomplete', missing });
      run.status = 'complete';
      return send(200, { runId: run.manifest.runId, status: 'complete', files: Object.keys(run.manifest.files).length, bytes: Object.values<any>(run.manifest.files).reduce((n, f) => n + f.size, 0), pruned: { runs: [], blobs: 0 } });
    }
    if (rest[0] === 'blobs' && rest.length === 2) {
      const sha = rest[1];
      if (req.method === 'HEAD') {
        if (state.blobs.has(sha)) return send(200);
        const part = state.partials.get(sha);
        return part ? send(204, undefined, { 'Upload-Offset': String(part.length) }) : send(404);
      }
      if (req.method === 'PUT') {
        if (!runs.some((r) => Object.values<any>(r.manifest.files).some((f) => f.sha256 === sha))) return send(409, { code: 'not-requested' });
        if (failPuts > 0) {
          failPuts -= 1;
          return send(503, { error: 'busy' });
        }
        if (body.length > chunkBytes) return send(413, { error: 'chunk too large' });
        const offset = Number(req.headers['upload-offset']);
        const total = Number(req.headers['upload-length']);
        const have = state.partials.get(sha) ?? Buffer.alloc(0);
        if (mismatchOnce) {
          mismatchOnce = false;
          return send(409, { code: 'offset-mismatch', expectedOffset: have.length });
        }
        if (offset !== have.length) return send(409, { code: 'offset-mismatch', expectedOffset: have.length });
        state.putSizes.push(body.length);
        const next = Buffer.concat([have, body]);
        if (next.length < total) {
          state.partials.set(sha, next);
          return send(204, undefined, { 'Upload-Offset': String(next.length) });
        }
        state.partials.delete(sha);
        if (createHash('sha256').update(next).digest('hex') !== sha) return send(422, { code: 'hash-mismatch' });
        state.blobs.set(sha, next);
        return send(201);
      }
    }
    return send(404, { error: 'no route' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}
