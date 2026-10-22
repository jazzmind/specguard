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
import { loadWorkspaceWithConfigs, type WorkspaceManifest } from '../core/workspace.js';

export interface WorkspaceDefBody {
  description?: string;
  projects: Array<{ project: string; key: string; role: string; ignore?: boolean }>;
}

/** The workspace as the server wants it: every repo, ignored ones flagged so they are listed and not counted. */
export async function buildWorkspaceDef(manifest: WorkspaceManifest): Promise<WorkspaceDefBody> {
  const projects: WorkspaceDefBody['projects'] = [];
  const seen = new Set<string>();
  const add = async (key: string, unit: { path: string; role?: string }, ignore: boolean): Promise<void> => {
    let own: SpecGuardConfig | null = null;
    try {
      own = await loadConfig(path.resolve(manifest.rootDir, unit.path));
    } catch {
      /* not a SpecGuard repo: the directory name stands in */
    }
    const project = manifest.server?.projects?.[key] ?? own?.server?.project ?? path.basename(path.resolve(manifest.rootDir, unit.path));
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
}

export async function runWorkspacePublish(cwd: string, explicit: string | undefined, opts: WorkspacePublishOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('workspace-publish');
  const { manifest, repos } = await loadWorkspaceWithConfigs(cwd, explicit);
  const name = (opts.name ?? manifest.server?.workspace ?? manifest.name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+/, '') || 'workspace';
  const body = await buildWorkspaceDef(manifest);
  const configWithServer = repos.map((r) => r.specGuardConfig).find((c) => c?.server?.url) ?? null;
  const env = { ...process.env, ...(opts.server ? { SPECGUARD_SERVER: opts.server } : {}), ...(opts.token ? { SPECGUARD_TOKEN: opts.token } : {}) };
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
  result.messages.push(`each repo still needs its own \`specguard publish --push\` for the server to have its numbers`);
  return result;
}
