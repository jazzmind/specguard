/**
 * Test evidence for a team server: build the run manifest (`buildRunManifest`) and upload the files it names
 * (`uploadRun`), resumable, with retries.
 *
 * The manifest carries the run index and the report data (redacted, paths made repo-relative) plus one entry per
 * evidence file with its full sha256. The server answers with the hashes it lacks; only those bytes are sent, in chunks
 * of at most `chunkBytes` (a proxy in front of the server rejects large bodies). Each upload asks the server where a
 * partial blob stands (`HEAD`) so an interrupted publish continues instead of starting over.
 *
 * Spec: specs/capabilities/team-server.md
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';

import { ServerRequestError, type SpecGuardClient } from '../client/index.js';
import { EVIDENCE_DIR, listRunIndexes, type RunIndex } from '../core/evidence.js';
import { createSecretRedactor } from '../core/redact.js';
import {
  RUN_MANIFEST_SCHEMA,
  RunManifestSchema,
  RunOfferSchema,
  type EvidenceFile,
  type PublishProgress,
  type RunManifest,
  type RunRecord,
  type ServerLimits,
  type SnapshotDigest,
} from '../core/publish-contract.js';
import type { SpecGuardConfig } from '../core/types.js';
import { writeFile } from '../core/writer.js';
import { buildReport, chooseRuns, type ReportAttachment } from './report.js';

export const HASH_CACHE_FILE = '.specguard/publish/hash-cache.json';
export const UPLOAD_CONCURRENCY = 4;

export type EvidenceMode = 'all' | 'summary';

/** The run that would be published: the chosen one, or the reason there is none. */
export function chooseRun(root: string, runId?: string): { run?: RunIndex; runs: RunIndex[]; error?: string } {
  const runs = listRunIndexes(root);
  if (runId) {
    const chosen = chooseRuns(runs, { run: runId });
    return chosen.error ? { runs, error: chosen.error } : { runs, run: chosen.run };
  }
  const latest = runs[runs.length - 1];
  return latest ? { runs, run: latest } : { runs };
}

// ---------------------------------------------------------------------------
// Hashing, with a cache keyed by path, size and mtime
// ---------------------------------------------------------------------------

type HashCache = Record<string, string>;

function readHashCache(root: string): HashCache {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, HASH_CACHE_FILE), 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as HashCache) : {};
  } catch {
    return {};
  }
}

function sha256File(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(abs);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.html': 'text/html',
};

function contentTypeOf(att: ReportAttachment): string {
  return att.contentType || CONTENT_TYPES[path.extname(att.path).toLowerCase()] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Redaction and repo-relative paths
// ---------------------------------------------------------------------------

/** Deep copy of `value` with every string redacted; `file` values become repo-relative paths. */
function sanitize<T>(value: T, root: string): T {
  const redact = createSecretRedactor();
  const relative = (file: string): string => {
    if (!path.isAbsolute(file)) return file;
    const rel = path.relative(root, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.basename(file);
  };
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return redact.text(key === 'file' ? relative(v) : v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value) as T;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface BuildRunManifestOpts {
  project: string;
  digest: SnapshotDigest;
  /** Run to publish. Default: the newest. */
  run?: string;
  /** `summary`: manifest and report only, no evidence files. */
  mode?: EvidenceMode;
  /** The server's caps; files over `maxFileBytes` are reported as `oversized`. */
  limits?: Pick<ServerLimits, 'maxFileBytes'>;
  /** Leave oversized files out (recorded as `omitted`) instead of listing them for the caller to refuse. */
  skipOversized?: boolean;
  onProgress?: (p: PublishProgress) => void;
  key?: string;
}

export interface BuiltRun {
  manifest: RunManifest;
  /** Absolute path of one local file per sha256 in the manifest. */
  files: Map<string, string>;
  /** Files over the server's per-file cap that were not skipped; the caller refuses to publish them. */
  oversized: Array<{ path: string; size: number }>;
}

/** Build the manifest of one run. Throws when there is no run to publish or the data does not fit the contract. */
export async function buildRunManifest(config: SpecGuardConfig, opts: BuildRunManifestOpts): Promise<BuiltRun> {
  const root = config.rootDir ?? process.cwd();
  const picked = chooseRun(root, opts.run);
  if (picked.error) throw new Error(picked.error);
  if (!picked.run) throw new Error('no recorded runs to publish (see `specguard results ingest`)');
  const run = picked.run;
  const chosen = chooseRuns(picked.runs, { run: run.runId });
  const report = await buildReport(config, picked.runs, chosen);

  const attachments = new Map<string, ReportAttachment>();
  for (const cap of report.capabilities) for (const claim of cap.claims) for (const t of [...claim.tests, ...claim.partialTests]) for (const a of t.attachments) attachments.set(a.path, a);

  const files: Record<string, EvidenceFile> = {};
  const local = new Map<string, string>();
  const omitted: RunManifest['omitted'] = [];
  const oversized: BuiltRun['oversized'] = [];
  if ((opts.mode ?? 'all') === 'all') {
    const evidenceRoot = path.resolve(root, EVIDENCE_DIR);
    const cache = readHashCache(root);
    let cacheChanged = false;
    const entries = [...attachments.entries()].sort(([a], [b]) => a.localeCompare(b));
    let done = 0;
    for (const [rel, att] of entries) {
      const abs = path.resolve(evidenceRoot, rel);
      let size = -1;
      let mtime = 0;
      if (abs.startsWith(evidenceRoot + path.sep)) {
        try {
          const st = await stat(abs);
          if (st.isFile()) {
            size = st.size;
            mtime = st.mtimeMs;
          }
        } catch {
          /* missing */
        }
      }
      if (size < 0) {
        omitted.push({ path: rel, reason: 'missing' });
      } else if (opts.limits && size > opts.limits.maxFileBytes) {
        if (opts.skipOversized) omitted.push({ path: rel, reason: 'too-large' });
        else oversized.push({ path: rel, size });
      } else {
        const cacheKey = `${path.relative(root, abs)}|${size}|${mtime}`;
        let sha = cache[cacheKey];
        if (!sha) {
          sha = await sha256File(abs);
          cache[cacheKey] = sha;
          cacheChanged = true;
        }
        files[rel] = { sha256: sha, size, contentType: contentTypeOf(att), kind: att.kind };
        local.set(sha, abs);
      }
      done += 1;
      opts.onProgress?.({ sg: 'progress', ...(opts.key ? { key: opts.key } : {}), phase: 'hash', done, total: entries.length, bytes: 0 });
    }
    if (cacheChanged) await writeFile(path.join(root, HASH_CACHE_FILE), JSON.stringify(cache) + '\n').catch(() => undefined);
  }

  const manifest = {
    schema: RUN_MANIFEST_SCHEMA,
    project: opts.project,
    runId: run.runId,
    ...(run.label ? { label: run.label } : {}),
    ingestedAt: run.ingestedAt,
    digest: opts.digest,
    index: sanitize(run, root),
    report: sanitize(report, root),
    files,
    omitted,
  };
  const parsed = RunManifestSchema.safeParse(manifest);
  if (!parsed.success) throw new Error(`the run manifest does not fit the contract: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return { manifest: parsed.data, files: local, oversized };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/** A failure with a message fit to print. `code` is the server's error code when it gave one. */
export class EvidenceUploadError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'EvidenceUploadError';
  }
}

export interface UploadRunOpts {
  /** Refuse (before sending any byte) when the bytes the server lacks exceed this many megabytes. */
  maxEvidenceMb?: number;
  concurrency?: number;
  /** Tries per chunk after the first failure. Default 4. */
  retries?: number;
  /** Test hook; default waits `backoffMs * 2^attempt`. */
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: number;
  onProgress?: (p: PublishProgress) => void;
  key?: string;
}

export interface UploadResult {
  record: RunRecord;
  /** Blobs sent in this call (the rest were already on the server). */
  uploaded: number;
  uploadedBytes: number;
  skipped: number;
  pruned?: { runs: string[]; blobs: number };
}

const transient = (err: unknown): boolean => {
  if (err instanceof ServerRequestError) return err.status === 408 || err.status === 429 || err.status >= 500;
  return true; // network errors, timeouts
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Send a run to the server: offer the manifest, upload only the blobs it lacks, then commit.
 * Resumes partial blobs (`HEAD` gives the offset) and retries transient failures with backoff.
 */
export async function uploadRun(client: SpecGuardClient, built: Pick<BuiltRun, 'manifest' | 'files'>, opts: UploadRunOpts = {}): Promise<UploadResult> {
  const { manifest, files } = built;
  const sleep = opts.sleep ?? defaultSleep;
  const retries = opts.retries ?? 4;
  const backoff = opts.backoffMs ?? 500;
  const emit = (phase: PublishProgress['phase'], done: number, total: number, bytes: number): void =>
    opts.onProgress?.({ sg: 'progress', ...(opts.key ? { key: opts.key } : {}), phase, done, total, bytes });

  // Offer.
  let offer;
  try {
    offer = RunOfferSchema.parse(await client.request('POST', client.projectPath('/runs'), { body: manifest, gzip: true, timeoutMs: 120_000 }));
  } catch (err) {
    if (err instanceof ServerRequestError) {
      const b = err.body ?? {};
      if (err.status === 413 && err.code === 'file-too-large') {
        const list = Array.isArray(b.files) ? (b.files as Array<{ path: string; size: number }>).map((f) => `${f.path} (${f.size} bytes)`).join(', ') : '';
        throw new EvidenceUploadError(`the server refuses files over ${String(b.limit)} bytes: ${list}`, err.code);
      }
      if (err.status === 413 && err.code === 'run-too-large') throw new EvidenceUploadError(`the run's evidence is ${String(b.bytes)} bytes; the server accepts ${String(b.limit)} per run`, err.code);
      if (err.status === 507) throw new EvidenceUploadError('the server is out of storage for test evidence', err.code ?? 'storage-full');
      throw new EvidenceUploadError(`the server refused the run (${err.status}): ${err.message}`, err.code);
    }
    throw new EvidenceUploadError(`could not offer the run: ${(err as Error).message}`);
  }

  const sizeOf = new Map<string, number>();
  for (const f of Object.values(manifest.files)) sizeOf.set(f.sha256, f.size);
  const missing = offer.missing.filter((sha) => files.has(sha));
  const unknown = offer.missing.filter((sha) => !files.has(sha));
  if (unknown.length > 0) throw new EvidenceUploadError(`the server asked for ${unknown.length} file(s) this machine does not have`);
  const missingBytes = missing.reduce((n, sha) => n + (sizeOf.get(sha) ?? 0), 0);
  if (opts.maxEvidenceMb !== undefined && missingBytes > opts.maxEvidenceMb * 1024 * 1024) {
    throw new EvidenceUploadError(`${(missingBytes / 1024 / 1024).toFixed(1)} MB of evidence is still to upload, over --max-evidence-mb ${opts.maxEvidenceMb}; nothing was uploaded`, 'over-budget');
  }

  // Upload.
  let doneBlobs = 0;
  let sentBytes = 0;
  const chunkBytes = offer.chunkBytes;
  emit('upload', 0, missing.length, 0);

  const uploadBlob = async (sha: string): Promise<void> => {
    const abs = files.get(sha)!;
    const total = sizeOf.get(sha) ?? (await stat(abs)).size;
    const url = client.projectPath(`/blobs/${sha}`);
    const resync = async (): Promise<number | 'complete'> => {
      const head = await client.head(url);
      if (head.status === 200) return 'complete';
      if (head.status === 204) return Number(head.headers.get('upload-offset') ?? 0) || 0;
      return 0;
    };
    const handle = await open(abs, 'r');
    try {
      let offset = 0;
      let attempt = 0;
      let needResync = true;
      for (;;) {
        try {
          if (needResync) {
            const at = await resync();
            if (at === 'complete') return;
            offset = at;
            needResync = false;
          }
          const length = Math.min(chunkBytes, total - offset);
          const buf = Buffer.alloc(length);
          if (length > 0) await handle.read(buf, 0, length, offset);
          const res = await client.putBinary(url, buf, { headers: { 'Upload-Offset': String(offset), 'Upload-Length': String(total) } });
          sentBytes += length;
          attempt = 0;
          emit('upload', doneBlobs, missing.length, sentBytes);
          if (res.status === 201) return;
          const next = Number(res.headers.get('upload-offset'));
          offset = Number.isFinite(next) && next > offset ? next : offset + length;
          if (offset >= total && length === 0) throw new EvidenceUploadError(`the server did not complete ${sha}`);
        } catch (err) {
          if (err instanceof EvidenceUploadError) throw err;
          if (err instanceof ServerRequestError && err.status === 409 && err.code === 'offset-mismatch') {
            const expected = Number(err.body?.expectedOffset);
            if (Number.isFinite(expected)) {
              offset = expected;
              if (++attempt > retries) throw new EvidenceUploadError(`the server and this machine disagree on where ${sha} stands`, err.code);
              continue;
            }
            needResync = true;
            if (++attempt > retries) throw new EvidenceUploadError(`the server and this machine disagree on where ${sha} stands`, err.code);
            continue;
          }
          if (err instanceof ServerRequestError && err.status === 409 && err.code === 'not-requested') throw new EvidenceUploadError(`the server did not ask for ${sha}`, err.code);
          if (err instanceof ServerRequestError && err.status === 422) throw new EvidenceUploadError(`the server computed a different hash for ${sha}; the file changed while uploading`, err.code ?? 'hash-mismatch');
          if (!transient(err)) throw new EvidenceUploadError(`upload of ${sha} refused (${(err as ServerRequestError).status}): ${(err as Error).message}`, (err as ServerRequestError).code);
          if (++attempt > retries) throw new EvidenceUploadError(`upload of ${sha} failed after ${retries + 1} tries: ${(err as Error).message}`);
          await sleep(backoff * 2 ** (attempt - 1));
          needResync = true;
        }
      }
    } finally {
      await handle.close();
    }
  };

  const queue = [...missing];
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? UPLOAD_CONCURRENCY, queue.length)) }, async () => {
    for (let sha = queue.shift(); sha; sha = queue.shift()) {
      await uploadBlob(sha);
      doneBlobs += 1;
      emit('upload', doneBlobs, missing.length, sentBytes);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failure) throw failure.reason;

  // Commit.
  emit('commit', 0, 1, sentBytes);
  let record: RunRecord;
  let pruned: UploadResult['pruned'];
  if (offer.status === 'complete' && missing.length === 0) {
    record = { runId: offer.runId, ...(manifest.label ? { label: manifest.label } : {}), ingestedAt: manifest.ingestedAt, status: 'complete', files: Object.keys(manifest.files).length, bytes: [...sizeOf.values()].reduce((a, b) => a + b, 0), createdAt: new Date().toISOString() };
  } else {
    try {
      const done = await client.request<{ runId: string; status: 'complete'; files: number; bytes: number; pruned?: { runs: string[]; blobs: number } }>('POST', client.projectPath(`/runs/${encodeURIComponent(offer.runId)}/commit`), { body: {} });
      pruned = done.pruned;
      record = { runId: done.runId, ...(manifest.label ? { label: manifest.label } : {}), ingestedAt: manifest.ingestedAt, status: 'complete', files: done.files, bytes: done.bytes, createdAt: new Date().toISOString() };
    } catch (err) {
      if (err instanceof ServerRequestError && err.code === 'incomplete') throw new EvidenceUploadError(`the server still lacks ${Array.isArray(err.body?.missing) ? (err.body!.missing as unknown[]).length : 'some'} file(s); run the publish again to resume`, 'incomplete');
      throw new EvidenceUploadError(`could not commit the run: ${(err as Error).message}`);
    }
  }
  emit('commit', 1, 1, sentBytes);
  return { record, uploaded: missing.length, uploadedBytes: sentBytes, skipped: Object.keys(manifest.files).length - missing.length, ...(pruned ? { pruned } : {}) };
}

// Used by the check to size the newest local run without hashing anything.
export async function describeLocalRun(config: SpecGuardConfig, runId?: string): Promise<{ runId: string; files: number; bytes: number } | undefined> {
  const root = config.rootDir ?? process.cwd();
  const picked = chooseRun(root, runId);
  if (!picked.run) return undefined;
  const paths = new Set<string>();
  for (const t of picked.run.tests) for (const a of t.attachments) paths.add(a.path);
  let files = 0;
  let bytes = 0;
  const evidenceRoot = path.resolve(root, EVIDENCE_DIR);
  for (const rel of paths) {
    const abs = path.resolve(evidenceRoot, rel);
    if (!abs.startsWith(evidenceRoot + path.sep)) continue;
    try {
      const st = await stat(abs);
      if (st.isFile()) {
        files += 1;
        bytes += st.size;
      }
    } catch {
      /* missing */
    }
  }
  return { runId: picked.run.runId, files, bytes };
}
