/**
 * `specguard publish`: build a snapshot of this project at this commit, for a team server.
 *
 * It reads the spec and history files, the trace model, the proof rows and the newest remediation plan, redacts
 * credentials from every file, and writes one JSON file. Working-tree source code and uncaptured prompts are
 * never included.
 *
 * Spec: specs/capabilities/team-server.md
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SpecGuardClient, ServerRequestError, serverTarget } from '../client/index.js';
import { HASH_VERSION } from '../core/claim-hash.js';
import { loadContractGraph } from '../core/contracts.js';
import { ExitCode, RemediateExit } from '../core/exit-codes.js';
import { detectProvenance } from '../core/provenance.js';
import { createSecretRedactor } from '../core/redact.js';
import {
  PUBLISH_CHECK_SCHEMA,
  SERVER_FEATURES,
  PublishStateSchema,
  type PublishCheck,
  type PublishProgress,
  type PublishReason,
  type PublishState,
  type RunRecord,
  type SnapshotDigest,
} from '../core/publish-contract.js';
import { SNAPSHOT_VERSION, MAX_SNAPSHOT_BYTES, parseSnapshot, snapshotDigest, type Snapshot } from '../core/snapshot.js';
import { specsRootDir } from '../core/spec-key.js';
import { fileLedgerStore } from '../core/state/ledger-store.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { cliVersion } from '../core/version.js';
import { writeFile } from '../core/writer.js';
import { loadTrace } from './check.js';
import { buildRunManifest, chooseRun, describeLocalRun, EvidenceUploadError, uploadRun, type EvidenceMode } from './publish-evidence.js';
import { ledgerPath } from './proof.js';
import { loadEffectiveLedger, proofSourceKind, readOnlyStore } from './proof-sources.js';
import { readPlan } from './security-plan.js';

/** Exit code of `publish --check` when a publish is needed (the shared "changed" code, 9). */
export const NEEDS_PUBLISH_EXIT: number = RemediateExit.Changed;

export const DEFAULT_SNAPSHOT_FILE = '.specguard/publish/snapshot.json';

export interface PublishOpts {
  /** Where to write the snapshot. Default `.specguard/publish/snapshot.json`. */
  out?: string;
  /** Project name on the server. Default: `server.project` from config, else the repository name, else the directory name. */
  project?: string;
  /** Also send the snapshot to the project's team server. A refusal or an unreachable server fails the command. */
  push?: boolean;
  /** Server to push to, overriding config and `SPECGUARD_SERVER`. */
  server?: string;
  /** Token for the push, overriding `SPECGUARD_TOKEN` and a saved login. */
  token?: string;
  /** Only compare with the server (nothing is written or sent). The answer is `result.publish`; exit code 9 when a publish is needed. */
  check?: boolean;
  /** Also publish the newest (or `run`) test run: `all` with its evidence files, `summary` with the report only. Needs `push`. */
  evidence?: EvidenceMode;
  /** Run id to publish as evidence. Default: the newest. */
  run?: string;
  /** Refuse to upload more than this many megabytes of evidence (checked before the first byte is sent). */
  maxEvidenceMb?: number;
  /** Leave files over the server's per-file cap out instead of failing. */
  skipOversized?: boolean;
  /** Print `PublishProgress` lines as NDJSON on stderr. */
  progressJson?: boolean;
  /** Repo key, copied into progress lines and checks (workspace members). */
  key?: string;
  /** Called with every progress event (tests, the workspace publisher). */
  onProgress?: (p: PublishProgress) => void;
  /** Network seam for tests. */
  fetchImpl?: typeof fetch;
  /** Environment seam for tests (token and server lookup). Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test hook for the retry backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const posix = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

/** Markdown under `dir`, skipping the v1 archive and anything hidden. */
function markdownUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '_archive' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

export async function buildSnapshot(config: SpecGuardConfig, opts: PublishOpts = {}): Promise<Snapshot> {
  const root = config.rootDir ?? process.cwd();
  const redact = createSecretRedactor();
  const provenance = detectProvenance(root);
  // Outside CI the provenance has a branch but no commit; the check and the extension show it, so ask git.
  if (!provenance.commit) {
    try {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
      if (/^[0-9a-f]{7,64}$/.test(head)) provenance.commit = head;
    } catch {
      /* not a git checkout */
    }
  }
  const specsDir = specsRootDir(config);

  const files: Record<string, string> = {};
  for (const file of markdownUnder(specsDir)) files[posix(root, file)] = redact.text(fs.readFileSync(file, 'utf8'));

  // With a CI proof note the snapshot carries the effective ledger (note rows plus local ones); without one, the local file as before.
  const effective = await loadEffectiveLedger(config).catch(() => undefined);
  const store = effective?.note ? readOnlyStore(effective) : undefined;
  const { model } = await loadTrace(config, store ? { store } : {});
  const ledger = effective?.note ? effective.ledger : await fileLedgerStore(ledgerPath(root, config.paths?.proofLedger)).read();
  const plan = readPlan(config, 'latest');
  const contracts = await loadContractGraph(root).catch(() => null);

  const project = opts.project ?? config.server?.project ?? provenance.repo?.split('/')[1] ?? path.basename(root);
  return {
    version: SNAPSHOT_VERSION,
    project,
    ...(provenance.repo ? { repo: provenance.repo } : {}),
    ...(provenance.branch ? { branch: provenance.branch } : {}),
    ...(provenance.commit ? { commit: provenance.commit } : {}),
    createdAt: new Date().toISOString(),
    engineVersion: cliVersion(),
    hashVersion: HASH_VERSION,
    origin: provenance.origin,
    specsRoot: posix(root, specsDir) || 'specs',
    files,
    trace: model as unknown as Snapshot['trace'],
    ledger: ledger.proofs as unknown as Snapshot['ledger'],
    ...(effective?.note ? { proofSource: { kind: proofSourceKind(effective), noteCommit: effective.note.commit, verified: effective.note.verified } } : { proofSource: { kind: 'local' as const } }),
    plans: plan ? [plan as Snapshot['plans'][number]] : [],
    ...(contracts ? { contracts: contracts as unknown as Snapshot['contracts'] } : {}),
  };
}

/** The digest a server computes: of the snapshot as it arrives (JSON drops `undefined` fields, which would otherwise change the hash). */
export function digestOf(snapshot: Snapshot): SnapshotDigest {
  return snapshotDigest(JSON.parse(JSON.stringify(snapshot)) as Snapshot);
}

/** One place that decides where progress goes: the caller's hook, and stderr as NDJSON with `--progress-json`. */
export function progressSink(opts: Pick<PublishOpts, 'progressJson' | 'onProgress'>): (p: PublishProgress) => void {
  return (p) => {
    opts.onProgress?.(p);
    if (opts.progressJson) process.stderr.write(`${JSON.stringify(p)}\n`);
  };
}

export async function runPublish(config: SpecGuardConfig, opts: PublishOpts = {}): Promise<PipelineResult> {
  if (opts.check) return runPublishCheck(config, opts);
  const result = emptyResult('publish');
  const root = config.rootDir ?? process.cwd();
  if (opts.evidence && !(opts.push || opts.server)) {
    result.failed = 1;
    result.exitCode = ExitCode.ValidationFailed;
    result.messages.push('--evidence needs --push (or --server): evidence is uploaded to a team server');
    return result;
  }
  if (opts.evidence) {
    const picked = chooseRun(root, opts.run);
    if (picked.error || !picked.run) {
      result.failed = 1;
      result.exitCode = ExitCode.ValidationFailed;
      result.messages.push(picked.error ?? 'no recorded runs to publish as evidence (see `specguard results ingest`)');
      return result;
    }
  }
  const snapshot = await buildSnapshot(config, opts);
  const text = `${JSON.stringify(snapshot)}\n`;

  // What is written must be what a server will accept.
  const check = parseSnapshot(text);
  if (!check.ok) {
    result.failed = 1;
    result.exitCode = ExitCode.ValidationFailed;
    result.messages.push(`the snapshot would be rejected by a server: ${check.error}`);
    return result;
  }
  if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) {
    result.failed = 1;
    result.exitCode = ExitCode.ValidationFailed;
    result.messages.push(`snapshot is ${Buffer.byteLength(text)} bytes; servers accept up to ${MAX_SNAPSHOT_BYTES}`);
    return result;
  }

  const out = path.resolve(root, opts.out ?? DEFAULT_SNAPSHOT_FILE);
  await writeFile(out, text);
  if (opts.push || opts.server) {
    const target = serverTarget(config, { ...(opts.env ?? process.env), ...(opts.server ? { SPECGUARD_SERVER: opts.server } : {}), ...(opts.token ? { SPECGUARD_TOKEN: opts.token } : {}), SPECGUARD_PROJECT: snapshot.project });
    if (!target) {
      result.failed = 1;
      result.exitCode = ExitCode.ValidationFailed;
      result.messages.push('--push needs a server: set "server.url" in .specguard/config.json, SPECGUARD_SERVER, or --server');
      return result;
    }
    try {
      const client = new SpecGuardClient(target, opts.fetchImpl);
      const sent = await client.request<{ snapshotId: string }>('POST', client.projectPath('/snapshots'), { body: JSON.parse(text), timeoutMs: 60_000 });
      result.messages.push(`pushed to ${target.url} as project ${target.project} (snapshot ${sent.snapshotId})`);
    } catch (err) {
      result.failed = 1;
      result.exitCode = ExitCode.InternalError;
      result.messages.push(err instanceof ServerRequestError ? `the server refused the snapshot (${err.status}): ${err.message}` : `could not push to ${target.url}: ${(err as Error).message}`);
      return result;
    }
    if (opts.evidence) {
      const failed = await publishEvidence(new SpecGuardClient(target, opts.fetchImpl), config, snapshot, opts, result);
      if (failed) return result;
    }
  }
  result.created = 1;
  result.messages.push(
    `snapshot of ${snapshot.project}${snapshot.commit ? ` @ ${snapshot.commit.slice(0, 8)}` : ''}${snapshot.branch ? ` (${snapshot.branch})` : ''}: ` +
      `${Object.keys(snapshot.files).length} spec/history file(s), ${snapshot.trace.nodes.length} spec(s), ${Object.keys(snapshot.ledger).length} proof row(s), ${snapshot.plans.length} plan(s)`,
  );
  result.messages.push(`written to ${path.relative(root, out) || out} (${Buffer.byteLength(text)} bytes, origin ${snapshot.origin})`);
  return result;
}

/** Upload the chosen run after the snapshot is on the server. Returns true (with `result` marked failed) when it did not work. */
async function publishEvidence(client: SpecGuardClient, config: SpecGuardConfig, snapshot: Snapshot, opts: PublishOpts, result: PipelineResult): Promise<boolean> {
  const fail = (message: string, exitCode: number = ExitCode.InternalError): true => {
    result.failed = 1;
    result.exitCode = exitCode;
    result.messages.push(message);
    return true;
  };
  const state = await fetchPublishState(client);
  if (!state || !state.features.includes(SERVER_FEATURES.evidence)) return fail('server does not accept test evidence; upgrade it', ExitCode.ValidationFailed);
  const mode: EvidenceMode = opts.evidence ?? 'all';
  const emit = progressSink(opts);
  try {
    const built = await buildRunManifest(config, {
      project: snapshot.project,
      digest: digestOf(snapshot),
      ...(opts.run ? { run: opts.run } : {}),
      mode,
      limits: state.limits,
      ...(opts.skipOversized ? { skipOversized: true } : {}),
      onProgress: emit,
      ...(opts.key ? { key: opts.key } : {}),
    });
    if (built.oversized.length > 0) {
      return fail(`files over the server's ${Math.round(state.limits.maxFileBytes / 1024 / 1024)} MB per-file cap (use --skip-oversized to leave them out): ${built.oversized.map((f) => `${f.path} (${f.size} bytes)`).join(', ')}`, ExitCode.ValidationFailed);
    }
    const sent = await uploadRun(client, built, {
      ...(opts.maxEvidenceMb !== undefined ? { maxEvidenceMb: opts.maxEvidenceMb } : {}),
      onProgress: emit,
      ...(opts.key ? { key: opts.key } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    result.publish = { runs: [sent.record] };
    const omitted = built.manifest.omitted.length > 0 ? `, ${built.manifest.omitted.length} file(s) omitted (${built.manifest.omitted.map((o) => o.reason).join('/')})` : '';
    result.messages.push(`published run ${sent.record.runId}: ${Object.keys(built.manifest.files).length} evidence file(s), ${sent.uploaded} uploaded (${sent.uploadedBytes} bytes), ${sent.skipped} already on the server${omitted}`);
    return false;
  } catch (err) {
    return fail(err instanceof EvidenceUploadError ? err.message : `could not publish test evidence: ${(err as Error).message}`, err instanceof EvidenceUploadError && err.code === 'over-budget' ? ExitCode.ValidationFailed : ExitCode.InternalError);
  }
}

// ---------------------------------------------------------------------------
// publish --check
// ---------------------------------------------------------------------------

/** `GET publish-state`; null for a server that has no such route (404). Other failures throw. */
export async function fetchPublishState(client: SpecGuardClient): Promise<PublishState | null> {
  try {
    return PublishStateSchema.parse(await client.request('GET', client.projectPath('/publish-state'), { timeoutMs: 15_000 }));
  } catch (err) {
    if (err instanceof ServerRequestError && err.status === 404) return null;
    throw err;
  }
}

export interface ServerProbe {
  reachable: boolean;
  features: string[];
  error?: string;
}

/** Ask `/health` whether a server answers and which features it lists. */
export async function probeServer(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8000, token?: string): Promise<ServerProbe> {
  try {
    const res = await fetchImpl(`${url}/api/v1/health`, { headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reachable: false, features: [], error: `the server answered ${res.status} to its health check` };
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('json')) {
      const gate = /\/auth\/|login|signin/i.test(res.url ?? '');
      return { reachable: false, features: [], error: gate
        ? (token
          ? `${url} answered with a sign-in page even though a token was sent: the host's single sign-on is not letting API requests through (the app needs DEPLOYKIT_TOKEN_AUTH_PATHS=/api/v1).`
          : `${url} is behind the host's single sign-on and no SpecGuard token was found. Run "SpecGuard: Sign In" (or set SPECGUARD_TOKEN) so API requests carry a token.`)
        : `${url} answered with a web page (${ctype || 'no content type'}), not the SpecGuard API. Check the server URL (it should be the base address of a SpecGuard server, e.g. http://host/specguard).` };
    }
    const health = (await res.json()) as { ok?: boolean; features?: unknown };
    if (!health.ok) return { reachable: false, features: [], error: 'that address does not look like a SpecGuard server' };
    return { reachable: true, features: Array.isArray(health.features) ? health.features.filter((f): f is string => typeof f === 'string') : [] };
  } catch (err) {
    return { reachable: false, features: [], error: `cannot reach ${url} (${(err as Error).message})` };
  }
}

const SECTION_REASON: Record<string, PublishReason> = {
  specs: 'specs-changed',
  trace: 'trace-changed',
  ledger: 'proofs-changed',
  plans: 'plans-changed',
  contracts: 'contracts-changed',
};

/** Compare two digests: which sections differ, and which spec files were added, removed or modified (from local to remote). */
export function compareDigests(local: SnapshotDigest, remote: SnapshotDigest): { reasons: PublishReason[]; specFiles: PublishCheck['specFiles'] } {
  const reasons: PublishReason[] = [];
  for (const [section, reason] of Object.entries(SECTION_REASON)) {
    if ((local.sections as Record<string, string>)[section] !== (remote.sections as Record<string, string>)[section]) reasons.push(reason);
  }
  const specFiles: PublishCheck['specFiles'] = { added: [], removed: [], modified: [] };
  for (const [f, h] of Object.entries(local.files)) {
    if (!(f in remote.files)) specFiles.added.push(f);
    else if (remote.files[f] !== h) specFiles.modified.push(f);
  }
  for (const f of Object.keys(remote.files)) if (!(f in local.files)) specFiles.removed.push(f);
  for (const list of Object.values(specFiles)) list.sort();
  return { reasons, specFiles };
}

/**
 * Does this project need a publish? Builds the snapshot in memory (nothing is written or sent), reads the server's
 * publish state and compares digests. Never throws for a server problem: the answer carries `error` instead.
 * Against a server without `publish-state` only commits can be compared (`exact: false`).
 */
export async function checkPublish(config: SpecGuardConfig, opts: PublishOpts = {}): Promise<PublishCheck> {
  const snapshot = await buildSnapshot(config, opts);
  const digest = digestOf(snapshot);
  const env = { ...(opts.env ?? process.env), ...(opts.server ? { SPECGUARD_SERVER: opts.server } : {}), ...(opts.token ? { SPECGUARD_TOKEN: opts.token } : {}), SPECGUARD_PROJECT: snapshot.project };
  const target = serverTarget(config, env);
  const latestRun = await describeLocalRun(config, opts.run).catch(() => undefined);
  const check: PublishCheck = {
    schema: PUBLISH_CHECK_SCHEMA,
    project: snapshot.project,
    ...(opts.key ? { key: opts.key } : {}),
    server: { url: target?.url ?? '', reachable: false, signedIn: false, features: [] },
    local: { digest, ...(snapshot.commit ? { commit: snapshot.commit } : {}), ...(snapshot.branch ? { branch: snapshot.branch } : {}), ...(latestRun ? { latestRun } : {}) },
    remote: null,
    needsPublish: false,
    exact: false,
    reasons: [],
    specFiles: { added: [], removed: [], modified: [] },
    commitDiffers: false,
  };
  if (!target) {
    check.error = 'no team server is configured: set "server.url" in .specguard/config.json, SPECGUARD_SERVER, or pass --server';
    return check;
  }
  const probe = await probeServer(target.url, opts.fetchImpl, undefined, target.token);
  check.server.reachable = probe.reachable;
  check.server.features = probe.features;
  if (!probe.reachable) {
    check.error = probe.error;
    return check;
  }
  const client = new SpecGuardClient(target, opts.fetchImpl);
  const refused = (err: unknown): boolean => {
    if (err instanceof ServerRequestError && (err.status === 401 || err.status === 403)) {
      check.error = err.status === 401 ? 'not signed in to the team server (run `specguard login`, or set SPECGUARD_TOKEN)' : `the team server refused this credential for project ${snapshot.project}`;
      return true;
    }
    return false;
  };

  let state: PublishState | null;
  try {
    state = await fetchPublishState(client);
  } catch (err) {
    if (!refused(err)) check.error = `could not read the publish state: ${(err as Error).message}`;
    return check;
  }
  check.server.signedIn = true;

  if (state) {
    check.server.role = state.caller.role;
    check.server.features = state.features;
    check.exact = true;
    const snap = state.snapshot;
    const complete = state.runs.filter((r) => r.status === 'complete').sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
    const newest: RunRecord | undefined = complete[0];
    if (snap) {
      check.remote = { snapshotId: snap.id, createdAt: snap.createdAt, digest: snap.digest, ...(snap.commit ? { commit: snap.commit } : {}), ...(newest ? { latestRun: newest } : {}) };
      check.commitDiffers = Boolean(snapshot.commit && snap.commit && snapshot.commit !== snap.commit);
      if (snap.digest) {
        const diff = compareDigests(digest, snap.digest);
        check.reasons.push(...diff.reasons);
        check.specFiles = diff.specFiles;
      } else {
        // Stored before the server computed digests: it cannot say what differs.
        check.exact = false;
        check.reasons.push('server-cannot-compare');
        check.needsPublish = check.commitDiffers;
      }
    } else {
      check.reasons.push('never-published');
    }
    // A run only counts when evidence publishing is in play: a project that publishes no evidence must not show "needs publish" forever.
    if (latestRun && opts.evidence) {
      const pending = state.runs.find((r) => r.runId === latestRun.runId && r.status === 'pending');
      if (pending) check.reasons.push('run-evidence-incomplete');
      else if (!complete.some((r) => r.runId === latestRun.runId)) check.reasons.push('new-run');
    }
    check.needsPublish = check.needsPublish || check.reasons.some((r) => r !== 'server-cannot-compare');
    return check;
  }

  // An older server: compare commits only.
  check.reasons.push('server-cannot-compare');
  try {
    const info = await client.request<{ kind?: string; commit?: string; updatedAt?: string }>('GET', client.projectPath(''), { timeoutMs: 15_000 });
    if (info.kind === 'pending' || (!info.commit && !info.updatedAt)) {
      check.reasons.unshift('never-published');
      check.needsPublish = true;
    } else {
      check.remote = { snapshotId: '', createdAt: info.updatedAt ?? '', digest: null, ...(info.commit ? { commit: info.commit } : {}) };
      check.commitDiffers = !snapshot.commit || !info.commit || snapshot.commit !== info.commit;
      check.needsPublish = check.commitDiffers;
    }
  } catch (err) {
    if (err instanceof ServerRequestError && err.status === 404) {
      check.reasons.unshift('never-published');
      check.needsPublish = true;
    } else {
      check.server.signedIn = false;
      if (!refused(err)) check.error = `could not read the project: ${(err as Error).message}`;
    }
  }
  return check;
}

/** `publish --check` as a pipeline result: `publish` holds the {@link PublishCheck}; exit 0 up to date, 9 needs a publish, 1 the check failed. */
export async function runPublishCheck(config: SpecGuardConfig, opts: PublishOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('publish');
  const check = await checkPublish(config, opts);
  result.publish = check;
  if (check.error) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    result.messages.push(check.error);
  } else if (check.needsPublish) {
    result.exitCode = NEEDS_PUBLISH_EXIT;
    result.messages.push(`${check.project} needs a publish: ${check.reasons.join(', ')}${check.exact ? '' : ' (commits compared only)'}`);
  } else {
    result.created = 1;
    result.messages.push(`${check.project} is up to date on ${check.server.url}`);
  }
  return result;
}
