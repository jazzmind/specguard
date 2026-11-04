/**
 * `workspace publish`: tell a team server which projects make up this workspace, so it can show the combined view.
 *
 * Each repo of the manifest is published on its own (`specguard publish --push`); this only defines the set. A repo is
 * known to the server by its `server.project` (from its own config), the manifest's `server.projects` map, or its
 * directory name, in that order of preference for the map and config.
 *
 * Spec: specs/capabilities/workspaces.md
 */
import path from 'node:path';

import { SpecGuardClient, serverTarget, ServerRequestError, type ServerTarget } from '../client/index.js';
import { loadConfig } from '../core/config.js';
import { ExitCode } from '../core/exit-codes.js';
import type { SpecGuardConfig, PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import {
  WORKSPACE_PUBLISH_CHECK_SCHEMA,
  type PublishCheck,
  type PublishProgress,
  type WorkspacePublishCheck,
} from '../core/publish-contract.js';
import { loadWorkspaceWithConfigs, type WorkspaceManifest } from '../core/workspace.js';
import { checkPublish, NEEDS_PUBLISH_EXIT, probeServer, progressSink, runPublish } from './publish.js';
import type { EvidenceMode } from './publish-evidence.js';

/** The server-side project name of a workspace member: the manifest's map, the repo's own config, else its directory name. */
async function projectOf(manifest: WorkspaceManifest, key: string, unit: { path: string }): Promise<{ project: string; config: SpecGuardConfig | null }> {
  let own: SpecGuardConfig | null = null;
  try {
    own = await loadConfig(path.resolve(manifest.rootDir, unit.path));
  } catch {
    /* not a SpecGuard repo: the directory name stands in */
  }
  return { project: manifest.server?.projects?.[key] ?? own?.server?.project ?? path.basename(path.resolve(manifest.rootDir, unit.path)), config: own };
}

export interface WorkspaceDefBody {
  description?: string;
  projects: Array<{ project: string; key: string; role: string; ignore?: boolean }>;
}

/** The workspace as the server wants it: every repo, ignored ones flagged so they are listed and not counted. */
export async function buildWorkspaceDef(manifest: WorkspaceManifest): Promise<WorkspaceDefBody> {
  const projects: WorkspaceDefBody['projects'] = [];
  const seen = new Set<string>();
  const add = async (key: string, unit: { path: string; role?: string }, ignore: boolean): Promise<void> => {
    const { project } = await projectOf(manifest, key, unit);
    if (seen.has(project)) return;
    seen.add(project);
    projects.push({ project, key, role: unit.role ?? 'consumer', ...(ignore ? { ignore: true } : {}) });
  };
  for (const [key, repo] of Object.entries(manifest.repos)) await add(key, repo, false);
  for (const [key, unit] of Object.entries(manifest.ignored)) if (unit.kind === 'repo') await add(key, unit, true);
  return { projects };
}

export interface WorkspacePublishOpts {
  /** Workspace name on the server. Default: `server.workspace` of the manifest, else its name. */
  name?: string;
  server?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  /** Only compare with the server; publish nothing. The answer is `result.publish` (a `WorkspacePublishCheck`); exit code 9 when something needs a publish. */
  check?: boolean;
  /** Also publish every repo's snapshot (see `only`). */
  repos?: boolean;
  /** Repo keys to publish or check; default all. */
  only?: string[];
  /** Also publish each repo's newest test run. */
  evidence?: EvidenceMode;
  maxEvidenceMb?: number;
  skipOversized?: boolean;
  progressJson?: boolean;
  onProgress?: (p: PublishProgress) => void;
  /** Environment seam for tests. */
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
}

const NO_SERVER: WorkspacePublishCheck['server'] = { url: '', reachable: false, signedIn: false, features: [] };

/**
 * `workspace publish --check`: does the workspace definition, and does each repo, need publishing? Each repo is loaded
 * with its own config (overlay repos resolve through their own `.specguard`), checked by digest, and nothing is sent.
 */
export async function runWorkspacePublishCheck(cwd: string, explicit: string | undefined, opts: WorkspacePublishOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('workspace-publish');
  const { manifest, repos } = await loadWorkspaceWithConfigs(cwd, explicit);
  const name = workspaceName(manifest, opts.name);
  const env = { ...(opts.env ?? process.env), ...(opts.server ? { SPECGUARD_SERVER: opts.server } : {}), ...(opts.token ? { SPECGUARD_TOKEN: opts.token } : {}) };
  const configWithServer = repos.map((r) => r.specGuardConfig).find((c) => c?.server?.url) ?? null;
  const target = serverTarget(configWithServer, env);
  const out: WorkspacePublishCheck = { schema: WORKSPACE_PUBLISH_CHECK_SCHEMA, workspace: name, server: { ...NO_SERVER }, definition: { needsPublish: false, reasons: [] }, repos: [] };
  result.publish = out;
  if (!target) {
    result.messages.push('no team server is configured: pass --server, set SPECGUARD_SERVER, or set server.url in a repo config');
    return result;
  }
  out.server.url = target.url;
  const probe = await probeServer(target.url, opts.fetchImpl);
  out.server.reachable = probe.reachable;
  out.server.features = probe.features;
  if (!probe.reachable) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    result.messages.push(probe.error ?? 'the server did not answer');
    return result;
  }

  // The definition: missing, or a different set of projects.
  const wanted = await buildWorkspaceDef(manifest);
  const client = new SpecGuardClient(target, opts.fetchImpl);
  try {
    const def = await client.request<WorkspaceDefBody>('GET', `${target.url}/api/v1/workspaces/${encodeURIComponent(name)}`, { timeoutMs: 15_000 });
    out.server.signedIn = true;
    const sig = (p: WorkspaceDefBody['projects']): string => JSON.stringify(p.map((x) => `${x.project}|${x.key}|${x.ignore ? 'i' : ''}`).sort());
    if (sig(def.projects ?? []) !== sig(wanted.projects)) {
      out.definition = { needsPublish: true, reasons: ['projects-differ'] };
    }
  } catch (err) {
    if (err instanceof ServerRequestError && err.status === 404) {
      out.server.signedIn = true;
      out.definition = { needsPublish: true, reasons: ['missing'] };
    } else if (err instanceof ServerRequestError && (err.status === 401 || err.status === 403)) {
      result.failed = 1;
      result.exitCode = ExitCode.InternalError;
      result.messages.push(err.status === 401 ? 'not signed in to the team server (run `specguard login`, or set SPECGUARD_TOKEN)' : 'the team server refused this credential');
      return result;
    } else {
      result.failed = 1;
      result.exitCode = ExitCode.InternalError;
      result.messages.push(`could not read the workspace definition: ${(err as Error).message}`);
      return result;
    }
  }

  for (const [key, repo] of Object.entries(manifest.repos).sort(([a], [b]) => a.localeCompare(b))) {
    if (opts.only && !opts.only.includes(key)) continue;
    try {
      const { project, config } = await projectOf(manifest, key, repo);
      const loaded = config ?? (await loadConfig(path.resolve(manifest.rootDir, repo.path)));
      const check: PublishCheck = await checkPublish(loaded, { project, key, server: target.url, token: target.token, fetchImpl: opts.fetchImpl, env: opts.env });
      out.repos.push(check);
      if (check.server.role && !out.server.role) out.server.role = check.server.role;
      if (check.server.features.length > out.server.features.length) out.server.features = check.server.features;
    } catch (err) {
      out.repos.push({ key, error: (err as Error).message });
    }
  }
  const needs = out.definition.needsPublish || out.repos.some((r) => 'needsPublish' in r && r.needsPublish);
  const errors = out.repos.filter((r) => 'error' in r && r.error).length;
  const n = out.repos.filter((r) => 'needsPublish' in r && r.needsPublish).length;
  result.messages.push(`workspace "${name}": definition ${out.definition.needsPublish ? `needs publishing (${out.definition.reasons.join(', ')})` : 'is up to date'}; ${n} of ${out.repos.length} repo(s) need a publish${errors ? `, ${errors} with errors` : ''}`);
  if (needs) result.exitCode = NEEDS_PUBLISH_EXIT;
  return result;
}

const workspaceName = (manifest: WorkspaceManifest, name?: string): string =>
  (name ?? manifest.server?.workspace ?? manifest.name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+/, '') || 'workspace';

export async function runWorkspacePublish(cwd: string, explicit: string | undefined, opts: WorkspacePublishOpts = {}): Promise<PipelineResult> {
  if (opts.check) return runWorkspacePublishCheck(cwd, explicit, opts);
  const result = emptyResult('workspace-publish');
  const { manifest, repos } = await loadWorkspaceWithConfigs(cwd, explicit);
  const name = workspaceName(manifest, opts.name);
  const body = await buildWorkspaceDef(manifest);
  const configWithServer = repos.map((r) => r.specGuardConfig).find((c) => c?.server?.url) ?? null;
  const env = { ...(opts.env ?? process.env), ...(opts.server ? { SPECGUARD_SERVER: opts.server } : {}), ...(opts.token ? { SPECGUARD_TOKEN: opts.token } : {}) };
  const target: ServerTarget | null = serverTarget(configWithServer, env);
  if (!target) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    result.messages.push('no team server is configured: pass --server, set SPECGUARD_SERVER, or set server.url in a repo config');
    return result;
  }
  try {
    await new SpecGuardClient(target, opts.fetchImpl).request('PUT', `${target.url}/api/v1/workspaces/${encodeURIComponent(name)}`, { body });
  } catch (err) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    result.messages.push(err instanceof ServerRequestError ? `the server refused the workspace (${err.status}): ${err.message}` : `could not reach the server: ${(err as Error).message}`);
    return result;
  }
  result.created = 1;
  result.messages.push(`workspace "${name}": ${body.projects.filter((p) => !p.ignore).length} project(s) and ${body.projects.filter((p) => p.ignore).length} ignored, published to ${target.url}`);
  if (!opts.repos) {
    result.messages.push(`each repo still needs its own \`specguard publish --push\` for the server to have its numbers (or use --repos)`);
    return result;
  }

  // Every repo, each loaded with its own config so overlay repos resolve.
  const sink = progressSink(opts);
  for (const [key, repo] of Object.entries(manifest.repos).sort(([a], [b]) => a.localeCompare(b))) {
    if (opts.only && !opts.only.includes(key)) continue;
    try {
      const { project, config } = await projectOf(manifest, key, repo);
      const loaded = config ?? (await loadConfig(path.resolve(manifest.rootDir, repo.path)));
      const res = await runPublish(loaded, {
        project,
        key,
        push: true,
        server: target.url,
        token: target.token,
        fetchImpl: opts.fetchImpl,
        env: opts.env,
        ...(opts.evidence ? { evidence: opts.evidence } : {}),
        ...(opts.maxEvidenceMb !== undefined ? { maxEvidenceMb: opts.maxEvidenceMb } : {}),
        ...(opts.skipOversized ? { skipOversized: true } : {}),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        onProgress: sink,
        out: path.join(loaded.rootDir ?? repo.path, '.specguard/publish/snapshot.json'),
      });
      for (const m of res.messages) result.messages.push(`[${key}] ${m}`);
      if (res.failed > 0) {
        result.failed += 1;
        result.exitCode = result.exitCode || res.exitCode;
      } else {
        result.created += 1;
      }
    } catch (err) {
      result.failed += 1;
      result.exitCode = result.exitCode || ExitCode.InternalError;
      result.messages.push(`[${key}] ${(err as Error).message}`);
    }
  }
  return result;
}
