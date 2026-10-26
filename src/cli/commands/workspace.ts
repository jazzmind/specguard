/**
 * `specguard workspace <subcommand>` — workspace-level management commands.
 *
 * Subcommands:
 *   init    — create .specguard/workspace.json from sibling repo dirs, a folder tree or a .code-workspace
 *   sync    — bring the manifest in step with its .code-workspace
 *   ignore / unignore — leave a repo out of (or back in) every workspace pipeline
 *   status  — cross-repo health dashboard
 */
import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { writeFile } from '../../core/writer.js';
import { fileExists } from '../../core/reader.js';
import {
  loadWorkspaceWithConfigs,
  manifestRootForCodeWorkspace,
  resolveWorkspaceRoot,
  workspaceHint,
  CODE_WORKSPACE_SETTING,
  type WorkspaceManifest,
  type WorkspaceRepoWithConfig,
} from '../../core/workspace.js';
import { applyEdits, modify } from 'jsonc-parser';
import { readFileSync, writeFileSync } from 'node:fs';
import { setIgnoreOnDisk, syncManifestOnDisk, type SyncChange } from '../../core/workspace-sync.js';
import { loadContractGraph } from '../../core/contracts.js';
import { guessRepoRole, workspaceRepoKey } from '../../core/workspace-heuristics.js';
import { overlayCoverage } from '../../core/overlay.js';

// ---------------------------------------------------------------------------
// workspace init
// ---------------------------------------------------------------------------

export interface WorkspaceInitOpts {
  /** Explicit workspace root (defaults to cwd). */
  cwd?: string;
  /** Name for the workspace. */
  name?: string;
  /** A `.code-workspace` file to register the folders of, and to keep in sync with. */
  from?: string;
  /** Scan nested folders instead of only direct children. */
  recursive?: boolean;
  /** How deep `--recursive` goes. */
  depth?: number;
  /** Write the manifest location into the `.code-workspace`'s settings. */
  link?: boolean;
}

interface ScannedRepo { rel: string; configured: boolean }

/**
 * Find repos below `root`. A folder with a SpecGuard config (or whose specs an overlay holds) is a configured repo
 * and one with only `.git` is an unconfigured repo; neither is searched further. Hidden folders and
 * node_modules are skipped.
 */
export function scanRepos(root: string, maxDepth: number): ScannedRepo[] {
  const found: ScannedRepo[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const abs = path.join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (existsSync(path.join(abs, '.specguard', 'config.json'))) found.push({ rel, configured: true });
      else if (existsSync(path.join(abs, '.git'))) found.push({ rel, configured: overlayCoverage(abs) !== null });
      else if (depth < maxDepth) walk(abs, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}

/** Write `specguard.workspaceManifest` into a `.code-workspace` file, keeping its comments and layout. */
export function linkCodeWorkspace(file: string, manifestRoot: string): void {
  const text = readFileSync(file, 'utf-8');
  const value = path.relative(path.dirname(file), manifestRoot).split(path.sep).join('/') || '.';
  const edits = modify(text, ['settings', CODE_WORKSPACE_SETTING], value, {
    formattingOptions: { insertSpaces: false, tabSize: 1 },
  });
  writeFileSync(file, applyEdits(text, edits));
}

function printChanges(changes: SyncChange[]): void {
  if (changes.length === 0) {
    process.stdout.write('  already in step\n');
    return;
  }
  for (const c of changes) process.stdout.write(`  ${c.type.padEnd(9)} ${c.key}  ${c.detail}\n`);
}

/**
 * Create a workspace manifest. By default it registers the direct child folders that have a
 * SpecGuard config; `--recursive` searches deeper and `--from` takes the folders of a
 * `.code-workspace` file instead.
 */
export async function workspaceInitCommand(opts: WorkspaceInitOpts = {}): Promise<void> {
  if (opts.from) {
    const file = path.resolve(opts.from);
    if (!existsSync(file) || !file.endsWith('.code-workspace')) {
      process.stderr.write(`[workspace] ${opts.from} is not a .code-workspace file\n`);
      process.exit(1);
    }
    const manifestRoot = manifestRootForCodeWorkspace(file);
    const manifestPath = path.join(manifestRoot, '.specguard', 'workspace.json');
    if (!(await fileExists(manifestPath))) {
      const manifest = {
        version: '1.0',
        name: opts.name ?? path.basename(file, '.code-workspace'),
        repos: {},
        source: { codeWorkspace: path.relative(manifestRoot, file).split(path.sep).join('/'), mode: 'auto', autoIgnoreUnconfigured: true },
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      process.stdout.write(`[workspace] Created ${manifestPath}\n`);
    }
    const result = syncManifestOnDisk(manifestRoot, file);
    if (opts.link) linkCodeWorkspace(file, manifestRoot);
    process.stdout.write(`[workspace] Synced with ${file}\n`);
    printChanges(result.changes);
    process.stdout.write(`\nUse it with: --workspace ${file}  (or SPECGUARD_WORKSPACE)\n`);
    process.exit(0);
  }

  const workspaceRoot = path.resolve(opts.cwd ?? process.cwd());
  const manifestPath = path.join(workspaceRoot, '.specguard', 'workspace.json');

  if (await fileExists(manifestPath)) {
    process.stdout.write(
      `[workspace] Manifest already exists at ${manifestPath}\n` +
        `  Edit it directly or delete it and re-run to recreate.\n`,
    );
    process.exit(0);
  }

  const workspaceName = opts.name ?? path.basename(workspaceRoot);

  const repos: Record<string, { path: string; role: string; origin: string; ignore?: boolean; ignoreReason?: string }> = {};
  if (!existsSync(workspaceRoot)) {
    process.stderr.write(`[workspace] Cannot read workspace dir: ${workspaceRoot}\n`);
    process.exit(1);
  }
  // Without --recursive only direct children are searched, as before.
  for (const found of scanRepos(workspaceRoot, opts.recursive ? (opts.depth ?? 3) : 1)) {
    if (!opts.recursive && !found.configured) continue;
    const abs = path.join(workspaceRoot, found.rel);
    let key = workspaceRepoKey(path.basename(found.rel));
    if (repos[key]) key = workspaceRepoKey(found.rel);
    repos[key] = {
      path: found.rel,
      role: guessRepoRole(abs),
      origin: 'scan',
      ...(found.configured ? {} : { ignore: true, ignoreReason: 'auto:no-config' }),
    };
  }

  if (Object.values(repos).every((r) => r.ignore) ) {
    process.stdout.write(
      `[workspace] No repos with .specguard/config.json found under ${workspaceRoot}.\n` +
        `  Run \`specguard init\` inside each repo first, then re-run \`specguard workspace init\`.\n`,
    );
    process.exit(1);
  }

  const manifest = {
    version: '1.0',
    name: workspaceName,
    repos,
    _comment:
      'Workspace manifest for specguard workspace-level commands. ' +
      'Add repos with role: consumer | provider | test | docs',
  };

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  process.stdout.write(`[workspace] Created ${manifestPath}\n`);
  process.stdout.write(`  Repos registered: ${Object.entries(repos).filter(([, r]) => !r.ignore).map(([k]) => k).join(', ')}\n`);
  const skipped = Object.entries(repos).filter(([, r]) => r.ignore).map(([k]) => k);
  if (skipped.length > 0) process.stdout.write(`  Ignored (no SpecGuard config): ${skipped.join(', ')}\n`);
  process.stdout.write('\nNext steps:\n');
  process.stdout.write('  1. Review .specguard/workspace.json — adjust repo keys and roles\n');
  process.stdout.write('  2. Run `specguard contracts` to build the dependency graph\n');
  process.stdout.write('  3. Run `specguard workspace status` to see the health dashboard\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// workspace sync / ignore / unignore
// ---------------------------------------------------------------------------

export interface WorkspacePointerOpts {
  /** `--workspace`: a manifest, its directory or a .code-workspace file. */
  workspace?: string;
  cwd?: string;
}

function manifestRootOrExit(opts: WorkspacePointerOpts): string {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const hint = workspaceHint(opts.workspace);
  const root = hint ? resolveWorkspaceRoot(hint, cwd) : walkUp(cwd);
  if (!root) {
    process.stderr.write('[workspace] No workspace.json found. Run `specguard workspace init` first, or pass --workspace.\n');
    process.exit(1);
  }
  return root;
}

function walkUp(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.specguard', 'workspace.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function workspaceSyncCommand(opts: WorkspacePointerOpts & { from?: string } = {}): Promise<void> {
  const root = manifestRootOrExit(opts);
  try {
    const result = syncManifestOnDisk(root, opts.from ? path.resolve(opts.from) : undefined);
    process.stdout.write(`[workspace] Synced ${path.join(root, '.specguard', 'workspace.json')}\n`);
    printChanges(result.changes);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[workspace] ${(err as Error).message}\n`);
    process.exit(1);
  }
}

export async function workspacePublishCommand(opts: WorkspacePointerOpts & { name?: string; server?: string; token?: string; json?: boolean }): Promise<void> {
  const { runWorkspacePublish } = await import('../../pipelines/workspace-publish.js');
  const { outputResult } = await import('./helpers.js');
  const root = manifestRootOrExit(opts);
  try {
    outputResult(await runWorkspacePublish(root, root, { name: opts.name, server: opts.server, token: opts.token }), opts);
  } catch (err) {
    process.stderr.write(`[workspace] ${(err as Error).message}\n`);
    process.exit(1);
  }
}

export async function workspaceIgnoreCommand(key: string, ignore: boolean, opts: WorkspacePointerOpts & { reason?: string } = {}): Promise<void> {
  const root = manifestRootOrExit(opts);
  try {
    setIgnoreOnDisk(root, key, ignore, opts.reason);
    process.stdout.write(`[workspace] ${key} is ${ignore ? 'now ignored' : 'no longer ignored'}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[workspace] ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// workspace status
// ---------------------------------------------------------------------------

export interface WorkspaceStatusOpts {
  cwd?: string;
  workspace?: string;
}

export async function workspaceStatusCommand(opts: WorkspaceStatusOpts = {}): Promise<void> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());

  let manifest: WorkspaceManifest;
  let repos: WorkspaceRepoWithConfig[];
  try {
    ({ manifest, repos } = await loadWorkspaceWithConfigs(cwd, workspaceHint(opts.workspace)));
  } catch {
    process.stderr.write(
      '[workspace] No workspace.json found. Run `specguard workspace init` first.\n',
    );
    process.exit(1);
  }

  const contractGraph = await loadContractGraph(manifest.rootDir);
  const totalEdges = contractGraph?.edges.length ?? 0;
  const totalNodes = contractGraph?.nodes.length ?? 0;

  // Count specs per repo
  const specCountByRepo: Record<string, number> = {};
  const consumerEdgesByRepo: Record<string, number> = {};
  const providerEdgesByRepo: Record<string, number> = {};

  for (const repo of repos) {
    const specDir = repo.specGuardConfig
      ? path.resolve(repo.absPath, repo.specGuardConfig.apps[0]?.specDir ?? 'specs')
      : path.join(repo.absPath, 'specs');

    let count = 0;
    try {
      const { loadAllSpecs } = await import('../../core/spec-parser.js');
      count = loadAllSpecs(specDir).length;
    } catch {
      count = 0;
    }
    specCountByRepo[repo.key] = count;
  }

  if (contractGraph) {
    for (const edge of contractGraph.edges) {
      const consumerRepo = edge.consumer.split('::')[0];
      const providerRepo = edge.provider.split('::')[0];
      consumerEdgesByRepo[consumerRepo] = (consumerEdgesByRepo[consumerRepo] ?? 0) + 1;
      providerEdgesByRepo[providerRepo] = (providerEdgesByRepo[providerRepo] ?? 0) + 1;
    }
  }

  // Edge health
  const now = Date.now();
  const staleDays = 30;
  const staleEdges = contractGraph?.edges.filter((e) => {
    if (!e.lastVerified) return true;
    const verifiedMs = new Date(e.lastVerified).getTime();
    return now - verifiedMs > staleDays * 24 * 60 * 60 * 1000;
  }) ?? [];

  // --- Render ---------------------------------------------------------------
  process.stdout.write(`\nWorkspace: ${manifest.name}\n`);
  process.stdout.write(
    `  ${repos.length} repos${Object.keys(manifest.ignored ?? {}).length ? ` (+${Object.keys(manifest.ignored).length} ignored)` : ''}  ·  ${totalNodes} nodes  ·  ${totalEdges} contract edges\n\n`,
  );

  // Repo table
  const COL_KEY = 20;
  const COL_ROLE = 12;
  const COL_SPECS = 7;
  const COL_OUT = 10;
  const COL_IN = 10;
  const COL_STATUS = 20;

  process.stdout.write(
    `  ${'Repo'.padEnd(COL_KEY)}${'Role'.padEnd(COL_ROLE)}${'Specs'.padEnd(COL_SPECS)}${'Out edges'.padEnd(COL_OUT)}${'In edges'.padEnd(COL_IN)}Status\n`,
  );
  process.stdout.write(`  ${'─'.repeat(COL_KEY + COL_ROLE + COL_SPECS + COL_OUT + COL_IN + COL_STATUS)}\n`);

  for (const repo of repos) {
    const specCount = specCountByRepo[repo.key] ?? 0;
    const outCount = consumerEdgesByRepo[repo.key] ?? 0;
    const inCount = providerEdgesByRepo[repo.key] ?? 0;
    const hasConfig = repo.specGuardConfig != null;
    const hasTraceability = await fileExists(
      path.join(repo.absPath, '.specguard', 'traceability.json'),
    );

    const status = !hasConfig
      ? '✗ no specguard config'
      : !hasTraceability
        ? '⚠ no traceability.json'
        : '✓ configured';

    process.stdout.write(
      `  ${repo.key.padEnd(COL_KEY)}${repo.role.padEnd(COL_ROLE)}${String(specCount).padEnd(COL_SPECS)}${String(outCount).padEnd(COL_OUT)}${String(inCount).padEnd(COL_IN)}${status}\n`,
    );
  }

  const ignoredKeys = Object.keys(manifest.ignored ?? {});
  if (ignoredKeys.length > 0) {
    process.stdout.write('\n  Ignored (left out of every workspace pipeline):\n');
    for (const key of ignoredKeys) {
      const reason = manifest.ignored[key].ignoreReason;
      process.stdout.write(`    ${key.padEnd(COL_KEY)}${reason ?? 'ignored'}\n`);
    }
  }

  // Contract health summary
  process.stdout.write('\n  Contract health:\n');
  if (!contractGraph) {
    process.stdout.write(
      '    ✗ No contracts.json found — run `specguard contracts` to build the graph\n',
    );
  } else {
    const verifiedCount = totalEdges - staleEdges.length;
    process.stdout.write(`    ${verifiedCount}/${totalEdges} edges verified (last ${staleDays} days)\n`);
    if (staleEdges.length > 0) {
      process.stdout.write(`    ${staleEdges.length} edge(s) stale (> ${staleDays} days since verified)\n`);
    }

    // Edge type breakdown
    const typeBreakdown: Record<string, number> = {};
    for (const edge of contractGraph.edges) {
      typeBreakdown[edge.type] = (typeBreakdown[edge.type] ?? 0) + 1;
    }
    const typeStr = Object.entries(typeBreakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}:${n}`)
      .join('  ');
    if (typeStr) process.stdout.write(`    By type: ${typeStr}\n`);
  }

  process.stdout.write('\n');
  process.exit(0);
}
