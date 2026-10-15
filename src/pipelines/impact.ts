/**
 * Impact pipeline — blast-radius analysis for changed specs or files.
 *
 * Given a changed file or spec, traverses the contract graph to show:
 * - Direct consumers (specs in other repos that depend on this spec)
 * - Transitive consumers (cascading deps)
 * - Suggested drift/sync actions for each affected repo
 *
 * Spec: specs/capabilities/workspaces.md
 */
import path from 'node:path';
import type { PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import {
  type ContractGraph,
  type ContractNode,
  type ContractEdge,
  loadContractGraph,
  findNode,
  nodeId,
  traverseGraph,
} from '../core/contracts.js';
import { loadConfig } from '../core/config.js';
import { buildSpecGraph } from '../core/spec-graph.js';
import { unitOfFile, type WorkspaceManifest } from '../core/workspace.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImpactOpts {
  /**
   * File or spec to analyze. Can be:
   * - A node ID like `graphql-api::specs/mutations/designer.md`
   * - A relative path from workspace root like `provider-api/specs/mutations/designer.md`
   * - An absolute path to a spec or source file
   */
  target: string;
  /** Max traversal depth (default 6). */
  maxDepth?: number;
  /** Show upstream deps (what this node depends on) as well as downstream. */
  showUpstream?: boolean;
}

export interface ImpactStep {
  node: ContractNode;
  depth: number;
  via: ContractEdge;
  direction: 'downstream' | 'upstream';
}

export interface ImpactResult {
  /** The resolved starting node. */
  startNode: ContractNode;
  /** Downstream traversal (who is affected when I change start). */
  downstream: ImpactStep[];
  /** Upstream traversal (what start depends on). */
  upstream: ImpactStep[];
  /** Suggested actions (shell commands, etc.). */
  suggestedActions: string[];
  /** Capabilities that own code in the start unit or any downstream unit. */
  capabilities: Array<{ id: string; title: string; units: string[] }>;
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the user-supplied `target` string to a node ID in the graph.
 *
 * Resolution order:
 * 1. Direct node ID match (contains `::`)
 * 2. Relative path from workspace root → match against node specs
 * 3. Absolute path → resolve against workspace manifest repos
 */
function resolveTarget(
  target: string,
  graph: ContractGraph,
  manifest: WorkspaceManifest,
): ContractNode | null {
  // 1. Direct node ID
  if (target.includes('::')) {
    return findNode(graph, target) ?? null;
  }

  // Normalize to forward slashes for comparison
  const normalized = target.replace(/\\/g, '/');

  // 1b. A unit key, or a file inside a package unit, resolves to that unit's package node.
  if (manifest.units?.[target]) {
    const node = findNode(graph, nodeId(target, 'package'));
    if (node) return node;
  }
  const owningUnit = unitOfFile(manifest, normalized);
  if (owningUnit) {
    const node = findNode(graph, nodeId(owningUnit, 'package'));
    if (node) return node;
  }

  // 2. Match against node specs (fuzzy: target is a suffix of the spec path)
  for (const node of graph.nodes) {
    const nodeSpec = node.spec.replace(/\\/g, '/');
    if (nodeSpec.endsWith(normalized) || nodeSpec === normalized) {
      return node;
    }
    // Also try without leading repo path prefix
    const repoDir = manifest.repos[node.repo]?.path ?? node.repo;
    const fullPath = `${repoDir}/${nodeSpec}`.replace(/\\/g, '/');
    if (fullPath.endsWith(normalized) || fullPath === normalized) {
      return node;
    }
  }

  // 3. Absolute path
  if (path.isAbsolute(target)) {
    for (const [key, repo] of Object.entries(manifest.repos)) {
      const repoAbs = path.resolve(manifest.rootDir, repo.path);
      if (target.startsWith(repoAbs + path.sep)) {
        const relPath = path.relative(repoAbs, target).split(path.sep).join('/');
        const candidateId = nodeId(key, relPath);
        const node = findNode(graph, candidateId);
        if (node) return node;
        // Also try matching spec keys (without file extension)
        const relNoExt = relPath.replace(/\.md$/, '');
        for (const n of graph.nodes) {
          if (n.repo === key && (n.spec === relPath || n.spec.replace(/\.md$/, '') === relNoExt)) {
            return n;
          }
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Capabilities in the blast radius
// ---------------------------------------------------------------------------

/**
 * The capabilities that own code in any of `units`. A change to a package is
 * a change to the functionality built on it, so impact is reported in
 * capabilities as well as in units. Empty when the workspace root has no v2 specs.
 */
export async function capabilitiesIn(manifest: WorkspaceManifest, units: string[]): Promise<ImpactResult['capabilities']> {
  let config;
  try {
    config = await loadConfig(manifest.rootDir);
  } catch {
    return [];
  }
  const graph = await buildSpecGraph(config);
  const wanted = new Set(units);
  const out: ImpactResult['capabilities'] = [];
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'capability' && node.kind !== 'component') continue;
    const touched = [...new Set(node.ownedFiles.map((f) => unitOfFile(manifest, f)).filter((u): u is string => Boolean(u) && wanted.has(u as string)))].sort();
    if (touched.length > 0) out.push({ id: node.id, title: node.spec.title || node.id, units: touched });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Suggested actions builder
// ---------------------------------------------------------------------------

function buildSuggestedActions(
  startNode: ContractNode,
  downstream: ImpactStep[],
  manifest: WorkspaceManifest,
): string[] {
  const actions: string[] = [];
  const seen = new Set<string>();

  // Group downstream by repo
  const repoToSteps = new Map<string, ImpactStep[]>();
  for (const step of downstream) {
    const repo = step.node.repo;
    if (!repoToSteps.has(repo)) repoToSteps.set(repo, []);
    repoToSteps.get(repo)!.push(step);
  }

  for (const [repo, steps] of repoToSteps) {
    const repoPath = manifest.repos[repo]?.path;
    if (!repoPath) continue;

    // Dedupe spec keys
    const specKeys = [...new Set(steps.map((s) => s.node.spec))];

    for (const spec of specKeys) {
      const specKey = spec.replace(/^specs\//, '').replace(/\.md$/, '');
      const actionKey = `${repo}:drift:${specKey}`;
      if (seen.has(actionKey)) continue;
      seen.add(actionKey);
      actions.push(`cd ${repoPath} && specguard drift --spec ${specKey}`);
    }

    // Docs repos: suggest updating docs
    const repoRole = manifest.repos[repo]?.role;
    if (repoRole === 'docs') {
      const docPaths = [...new Set(steps.map((s) => s.node.spec))];
      for (const docPath of docPaths) {
        actions.push(`Update docs: ${repoPath}/${docPath}`);
      }
    }
  }

  // Always suggest re-running contracts after changes
  if (downstream.length > 0) {
    actions.push(`specguard contracts --force  # refresh graph after changes`);
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runImpact(
  manifest: WorkspaceManifest,
  opts: ImpactOpts,
): Promise<{ result: PipelineResult; impact: ImpactResult | null }> {
  const result = emptyResult('impact');
  const log = (line: string) => result.messages.push(line);

  const graph = await loadContractGraph(manifest.rootDir);
  if (!graph) {
    result.exitCode = ExitCode.InternalError;
    result.messages.push(
      '[impact] No contracts.json found. Run `specguard contracts` first.',
    );
    return { result, impact: null };
  }

  const startNode = resolveTarget(opts.target, graph, manifest);
  if (!startNode) {
    result.exitCode = ExitCode.InternalError;
    result.messages.push(
      `[impact] Cannot resolve target: ${opts.target}\n` +
        `  Try a node ID like: graphql-api::specs/mutations/designer.md\n` +
        `  Or a path relative to workspace root like: provider-api/specs/mutations/designer.md`,
    );
    return { result, impact: null };
  }

  const maxDepth = opts.maxDepth ?? 6;

  // Downstream: who is affected if I change startNode?
  const downstreamSteps = traverseGraph(graph, startNode.id, 'downstream', maxDepth);
  const downstream: ImpactStep[] = downstreamSteps.map((s) => ({
    node: findNode(graph, s.nodeId) ?? {
      id: s.nodeId,
      repo: s.nodeId.split('::')[0] ?? s.nodeId,
      spec: s.nodeId.split('::')[1] ?? s.nodeId,
      title: s.nodeId,
    },
    depth: s.depth,
    via: s.via,
    direction: 'downstream' as const,
  }));

  // Upstream: what does startNode depend on?
  const upstreamSteps = opts.showUpstream
    ? traverseGraph(graph, startNode.id, 'upstream', maxDepth)
    : [];
  const upstream: ImpactStep[] = upstreamSteps.map((s) => ({
    node: findNode(graph, s.nodeId) ?? {
      id: s.nodeId,
      repo: s.nodeId.split('::')[0] ?? s.nodeId,
      spec: s.nodeId.split('::')[1] ?? s.nodeId,
      title: s.nodeId,
    },
    depth: s.depth,
    via: s.via,
    direction: 'upstream' as const,
  }));

  const suggestedActions = buildSuggestedActions(startNode, downstream, manifest);

  // Package nodes are units: report the capabilities built on them too.
  const affectedUnitKeys = [startNode, ...downstream.map((d) => d.node)].filter((n) => n.spec === 'package').map((n) => n.repo);
  const capabilities = affectedUnitKeys.length > 0 ? await capabilitiesIn(manifest, affectedUnitKeys) : [];
  const downstreamUnits = downstream.filter((d) => d.node.spec === 'package').map((d) => d.node.repo);
  if (downstreamUnits.length > 0) {
    suggestedActions.unshift(`specguard test run --unit ${[startNode.repo, ...downstreamUnits].join(' --unit ')}  # or: specguard test run --affected`);
  }

  // Build messages
  log(`Impact analysis for: ${startNode.id}`);
  log(`  Title: ${startNode.title}`);
  log('');

  if (downstream.length === 0) {
    log('  No downstream consumers found. No other specs depend on this node.');
  } else {
    const direct = downstream.filter((s) => s.depth === 1);
    const transitive = downstream.filter((s) => s.depth > 1);

    log(`  Direct consumers (${direct.length}):`);
    for (const step of direct) {
      const surface = step.via.surface.length > 0 ? `\n      surface: ${step.via.surface.join(', ')}` : '';
      log(`    ${step.node.id} [${step.via.type}]${surface}`);
    }

    if (transitive.length > 0) {
      log('');
      log(`  Transitive (${transitive.length}):`);
      for (const step of transitive) {
        const via = step.via.consumer === startNode.id ? step.via.consumer : `${step.via.consumer} → `;
        log(`    ${step.node.id} [depth ${step.depth}] via ${via}`);
      }
    }
  }

  if (capabilities.length > 0) {
    log('');
    log(`  Capabilities with code in these units (${capabilities.length}):`);
    for (const c of capabilities) log(`    ${c.id}  (${c.units.join(', ')})`);
  }

  if (upstream.length > 0) {
    log('');
    log(`  Upstream dependencies (${upstream.length}):`);
    for (const step of upstream) {
      log(`    ${step.node.id} [${step.via.type}, depth ${step.depth}]`);
    }
  }

  if (suggestedActions.length > 0) {
    log('');
    log('  Suggested actions:');
    suggestedActions.forEach((a, i) => log(`    ${i + 1}. ${a}`));
  }

  result.exitCode = ExitCode.Success;
  result.created = downstream.length + upstream.length;

  const impact: ImpactResult = {
    startNode,
    downstream,
    upstream,
    suggestedActions,
    capabilities,
  };

  return { result, impact };
}
