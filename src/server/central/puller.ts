/**
 * Fetches the evidence CI uploaded and publishes it into the server.
 *
 * The sandbox cannot receive webhooks, and GitHub's hosted runners cannot reach it, so the server asks GitHub
 * instead: for each configured repository it lists the SpecGuard Action's `specguard-evidence` artifacts, downloads
 * the ones it has not seen, and publishes the snapshot inside. The commit and branch come from the workflow run, not
 * from the file, and runs from forks are ignored.
 *
 * Spec: specs/capabilities/team-server.md
 */
import { unzipSync } from 'fflate';

import { MAX_SNAPSHOT_BYTES, parseSnapshot, type Snapshot } from '../../core/snapshot.js';
import type { Backend } from './backend.js';
import type { GithubSource } from './config.js';
import type { CentralRegistry } from './registry.js';

export interface PullerOptions {
  sources: GithubSource[];
  token?: string;
  apiUrl?: string;
  artifact?: string;
  registry: CentralRegistry;
  backend: Backend;
  /** For tests. Default: the global `fetch`. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

interface GithubArtifact {
  id: number;
  name: string;
  expired: boolean;
  size_in_bytes: number;
  created_at: string;
  archive_download_url: string;
  workflow_run?: { id: number; repository_id?: number; head_repository_id?: number; head_branch?: string; head_sha?: string };
}

export interface PullResult {
  repo: string;
  /** Artifacts published this time. */
  published: number;
  /** Artifacts skipped: already stored, expired, from a fork, too large, or not a valid snapshot. */
  skipped: number;
  error?: string;
}

/** The snapshot file inside the artifact zip, wherever the upload put the root. */
export function findSnapshotInZip(bytes: Uint8Array): string | undefined {
  const files = unzipSync(bytes, { filter: (f) => /(^|\/)snapshot\.json$/.test(f.name) && f.originalSize <= MAX_SNAPSHOT_BYTES });
  const names = Object.keys(files).sort((a, b) => a.length - b.length);
  const name = names.find((n) => n.endsWith('publish/snapshot.json')) ?? names[0];
  return name ? new TextDecoder().decode(files[name]) : undefined;
}

export function createPuller(opts: PullerOptions): { pollOnce(): Promise<PullResult[]>; start(intervalMs: number): void; stop(): void } {
  const api = (opts.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const name = opts.artifact ?? 'specguard-evidence';
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => undefined);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
  };
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function pullSource(source: GithubSource): Promise<PullResult> {
    const result: PullResult = { repo: source.repo, published: 0, skipped: 0 };
    const listed = await doFetch(`${api}/repos/${source.repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=30`, { headers });
    if (!listed.ok) return { ...result, error: `GitHub answered ${listed.status} listing artifacts for ${source.repo}` };
    const artifacts = ((await listed.json()) as { artifacts?: GithubArtifact[] }).artifacts ?? [];
    // Oldest first, so the newest ends up as the one shown.
    for (const artifact of [...artifacts].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      const run = artifact.workflow_run;
      if (artifact.expired || !run?.head_sha) {
        result.skipped += 1;
        continue;
      }
      // A run from a fork is not this project's code, and anyone can open one.
      if (run.head_repository_id !== undefined && run.repository_id !== undefined && run.head_repository_id !== run.repository_id) {
        result.skipped += 1;
        continue;
      }
      if (artifact.size_in_bytes > MAX_SNAPSHOT_BYTES * 2 || (await opts.backend.snapshots.has(source.project, run.head_sha, run.head_branch))) {
        result.skipped += 1;
        continue;
      }
      const zip = await doFetch(artifact.archive_download_url, { headers, redirect: 'follow' });
      if (!zip.ok) {
        result.skipped += 1;
        log(`[puller] ${source.repo}: downloading artifact ${artifact.id} failed (${zip.status})`);
        continue;
      }
      let text: string | undefined;
      try {
        text = findSnapshotInZip(new Uint8Array(await zip.arrayBuffer()));
      } catch {
        text = undefined;
      }
      const parsed = text ? parseSnapshot(text) : undefined;
      if (!parsed?.ok) {
        result.skipped += 1;
        log(`[puller] ${source.repo}: artifact ${artifact.id} holds no valid snapshot${parsed && !parsed.ok ? ` (${parsed.error})` : ''}`);
        continue;
      }
      const snapshot: Snapshot = {
        ...parsed.snapshot,
        project: source.project,
        repo: source.repo,
        commit: run.head_sha,
        ...(run.head_branch ? { branch: run.head_branch } : {}),
        origin: 'ci',
      };
      await opts.registry.publish(snapshot);
      await opts.backend.audit({ at: new Date().toISOString(), actor: 'puller', action: 'snapshot.pull', project: source.project, detail: `${source.repo}@${run.head_sha.slice(0, 8)} artifact ${artifact.id}` }).catch(() => undefined);
      result.published += 1;
    }
    return result;
  }

  async function pollOnce(): Promise<PullResult[]> {
    const out: PullResult[] = [];
    for (const source of opts.sources) {
      try {
        out.push(await pullSource(source));
      } catch (err) {
        out.push({ repo: source.repo, published: 0, skipped: 0, error: (err as Error).message });
      }
    }
    for (const r of out) {
      if (r.error) log(`[puller] ${r.repo}: ${r.error}`);
      else if (r.published > 0) log(`[puller] ${r.repo}: published ${r.published} snapshot(s)`);
    }
    return out;
  }

  return {
    pollOnce,
    start(intervalMs) {
      const tick = (): void => {
        if (running) return;
        running = true;
        void pollOnce().finally(() => {
          running = false;
        });
      };
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
