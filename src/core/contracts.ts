/**
 * Contract graph types and operations for SpecGuard workspace-level analysis.
 *
 * The contract graph models cross-repo dependencies as directed edges between
 * specs (or API surfaces) in different repositories. It is the foundation for
 * impact analysis, workspace drift, and cross-repo sync enforcement.
 *
 * File locations:
 *   - Workspace manifest: <workspace>/.specguard/workspace.json
 *   - Contract graph:     <workspace>/.specguard/contracts.json
 */
import path from 'node:path';
import { z } from 'zod';
import { readFile, fileExists } from './reader.js';
import { writeFile } from '../core/writer.js';
import { ConfigInvalidError } from './errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The type of contract represented by an edge.
 *
 * | Type      | Example |
 * |-----------|---------|
 * | graphql   | admin-app calls graphql-api mutations/queries |
 * | rest      | admin-app calls login-api POST /code/send |
 * | iframe    | admin-app embeds CakePHP pages via LegacyFrame |
 * | upload    | admin-app uses TUS protocol to tusd |
 * | event     | graphql-api triggers Lambda in practera-services |
 * | test      | test-suite regression specs cover a feature |
 * | docs      | devops-support-center documents a feature |
 */
export type ContractType =
  | 'graphql'
  | 'rest'
  | 'iframe'
  | 'upload'
  | 'event'
  | 'test'
  | 'docs'
  | string;

/** A node in the contract graph — a spec or surface in a repo. */
export interface ContractNode {
  /**
   * Unique identifier: `<repoKey>::<specPath>`.
   * Example: `admin-app::specs/setup/designer.md`
   */
  id: string;
  /** Short repo key from the workspace manifest. */
  repo: string;
  /**
   * Spec path relative to the repo root (e.g. `specs/setup/designer.md`)
   * or a surface identifier for non-spec nodes (e.g. `api/code/send`).
   */
  spec: string;
  /** Human-readable title. */
  title: string;
}

/**
 * A directed edge from consumer spec → provider spec (or surface).
 *
 * Direction: consumer depends on provider.
 * Impact analysis: when a provider changes, consumers are affected.
 */
export interface ContractEdge {
  /** Node ID of the consuming spec. */
  consumer: string;
  /** Node ID of the providing spec or surface. */
  provider: string;
  /** Type of contract (graphql, rest, iframe, etc.). */
  type: ContractType;
  /**
   * Named operations or endpoints that form the contract surface.
   * For `graphql`: mutation/query names.
   * For `rest`: HTTP method + path strings.
   * For `iframe`: URL paths.
   * For `upload`: protocol identifiers.
   * For `docs`: section slugs (optional).
   */
  surface: string[];
  /**
   * ISO date string when this edge was last verified as still valid.
   * Null means never verified.
   */
  lastVerified: string | null;
  /**
   * Source of this edge entry (how it was discovered).
   * 'traceability' = from existing traceability.json graphqlDependencies
   * 'spec-block'   = from <!-- contracts:start --> block in spec
   * 'llm'          = LLM extraction from free-text Dependencies section
   * 'manual'       = manually authored
   */
  source: 'traceability' | 'spec-block' | 'llm' | 'manual';
}

/** The full contract graph. */
export interface ContractGraph {
  version: string;
  generatedAt: string;
  nodes: ContractNode[];
  edges: ContractEdge[];
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const nodeSchema = z.object({
  id: z.string(),
  repo: z.string(),
  spec: z.string(),
  title: z.string(),
});

const edgeSchema = z.object({
  consumer: z.string(),
  provider: z.string(),
  type: z.string(),
  surface: z.array(z.string()),
  lastVerified: z.string().nullable(),
  source: z.enum(['traceability', 'spec-block', 'llm', 'manual']),
});

const contractGraphSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
});

/** Relative path from workspace root to the contracts file. */
const CONTRACTS_REL = path.join('.specguard', 'contracts.json');

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

/** Build a node ID from repo key and spec path. */
export function nodeId(repo: string, spec: string): string {
  return `${repo}::${spec}`;
}

/** Parse a node ID into its repo key and spec path. */
export function parseNodeId(id: string): { repo: string; spec: string } | null {
  const sep = id.indexOf('::');
  if (sep === -1) return null;
  return { repo: id.slice(0, sep), spec: id.slice(sep + 2) };
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Load the contract graph from `<workspaceRoot>/.specguard/contracts.json`.
 * Returns null if the file does not exist.
 */
export async function loadContractGraph(workspaceRoot: string): Promise<ContractGraph | null> {
  const contractsPath = path.resolve(workspaceRoot, CONTRACTS_REL);
  if (!(await fileExists(contractsPath))) return null;

  const raw = await readFile(contractsPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigInvalidError(
      `contracts.json is not valid JSON (${(err as Error).message})`,
      err,
    );
  }

  const result = contractGraphSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    throw new ConfigInvalidError(`contracts.json is invalid: ${errors}`, result.error);
  }

  return result.data as ContractGraph;
}

/**
 * Write the contract graph to `<workspaceRoot>/.specguard/contracts.json`.
 */
export async function saveContractGraph(
  workspaceRoot: string,
  graph: ContractGraph,
): Promise<void> {
  const contractsPath = path.resolve(workspaceRoot, CONTRACTS_REL);
  await writeFile(contractsPath, JSON.stringify(graph, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Graph operations
// ---------------------------------------------------------------------------

/** Create an empty contract graph. */
export function emptyContractGraph(): ContractGraph {
  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    nodes: [],
    edges: [],
  };
}

/** Find a node by ID. */
export function findNode(graph: ContractGraph, id: string): ContractNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

/**
 * Upsert a node — adds it if new, updates title if changed.
 * Returns true if the graph was modified.
 */
export function upsertNode(graph: ContractGraph, node: ContractNode): boolean {
  const existing = graph.nodes.find((n) => n.id === node.id);
  if (!existing) {
    graph.nodes.push(node);
    return true;
  }
  if (existing.title !== node.title) {
    existing.title = node.title;
    return true;
  }
  return false;
}

/**
 * Upsert an edge — adds it if no edge with the same consumer+provider+type
 * exists; updates `surface` and `lastVerified` if it does.
 * Returns true if the graph was modified.
 */
export function upsertEdge(graph: ContractGraph, edge: ContractEdge): boolean {
  const existing = graph.edges.find(
    (e) => e.consumer === edge.consumer && e.provider === edge.provider && e.type === edge.type,
  );
  if (!existing) {
    graph.edges.push(edge);
    return true;
  }
  // Merge surface items (union).
  const merged = Array.from(new Set([...existing.surface, ...edge.surface]));
  const changed =
    merged.length !== existing.surface.length ||
    existing.lastVerified !== edge.lastVerified;
  if (changed) {
    existing.surface = merged;
    if (edge.lastVerified) existing.lastVerified = edge.lastVerified;
    return true;
  }
  return false;
}

/**
 * Get all edges where `nodeId` is the consumer (outgoing from this node).
 */
export function outgoingEdges(graph: ContractGraph, nodeId: string): ContractEdge[] {
  return graph.edges.filter((e) => e.consumer === nodeId);
}

/**
 * Get all edges where `nodeId` is the provider (incoming to this node).
 * These are the consumers that depend on the given provider.
 */
export function incomingEdges(graph: ContractGraph, nodeId: string): ContractEdge[] {
  return graph.edges.filter((e) => e.provider === nodeId);
}

/**
 * BFS traversal starting from `startNodeId`.
 *
 * `direction`:
 *   - `'downstream'`: follow provider → consumers (who is affected if I change this node?)
 *   - `'upstream'`:   follow consumer → providers (what does this node depend on?)
 *
 * Returns the traversal in BFS order (level 1 = direct, level 2 = transitive, etc.),
 * not including the start node itself.
 */
export interface TraversalStep {
  nodeId: string;
  depth: number;
  /** The edge that led to this node. */
  via: ContractEdge;
}

export function traverseGraph(
  graph: ContractGraph,
  startNodeId: string,
  direction: 'downstream' | 'upstream',
  maxDepth = 6,
): TraversalStep[] {
  const steps: TraversalStep[] = [];
  const visited = new Set<string>([startNodeId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: startNodeId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const edges =
      direction === 'downstream'
        ? incomingEdges(graph, current.id)
        : outgoingEdges(graph, current.id);

    for (const edge of edges) {
      const nextId = direction === 'downstream' ? edge.consumer : edge.provider;
      if (visited.has(nextId)) continue;
      visited.add(nextId);
      steps.push({ nodeId: nextId, depth: current.depth + 1, via: edge });
      queue.push({ id: nextId, depth: current.depth + 1 });
    }
  }

  return steps;
}

/**
 * Validate a contract graph: check that all node IDs referenced in edges
 * exist in the nodes list.
 *
 * Returns an array of validation error strings (empty = valid).
 */
export function validateGraph(graph: ContractGraph): string[] {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const errors: string[] = [];
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.consumer)) {
      errors.push(`Edge references unknown consumer node: ${edge.consumer}`);
    }
    if (!nodeIds.has(edge.provider)) {
      errors.push(`Edge references unknown provider node: ${edge.provider}`);
    }
  }
  return errors;
}

/**
 * Parse a structured `<!-- contracts:start -->` block from a spec's
 * Dependencies section. Returns an array of raw contract lines.
 *
 * Expected format (inside a `## Dependencies` section):
 * ```
 * <!-- contracts:start -->
 * - graphql-api::specs/mutations/designer.md [graphql: createMilestone, updateMilestone]
 * - login-api::api/code/send [rest: POST /code/send]
 * <!-- contracts:end -->
 * ```
 */
export function parseContractsBlock(dependenciesText: string): ParsedContractLine[] {
  const lines: ParsedContractLine[] = [];
  const blockMatch = dependenciesText.match(
    /<!--\s*contracts:start\s*-->([\s\S]*?)<!--\s*contracts:end\s*-->/,
  );
  if (!blockMatch) return lines;

  for (const raw of blockMatch[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('<!--')) continue;
    // Remove leading `-` or `*` bullet.
    const cleaned = line.replace(/^[-*]\s+/, '');
    const parsed = parseContractLine(cleaned);
    if (parsed) lines.push(parsed);
  }

  return lines;
}

export interface ParsedContractLine {
  /** Node ID of the provider: `<repoKey>::<specPath>` */
  provider: string;
  /** Contract type. */
  type: ContractType;
  /** Surface items. */
  surface: string[];
}

/**
 * Parse a single contract line of the form:
 * `graphql-api::specs/mutations/designer.md [graphql: createMilestone, updateMilestone]`
 */
function parseContractLine(line: string): ParsedContractLine | null {
  // Match: <provider-id> [<type>: <surface...>]  (surface is optional)
  const match = line.match(/^(\S+)\s*(?:\[(\w+):\s*([^\]]*)\])?$/);
  if (!match) return null;

  const provider = match[1].trim();
  const type = (match[2] ?? 'graphql').trim() as ContractType;
  const surface = match[3]
    ? match[3]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  if (!provider) return null;
  return { provider, type, surface };
}
