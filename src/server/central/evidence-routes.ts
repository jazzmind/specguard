/**
 * The team server's publish-state and test-evidence routes: run manifests, resumable blob uploads, and the report and
 * evidence a run serves.
 *
 * These write to the response themselves (`Api.handle` returns strings) because blobs are binary and a chunk must not be
 * read as UTF-8. The listener calls `match` before it reads a request body: a blob PUT is streamed here, every other
 * route gets its (JSON) body read as usual and passed in.
 *
 * Everything is under `/api/v1`, so the sign-in header and tokens apply. Evidence is looked up by the path the run's
 * manifest lists and is never joined to a filesystem path.
 *
 * Spec: specs/capabilities/team-server.md
 */
import type http from 'node:http';
import { once } from 'node:events';

import { RunManifestSchema, SERVER_FEATURES, type PublishState, type RunManifest, type RunOffer } from '../../core/publish-contract.js';
import { createSecretRedactor } from '../../core/redact.js';
import type { ReportData } from '../../pipelines/report.js';
import { renderReportHtml } from '../../pipelines/report.js';
import { renderWorkspaceReportHtml, repoEntryFromData, rollupWorkspace, type WorkspaceRepoReport } from '../../pipelines/workspace-report.js';
import { HTML_SECURITY_HEADERS, type Identity } from '../api.js';
import { EvidenceError, PROJECT_NAME, WORKSPACE_NAME, manifestBlobs, type Backend, type RunListing } from './backend.js';
import type { EvidenceSettings } from './config.js';

const SHA256 = /^[0-9a-f]{64}$/;
const ROLE_RANK: Record<Identity['role'], number> = { viewer: 1, maintainer: 2, admin: 3 };

/** The types a browser may show in place. Everything else, SVG and HTML included, downloads. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/webm', 'video/mp4']);

/** How much of a refused upload is read and thrown away, so the client sees the refusal rather than a reset. */
const DRAIN_LIMIT = 8 * 1024 * 1024;

export interface EvidenceRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  /** Path segments after `/api/v1`, percent-decoded. */
  parts: string[];
  identity: Identity;
  /** The request body, for routes that are not `stream`ed. */
  body?: string;
}

export interface EvidenceRoutes {
  /** Whether a route is one of these, and whether its body must be left unread for the handler to stream. */
  match(method: string, parts: string[]): { stream: boolean } | undefined;
  /** Whether a request counts against the upload rate bucket instead of the general one. */
  isUpload(method: string, parts: string[]): boolean;
  handle(ctx: EvidenceRouteContext): Promise<void>;
  limits(): { maxFileBytes: number; maxRunBytes: number; chunkBytes: number; keepRuns: number };
  features: string[];
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n`. `undefined`: no usable range (send everything); `'invalid'`: 416. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  if (size === 0) return 'invalid';
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return 'invalid';
  return { start, end };
}

function deepRedact<T>(value: T, text: (s: string) => string): T {
  if (typeof value === 'string') return text(value) as T;
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, text)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepRedact(v, text)])) as T;
  return value;
}

export function createEvidenceRoutes(opts: { backend: Backend; settings: EvidenceSettings }): EvidenceRoutes {
  const { backend, settings } = opts;
  const redactor = createSecretRedactor();
  const features: string[] = [SERVER_FEATURES.publishState, SERVER_FEATURES.evidence];
  const limits = () => ({ maxFileBytes: settings.maxFileBytes, maxRunBytes: settings.maxRunBytes, chunkBytes: settings.chunkBytes, keepRuns: settings.keepRuns });

  const audit = (actor: string, action: string, project: string, detail: string): void => void backend.audit({ at: new Date().toISOString(), actor, action, project, detail }).catch(() => undefined);

  const reply = (ctx: EvidenceRouteContext, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void => {
    const length = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
    ctx.res.writeHead(status, { 'Content-Type': type, 'Content-Length': String(length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...extra });
    ctx.res.end(ctx.method === 'HEAD' ? undefined : body);
  };
  const json = (ctx: EvidenceRouteContext, status: number, value: unknown, extra?: Record<string, string>): void => reply(ctx, status, 'application/json; charset=utf-8', JSON.stringify(value), extra);
  const html = (ctx: EvidenceRouteContext, body: string): void => reply(ctx, 200, 'text/html; charset=utf-8', body, HTML_SECURITY_HEADERS);

  /** A credential limited to one project reaches only that project. Returns true (after replying) when refused. */
  const refuseScope = (ctx: EvidenceRouteContext, project: string): boolean => {
    if (ctx.identity.project && ctx.identity.project !== project) {
      json(ctx, 403, { error: `this credential is limited to project "${ctx.identity.project}"` });
      return true;
    }
    return false;
  };
  const refuseWrite = (ctx: EvidenceRouteContext, project: string): boolean => {
    if (ROLE_RANK[ctx.identity.role] < ROLE_RANK.maintainer) {
      void backend.audit({ at: new Date().toISOString(), actor: ctx.identity.user, action: 'write.refused', detail: `${ctx.method} /${ctx.parts.join('/')}: needs the maintainer role, has ${ctx.identity.role}` }).catch(() => undefined);
      json(ctx, 403, { error: 'changing anything needs the maintainer role' });
      return true;
    }
    return refuseScope(ctx, project);
  };

  const projectExists = async (name: string): Promise<boolean> => PROJECT_NAME.test(name) && ((await backend.projects.list()).includes(name) || (await backend.snapshots.latest(name)) !== undefined);

  /** Every blob any pending run of the project asks for, and the size it declares. */
  const requested = async (project: string): Promise<Map<string, number>> => {
    const out = new Map<string, number>();
    const store = backend.evidence(project);
    for (const r of await store.listRuns()) {
      if (r.status !== 'pending') continue;
      const run = await store.getRun(r.runId);
      if (run) for (const f of Object.values(run.manifest.files)) out.set(f.sha256, f.size);
    }
    return out;
  };

  const missingOf = async (project: string, manifest: RunManifest): Promise<string[]> => {
    const store = backend.evidence(project);
    const missing: string[] = [];
    for (const sha of manifestBlobs(manifest)) if (!(await store.blobState(sha))?.complete) missing.push(sha);
    return missing;
  };

  const totalBytes = async (): Promise<number> => {
    const names = new Set([...(await backend.projects.list()), ...(await backend.snapshots.projects()).map((r) => r.project)]);
    let sum = 0;
    for (const n of names) sum += await backend.evidence(n).bytesUsed();
    return sum;
  };

  /** Mark a run complete, prune what retention says, and record both. */
  const finish = async (ctx: EvidenceRouteContext, project: string, manifest: RunManifest): Promise<{ record: RunListing; pruned: { runs: string[]; blobs: number } }> => {
    const store = backend.evidence(project);
    const record = await store.putRun(manifest, 'complete');
    const pruned = await store.gc(settings.keepRuns);
    audit(ctx.identity.user, 'run.publish', project, `${record.runId}: ${record.files} file(s), ${record.bytes} bytes`);
    if (pruned.runs.length > 0 || pruned.blobs > 0) audit(ctx.identity.user, 'run.prune', project, `${pruned.runs.length} run(s) [${pruned.runs.join(', ')}], ${pruned.blobs} blob(s)`);
    return { record, pruned };
  };

  // ---- JSON routes ----

  const publishState = async (ctx: EvidenceRouteContext, project: string): Promise<void> => {
    if (refuseScope(ctx, project)) return;
    if (!PROJECT_NAME.test(project)) return json(ctx, 404, { error: `no project "${project}"` });
    const latest = await backend.snapshots.latest(project);
    if (!latest && !(await projectExists(project))) return json(ctx, 404, { error: `no project "${project}"` });
    const { record } = latest ?? {};
    const state: PublishState = {
      project,
      caller: { user: ctx.identity.user, role: ctx.identity.role, ...(ctx.identity.project ? { project: ctx.identity.project } : {}) },
      snapshot: record ? { id: record.id, createdAt: record.createdAt, ...(record.commit ? { commit: record.commit } : {}), ...(record.branch ? { branch: record.branch } : {}), digest: record.digest ?? null } : null,
      runs: await backend.evidence(project).listRuns(),
      limits: limits(),
      features,
    };
    json(ctx, 200, state);
  };

  const postRun = async (ctx: EvidenceRouteContext, project: string): Promise<void> => {
    if (refuseWrite(ctx, project)) return;
    if (!(await projectExists(project))) return json(ctx, 404, { error: `no project "${project}"` });
    let raw: unknown;
    try {
      raw = JSON.parse(ctx.body ?? '');
    } catch {
      return json(ctx, 400, { error: 'the body must be a run manifest (JSON)' });
    }
    const parsed = RunManifestSchema.safeParse(raw);
    if (!parsed.success) return json(ctx, 400, { error: `invalid run manifest: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ')}` });
    if (parsed.data.project !== project) return json(ctx, 400, { error: `the manifest is for project "${parsed.data.project}", not "${project}"` });
    // Credentials are masked again here, whatever the client did. Hashes and the digest are not text to mask.
    const { files, digest, ...rest } = parsed.data;
    const manifest: RunManifest = { ...deepRedact(rest, (s) => redactor.text(s)), files, digest };

    const sizes = new Map<string, number>();
    for (const f of Object.values(manifest.files)) {
      if (sizes.has(f.sha256) && sizes.get(f.sha256) !== f.size) return json(ctx, 400, { code: 'inconsistent-manifest', error: `two files claim the hash ${f.sha256} with different sizes` });
      sizes.set(f.sha256, f.size);
    }
    const tooBig = Object.entries(manifest.files).filter(([, f]) => f.size > settings.maxFileBytes).map(([p, f]) => ({ path: p, size: f.size }));
    if (tooBig.length > 0) return json(ctx, 413, { code: 'file-too-large', error: `${tooBig.length} file(s) exceed the ${settings.maxFileBytes} byte limit`, files: tooBig, limit: settings.maxFileBytes });
    const runBytes = [...sizes.values()].reduce((a, b) => a + b, 0);
    if (runBytes > settings.maxRunBytes) return json(ctx, 413, { code: 'run-too-large', error: `the run's evidence is ${runBytes} bytes, over the ${settings.maxRunBytes} byte limit`, bytes: runBytes, limit: settings.maxRunBytes });

    const missing = await missingOf(project, manifest);
    const missingBytes = missing.reduce((a, sha) => a + (sizes.get(sha) ?? 0), 0);
    if (missingBytes > 0 && (await totalBytes()) + missingBytes > settings.maxTotalBytes) return json(ctx, 507, { code: 'storage-full', error: 'the server has no room for this evidence' });

    const store = backend.evidence(project);
    if (missing.length === 0) {
      const { record } = await finish(ctx, project, manifest);
      return json(ctx, 200, { runId: record.runId, status: 'complete', missing: [], chunkBytes: settings.chunkBytes } satisfies RunOffer);
    }
    const record = await store.putRun(manifest, 'pending');
    json(ctx, 200, { runId: record.runId, status: 'pending', missing, chunkBytes: settings.chunkBytes } satisfies RunOffer);
  };

  const commitRun = async (ctx: EvidenceRouteContext, project: string, runId: string): Promise<void> => {
    if (refuseWrite(ctx, project)) return;
    const run = await backend.evidence(project).getRun(runId);
    if (!run) return json(ctx, 404, { error: `no run "${runId}"` });
    const missing = await missingOf(project, run.manifest);
    if (missing.length > 0) return json(ctx, 409, { code: 'incomplete', error: `${missing.length} blob(s) have not been uploaded`, missing });
    const { record, pruned } = await finish(ctx, project, run.manifest);
    json(ctx, 200, { runId: record.runId, status: 'complete', files: record.files, bytes: record.bytes, pruned });
  };

  const deleteRun = async (ctx: EvidenceRouteContext, project: string, runId: string): Promise<void> => {
    if (refuseWrite(ctx, project)) return;
    const store = backend.evidence(project);
    if (!(await store.deleteRun(runId))) return json(ctx, 404, { error: `no run "${runId}"` });
    const pruned = await store.gc(settings.keepRuns);
    audit(ctx.identity.user, 'run.delete', project, `${runId}; ${pruned.blobs} blob(s) freed`);
    json(ctx, 200, { deleted: runId, pruned });
  };

  // ---- blobs ----

  const readChunk = (req: http.IncomingMessage, limit: number): Promise<{ ok: true; buffer: Buffer } | { ok: false }> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let refused = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (refused) {
          if (size > DRAIN_LIMIT) req.destroy();
          return;
        }
        if (size > limit) {
          refused = true;
          chunks.length = 0;
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(refused ? { ok: false } : { ok: true, buffer: Buffer.concat(chunks) }));
      req.on('error', () => resolve({ ok: false }));
      req.on('close', () => resolve(refused ? { ok: false } : { ok: true, buffer: Buffer.concat(chunks) }));
    });

  const intHeader = (v: string | undefined): number | undefined => (v !== undefined && /^\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : undefined);

  const headBlob = async (ctx: EvidenceRouteContext, project: string, sha: string): Promise<void> => {
    if (refuseScope(ctx, project)) return;
    if (!SHA256.test(sha)) return json(ctx, 400, { error: 'the blob name is a 64 character hex sha256' });
    const state = await backend.evidence(project).blobState(sha);
    if (!state) return reply(ctx, 404, 'application/json; charset=utf-8', '');
    // Complete: 200. Partial: 204 and where to resume. Either way the length and offset are in the headers.
    const headers = { 'Upload-Offset': String(state.received), 'Upload-Length': String(state.size) };
    if (state.complete) ctx.res.writeHead(200, { ...headers, 'Content-Length': '0', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    else ctx.res.writeHead(204, { ...headers, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    ctx.res.end();
  };

  const putBlob = async (ctx: EvidenceRouteContext, project: string, sha: string): Promise<void> => {
    // The chunk is read first, whatever happens next, so a refusal reaches a client that is still sending.
    const read = await readChunk(ctx.req, settings.chunkBytes);
    if (!read.ok) return json(ctx, 413, { code: 'chunk-too-large', error: `a chunk is at most ${settings.chunkBytes} bytes`, limit: settings.chunkBytes }, { Connection: 'close' });
    if (refuseWrite(ctx, project)) return;
    if (!SHA256.test(sha)) return json(ctx, 400, { error: 'the blob name is a 64 character hex sha256' });
    const offset = intHeader(ctx.req.headers['upload-offset'] as string | undefined);
    const total = intHeader(ctx.req.headers['upload-length'] as string | undefined);
    if (offset === undefined || total === undefined) return json(ctx, 400, { error: 'send the Upload-Offset and Upload-Length headers (whole numbers)' });
    if (total > settings.maxFileBytes) return json(ctx, 413, { code: 'file-too-large', error: `a file is at most ${settings.maxFileBytes} bytes`, files: [], limit: settings.maxFileBytes });
    const wanted = await requested(project);
    if (!wanted.has(sha)) return json(ctx, 409, { code: 'not-requested', error: 'no pending run of this project asks for that blob' });
    if (wanted.get(sha) !== total) return json(ctx, 400, { code: 'length-mismatch', error: `the manifest declares ${wanted.get(sha)} bytes for this blob, not ${total}` });

    const store = backend.evidence(project);
    if ((await store.blobState(sha))?.complete) return json(ctx, 201, { sha256: sha, size: total });
    let received: number;
    try {
      received = await store.appendChunk(sha, offset, total, read.buffer);
    } catch (err) {
      if (err instanceof EvidenceError && err.code === 'offset-mismatch') return json(ctx, 409, { code: 'offset-mismatch', error: err.message, expectedOffset: err.expectedOffset });
      if (err instanceof EvidenceError && err.code === 'overflow') return json(ctx, 400, { code: 'overflow', error: err.message });
      throw err;
    }
    if (received < total) {
      ctx.res.writeHead(204, { 'Upload-Offset': String(received), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return void ctx.res.end();
    }
    const done = await store.finalizeBlob(sha);
    if (!done.ok) return json(ctx, 422, { code: 'hash-mismatch', error: 'the bytes received do not hash to the name they were sent under; the upload was discarded' });
    json(ctx, 201, { sha256: sha, size: done.size });
  };

  // ---- serving ----

  const serveBlob = async (ctx: EvidenceRouteContext, project: string, manifest: RunManifest, evidencePath: string): Promise<void> => {
    // Only a path the manifest lists is served; it is a key, never a filesystem path.
    const entry = new Map(Object.entries(manifest.files)).get(evidencePath);
    if (!entry) return json(ctx, 404, { error: 'no such evidence in this run' });
    const store = backend.evidence(project);
    const state = await store.blobState(entry.sha256);
    if (!state?.complete) return json(ctx, 404, { error: 'that evidence was not uploaded' });
    const size = state.size;
    const type = entry.contentType.split(';')[0].trim().toLowerCase();
    const inline = INLINE_TYPES.has(type);
    const base = (evidencePath.split('/').pop() ?? 'evidence').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'evidence';
    const etag = `"${entry.sha256}"`;
    const headers: Record<string, string> = {
      'Content-Type': inline ? type : 'application/octet-stream',
      'Content-Disposition': inline ? 'inline' : `attachment; filename="${base}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, max-age=300',
      ETag: etag,
      'Accept-Ranges': 'bytes',
    };
    const match = ctx.req.headers['if-none-match'];
    if (match && match.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      ctx.res.writeHead(304, headers);
      return void ctx.res.end();
    }
    const range = parseRange(ctx.req.headers.range, size);
    if (range === 'invalid') {
      ctx.res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' });
      return void ctx.res.end();
    }
    const status = range ? 206 : 200;
    const length = range ? range.end - range.start + 1 : size;
    ctx.res.writeHead(status, { ...headers, 'Content-Length': String(length), ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}) });
    if (ctx.method === 'HEAD') return void ctx.res.end();
    for await (const chunk of store.readBlob(entry.sha256, range)) {
      if (ctx.res.destroyed) return;
      if (!ctx.res.write(chunk)) await once(ctx.res, 'drain').catch(() => undefined);
    }
    ctx.res.end();
  };

  const resolveRun = async (ctx: EvidenceRouteContext, project: string, runId: string) => {
    if (refuseScope(ctx, project)) return undefined;
    if (!PROJECT_NAME.test(project)) return void json(ctx, 404, { error: `no project "${project}"` });
    const run = await backend.evidence(project).getRun(runId);
    if (!run || (runId !== 'latest' && run.record.status !== 'complete')) return void json(ctx, 404, { error: runId === 'latest' ? 'no test run has been published for this project' : `no run "${runId}"` });
    return run;
  };

  const runReport = async (ctx: EvidenceRouteContext, project: string, runId: string, rest: string[]): Promise<void> => {
    const run = await resolveRun(ctx, project, runId);
    if (!run) return;
    if (rest.length === 1 && rest[0] === 'index.html') return html(ctx, renderReportHtml(run.manifest.report as unknown as ReportData));
    if (rest.length === 1 && rest[0] === 'report.json') return json(ctx, 200, run.manifest.report);
    if (rest[0] === 'evidence' && rest.length > 1) return serveBlob(ctx, project, run.manifest, rest.slice(1).join('/'));
    json(ctx, 404, { error: `no route /${ctx.parts.join('/')}` });
  };

  // ---- workspaces ----

  const workspaceRuns = async (ctx: EvidenceRouteContext, name: string) => {
    if (!WORKSPACE_NAME.test(name)) return void json(ctx, 400, { error: 'workspace names are letters, digits, . _ and -, up to 64 characters' });
    const def = await backend.workspaces.get(name);
    const scoped = ctx.identity.project;
    if (!def || (scoped && !(def.projects.length > 0 && def.projects.every((p) => p.project === scoped)))) return void json(ctx, 404, { error: `no workspace "${name}"` });
    const members = [];
    for (const p of def.projects.filter((x) => x.ignore !== true)) {
      const key = p.key ?? p.project;
      const store = PROJECT_NAME.test(p.project) ? backend.evidence(p.project) : undefined;
      const latest = await store?.getRun('latest');
      members.push({ key, role: p.role ?? 'consumer', project: p.project, latest, store });
    }
    return { def, members };
  };

  const workspaceData = async (ctx: EvidenceRouteContext, name: string) => {
    const found = await workspaceRuns(ctx, name);
    if (!found) return undefined;
    const repos: WorkspaceRepoReport[] = [];
    for (const m of found.members) {
      if (!m.latest || !m.store) {
        repos.push({ key: m.key, role: m.role, error: 'no test run has been published', run: null, tests: null, claims: null, gaps: null, regression: null, evidence: { screenshots: 0, videos: 0, traces: 0, other: 0 }, history: [], topGaps: [] });
        continue;
      }
      const history = [];
      for (const r of (await m.store.listRuns()).filter((x) => x.status === 'complete').slice(0, 8).reverse()) {
        const run = await m.store.getRun(r.runId);
        if (run) history.push(run.manifest.index);
      }
      repos.push(repoEntryFromData(m.key, m.role, m.latest.manifest.report as unknown as ReportData, history as unknown as Parameters<typeof repoEntryFromData>[3], `repos/${encodeURIComponent(m.key)}/index.html`));
    }
    return { ...found, data: rollupWorkspace(name, repos) };
  };

  const workspaceRoute = async (ctx: EvidenceRouteContext): Promise<void> => {
    const [, name, ...rest] = ctx.parts;
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return json(ctx, 405, { error: 'reports are read with GET' });
    // `report/` is where the pages live (their links are relative to it); the JSON is also at the workspace itself.
    const inReport = rest[0] === 'report' ? rest.slice(1) : undefined;
    if ((rest.length === 1 && rest[0] === 'workspace-report.json') || (inReport?.length === 1 && inReport[0] === 'workspace-report.json')) {
      const w = await workspaceData(ctx, name);
      return w ? json(ctx, 200, w.data) : undefined;
    }
    if (!inReport) return json(ctx, 404, { error: `no route /${ctx.parts.join('/')}` });
    if (inReport.length === 1 && inReport[0] === 'index.html') {
      const w = await workspaceData(ctx, name);
      return w ? html(ctx, renderWorkspaceReportHtml(w.data)) : undefined;
    }
    if (inReport[0] === 'repos' && inReport.length >= 3) {
      const w = await workspaceData(ctx, name);
      if (!w) return;
      const member = w.members.find((m) => m.key === inReport[1]);
      if (!member?.latest) return json(ctx, 404, { error: `no published run for "${inReport[1]}"` });
      if (inReport.length === 3 && inReport[2] === 'index.html') return html(ctx, renderReportHtml(member.latest.manifest.report as unknown as ReportData, '../../index.html'));
      if (inReport[2] === 'evidence' && inReport.length > 3) return serveBlob(ctx, member.project, member.latest.manifest, inReport.slice(3).join('/'));
    }
    json(ctx, 404, { error: `no route /${ctx.parts.join('/')}` });
  };

  // ---- dispatch ----

  const classify = (method: string, parts: string[]): { stream: boolean } | undefined => {
    if (parts[0] === 'workspaces' && parts.length >= 3 && (parts[2] === 'report' || (parts.length === 3 && parts[2] === 'workspace-report.json'))) return { stream: false };
    if (parts[0] !== 'projects' || parts.length < 3) return undefined;
    if (parts[2] === 'publish-state' && parts.length === 3) return { stream: false };
    if (parts[2] === 'blobs' && parts.length === 4) return { stream: method === 'PUT' };
    if (parts[2] === 'runs') return { stream: false };
    return undefined;
  };

  return {
    features,
    limits,
    match: classify,
    isUpload: (method, parts) => parts[0] === 'projects' && parts[2] === 'blobs' && parts.length === 4 && (method === 'PUT' || method === 'HEAD'),
    async handle(ctx) {
      const { method, parts } = ctx;
      const reading = method === 'GET' || method === 'HEAD';
      if (parts[0] === 'workspaces') return workspaceRoute(ctx);
      const project = parts[1];
      if (parts[2] === 'publish-state') return reading ? publishState(ctx, project) : json(ctx, 405, { error: 'publish-state is read with GET' });
      if (parts[2] === 'blobs') {
        if (method === 'PUT') return putBlob(ctx, project, parts[3]);
        if (reading && method === 'HEAD') return headBlob(ctx, project, parts[3]);
        return json(ctx, 405, { error: 'blobs are checked with HEAD and uploaded with PUT' });
      }
      // /projects/:p/runs ...
      if (parts.length === 3) {
        if (reading) {
          if (refuseScope(ctx, project)) return;
          if (!(await projectExists(project))) return json(ctx, 404, { error: `no project "${project}"` });
          return json(ctx, 200, await backend.evidence(project).listRuns());
        }
        if (method === 'POST') return postRun(ctx, project);
        return json(ctx, 405, { error: `no route ${method} /${parts.join('/')}` });
      }
      const runId = parts[3];
      if (parts.length === 4) {
        if (reading) {
          const run = await resolveRun(ctx, project, runId);
          return run ? json(ctx, 200, { ...run.manifest, status: run.record.status, createdAt: run.record.createdAt }) : undefined;
        }
        if (method === 'DELETE') return deleteRun(ctx, project, runId);
        return json(ctx, 405, { error: `no route ${method} /${parts.join('/')}` });
      }
      if (parts.length === 5 && parts[4] === 'commit') return method === 'POST' ? commitRun(ctx, project, runId) : json(ctx, 405, { error: 'a run is committed with POST' });
      if (parts[4] === 'report') return reading ? runReport(ctx, project, runId, parts.slice(5)) : json(ctx, 405, { error: 'reports are read with GET' });
      json(ctx, 404, { error: `no route /${parts.join('/')}` });
    },
  };
}
