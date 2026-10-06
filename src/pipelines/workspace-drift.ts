/**
 * Workspace drift pipeline — orchestrates cross-repo drift detection.
 *
 * Identifies repos with recent changes, looks up their contract graph edges,
 * and runs `specguard drift` in each affected consumer repo for the specific
 * specs that depend on the changed files.
 *
 * Replaces the manual "run drift in both repos" workflow from AGENTS.md.
 */
import { execFileSync } from 'node:child_process';
import type { PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import {
  type ContractGraph,
  loadContractGraph,
  findNode,
  incomingEdges,
  nodeId,
} from '../core/contracts.js';
import {
  type WorkspaceManifest,
  type WorkspaceRepoWithConfig,
} from '../core/workspace.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceDriftOpts {
  /** Git ref to diff against in each repo (default `HEAD~1`). */
  since?: string;
  /**
   * Force re-check all contracts regardless of git changes.
   * Equivalent to running `specguard drift --force` in every affected repo.
   */
  force?: boolean;
  /** Restrict cross-repo drift to edges whose consumer or provider matches this repo key. */
  repo?: string;
}

export interface CrossRepoDriftFinding {
  /** Repo key that changed. */
  providerRepo: string;
  /** Spec in the provider repo that changed. */
  providerSpec: string;
  /** Repo key that consumes the changed spec. */
  consumerRepo: string;
  /** Spec in the consumer repo that depends on the changed spec. */
  consumerSpec: string;
  /** Contract type. */
  contractType: string;
  /** Result of running drift in consumer repo. */
  driftResult: 'drifted' | 'no-drift' | 'error' | 'skipped';
  message?: string;
}

// ---------------------------------------------------------------------------
// Git helper
// ---------------------------------------------------------------------------

function getChangedFilesInRepo(repoAbsPath: string, since: string): string[] {
  try {
    const out = execFileSync('git', ['diff', '--name-only', since], {
      cwd: repoAbsPath,
      encoding: 'utf-8',
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Spec-key resolution
// ---------------------------------------------------------------------------

/**
 * Given a changed file path (relative to repo root), find all spec keys that
 * are registered for that file in the contract graph.
 */
function findAffectedProviderNodes(
  changedFile: string,
  repoKey: string,
  graph: ContractGraph,
): string[] {
  // Changed file could be a spec itself
  const directNodeId = nodeId(repoKey, changedFile);
  const direct = graph.nodes.filter(
    (n) => n.id === directNodeId || (n.repo === repoKey && changedFile.includes(n.spec)),
  );

  // Also check if any source file maps to a spec (via traceability)
  // For now, match by file-path suffix overlap with node spec
  const indirect = graph.nodes.filter(
    (n) => n.repo === repoKey && !direct.find((d) => d.id === n.id),
  );

  const allCandidates = [...direct, ...indirect];
  return allCandidates.map((n) => n.id);
}

// ---------------------------------------------------------------------------
// Run drift in consumer repo
// ---------------------------------------------------------------------------

function runDriftInRepo(
  repoAbsPath: string,
  specKey: string,
  since: string,
  force: boolean,
): { verdict: 'drifted' | 'no-drift' | 'error'; output: string } {
  try {
    const args = ['drift', '--spec', specKey, '--since', since];
    if (force) args.push('--force');
    const output = execFileSync('specguard', args, {
      cwd: repoAbsPath,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    const isDrifted = output.includes('drifted') || output.toLowerCase().includes('drift detected');
    return { verdict: isDrifted ? 'drifted' : 'no-drift', output };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Exit code 3 = drift detected
    if (errMsg.includes('exit code 3') || errMsg.includes('status 3')) {
      return { verdict: 'drifted', output: errMsg };
    }
    return { verdict: 'error', output: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runWorkspaceDrift(
  manifest: WorkspaceManifest,
  repos: WorkspaceRepoWithConfig[],
  opts: WorkspaceDriftOpts,
): Promise<PipelineResult> {
  const result = emptyResult('workspace-drift');
  const log = (line: string) => result.messages.push(line);

  const graph = await loadContractGraph(manifest.rootDir);
  if (!graph) {
    result.exitCode = ExitCode.InternalError;
    result.messages.push(
      '[workspace-drift] No contracts.json found. Run `specguard contracts` first.',
    );
    return result;
  }

  const since = opts.since ?? 'HEAD~1';
  const findings: CrossRepoDriftFinding[] = [];

  const reposInScope = opts.repo
    ? repos.filter((r) => r.key === opts.repo)
    : repos;

  // --- Phase 1: Identify changed specs in each repo -------------------------
  log(`Checking for changes since ${since}...`);
  const changedNodesByRepo = new Map<string, Set<string>>();

  for (const repo of reposInScope) {
    const changedFiles = getChangedFilesInRepo(repo.absPath, since);
    if (changedFiles.length === 0) continue;

    log(`  ${repo.key}: ${changedFiles.length} file(s) changed`);

    const affectedNodeIds = new Set<string>();
    for (const file of changedFiles) {
      const nodeIds = findAffectedProviderNodes(file, repo.key, graph);
      for (const nid of nodeIds) affectedNodeIds.add(nid);
    }

    if (affectedNodeIds.size > 0) {
      changedNodesByRepo.set(repo.key, affectedNodeIds);
      log(`    → ${affectedNodeIds.size} node(s) in contract graph potentially affected`);
    }
  }

  if (changedNodesByRepo.size === 0 && !opts.force) {
    log('No repos with changes found — nothing to check.');
    result.exitCode = ExitCode.Success;
    return result;
  }

  // --- Phase 2: For each changed node, find consumers and run drift ---------
  log('\nRunning cross-repo drift checks...');

  const checkedPairs = new Set<string>(); // Avoid duplicate drift runs

  for (const [providerRepoKey, affectedNodeIds] of changedNodesByRepo) {
    for (const affectedNodeId of affectedNodeIds) {
      // Find all edges where this node is the provider
      const consumerEdges = incomingEdges(graph, affectedNodeId);

      if (consumerEdges.length === 0) continue;

      const providerNode = findNode(graph, affectedNodeId);
      if (!providerNode) continue;

      for (const edge of consumerEdges) {
        const consumerNode = findNode(graph, edge.consumer);
        if (!consumerNode) continue;

        const consumerRepo = repos.find((r) => r.key === consumerNode.repo);
        if (!consumerRepo) continue;

        // Extract spec key from consumer node
        const specKey = consumerNode.spec
          .replace(/^specs\//, '')
          .replace(/\.md$/, '');

        const pairKey = `${consumerRepo.key}:${specKey}`;
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);

        log(
          `  Checking ${consumerRepo.key}::${specKey} (depends on ${providerNode.id} via ${edge.type})`,
        );

        const { verdict, output } = runDriftInRepo(
          consumerRepo.absPath,
          specKey,
          since,
          opts.force ?? false,
        );

        findings.push({
          providerRepo: providerRepoKey,
          providerSpec: providerNode.spec,
          consumerRepo: consumerRepo.key,
          consumerSpec: specKey,
          contractType: edge.type,
          driftResult: verdict,
          message: verdict === 'error' ? output.slice(0, 200) : undefined,
        });

        if (verdict === 'drifted') {
          log(`    ⚠ DRIFT DETECTED`);
          result.failed++;
        } else if (verdict === 'no-drift') {
          log(`    ✓ no drift`);
          result.skipped++;
        } else {
          log(`    ✗ error: ${output.slice(0, 100)}`);
        }
      }
    }
  }

  // --- Summary --------------------------------------------------------------
  const drifted = findings.filter((f) => f.driftResult === 'drifted');
  const errors = findings.filter((f) => f.driftResult === 'error');

  log('');
  log(`Workspace drift summary:`);
  log(`  ${findings.length} cross-repo contract check(s)`);
  log(`  ${drifted.length} with drift detected`);
  log(`  ${errors.length} error(s)`);

  if (drifted.length > 0) {
    log('\n  Drifted contracts:');
    for (const f of drifted) {
      log(`    ${f.providerRepo}::${f.providerSpec} → ${f.consumerRepo}::${f.consumerSpec} [${f.contractType}]`);
    }
    log('\n  Suggested actions:');
    for (const f of drifted) {
      const repoPath = manifest.repos[f.consumerRepo]?.path ?? f.consumerRepo;
      log(`    cd ${repoPath} && specguard drift --spec ${f.consumerSpec} --force`);
    }
  }

  result.created = drifted.length;
  result.exitCode = drifted.length > 0 ? 3 : ExitCode.Success; // 3 = drift detected
  return result;
}
