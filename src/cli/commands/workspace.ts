/**
 * `specguard workspace <subcommand>` — workspace-level management commands.
 *
 * Subcommands:
 *   init    — create .specguard/workspace.json by scanning sibling repo dirs
 *   status  — cross-repo health dashboard
 */
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { writeFile } from '../../core/writer.js';
import { fileExists } from '../../core/reader.js';
import {
  loadWorkspaceWithConfigs,
  type WorkspaceManifest,
  type WorkspaceRepoWithConfig,
} from '../../core/workspace.js';
import { loadContractGraph } from '../../core/contracts.js';
import { guessRepoRole, workspaceRepoKey } from '../../core/workspace-heuristics.js';

// ---------------------------------------------------------------------------
// workspace init
// ---------------------------------------------------------------------------

export interface WorkspaceInitOpts {
  /** Explicit workspace root (defaults to cwd). */
  cwd?: string;
  /** Name for the workspace. */
  name?: string;
}

/**
 * Scan sibling directories for `.specguard/config.json` and
 * create a workspace manifest at `<cwd>/.specguard/workspace.json`.
 */
export async function workspaceInitCommand(opts: WorkspaceInitOpts = {}): Promise<void> {
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

  // Scan direct child directories for SpecGuard configs
  const repos: Record<string, { path: string; role: string; description?: string }> = {};
  let entries: string[] = [];
  try {
    entries = readdirSync(workspaceRoot);
  } catch {
    process.stderr.write(`[workspace] Cannot read workspace dir: ${workspaceRoot}\n`);
    process.exit(1);
  }

  for (const entry of entries.sort()) {
    const absEntry = path.join(workspaceRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(absEntry).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (entry.startsWith('.')) continue;

    const hasSpecGuard = await fileExists(path.join(absEntry, '.specguard', 'config.json'));
    const repoKey = workspaceRepoKey(entry);

    if (hasSpecGuard) {
      repos[repoKey] = {
        path: entry,
        role: guessRepoRole(absEntry),
      };
    }
  }

  if (Object.keys(repos).length === 0) {
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
  process.stdout.write(`  Repos registered: ${Object.keys(repos).join(', ')}\n`);
  process.stdout.write('\nNext steps:\n');
  process.stdout.write('  1. Review .specguard/workspace.json — adjust repo keys and roles\n');
  process.stdout.write('  2. Run `specguard contracts` to build the dependency graph\n');
  process.stdout.write('  3. Run `specguard workspace status` to see the health dashboard\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// workspace status
// ---------------------------------------------------------------------------

export interface WorkspaceStatusOpts {
  cwd?: string;
}

export async function workspaceStatusCommand(opts: WorkspaceStatusOpts = {}): Promise<void> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());

  let manifest: WorkspaceManifest;
  let repos: WorkspaceRepoWithConfig[];
  try {
    ({ manifest, repos } = await loadWorkspaceWithConfigs(cwd));
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
    `  ${repos.length} repos  ·  ${totalNodes} nodes  ·  ${totalEdges} contract edges\n\n`,
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
