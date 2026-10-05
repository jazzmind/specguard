/**
 * Contracts pipeline — workspace-level cross-repo dependency graph builder.
 *
 * Builds or refreshes `<workspace>/.specguard/contracts.json` by:
 * 1. Running contract importers supplied by enabled plugins (e.g. a legacy dependency file)
 * 2. Parsing each repo's spec `## Dependencies` sections for `<!-- contracts:start -->` blocks
 * 3. Optionally using LLM extraction for unstructured dependency text
 * 4. Merging, deduplicating, and validating the unified graph
 *
 * Spec: specs/pipelines/contracts.md (to be created)
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { SpecGuardConfig, PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import { fileExists } from '../core/reader.js';
import { loadAllSpecs } from '../core/spec-parser.js';
import {
  type ContractGraph,
  type ContractEdge,
  type ContractNode,
  emptyContractGraph,
  upsertNode,
  upsertEdge,
  validateGraph,
  saveContractGraph,
  loadContractGraph,
  nodeId,
  parseContractsBlock,
} from '../core/contracts.js';
import { loadPlugins } from '../plugins/index.js';
import {
  type WorkspaceManifest,
  type WorkspaceRepoWithConfig,
} from '../core/workspace.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContractsOpts {
  /** Force re-parse all specs, ignoring any existing contracts.json. */
  force?: boolean;
  /**
   * Use LLM to extract contracts from free-text Dependencies sections
   * (in addition to structured blocks). Slower but captures more coverage.
   */
  withLlm?: boolean;
  /** Restrict to a single repo key. */
  repo?: string;
  /** Plugin names whose contract importers run. Default: the union of the repos' `plugins`. */
  plugins?: string[];
}

// ---------------------------------------------------------------------------
// Spec contracts block reader
// ---------------------------------------------------------------------------

/**
 * Extract structured contract edges from a spec's Dependencies section
 * (`<!-- contracts:start --> ... <!-- contracts:end -->` block).
 */
function extractSpecBlockEdges(
  consumerRepoKey: string,
  consumerSpecPath: string,
  dependenciesText: string,
): Array<{ consumer: string; provider: string; type: string; surface: string[] }> {
  const lines = parseContractsBlock(dependenciesText);
  const edges = [];
  for (const line of lines) {
    edges.push({
      consumer: nodeId(consumerRepoKey, consumerSpecPath),
      provider: line.provider,
      type: line.type,
      surface: line.surface,
    });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// LLM extraction (optional)
// ---------------------------------------------------------------------------

/**
 * Use LLM to extract cross-repo contract references from free-text dependency
 * text in specs that do NOT have a structured `<!-- contracts:start -->` block.
 * Returns edges in the same format as `extractSpecBlockEdges`.
 */
async function extractLlmEdges(
  consumerRepoKey: string,
  consumerSpecPath: string,
  dependenciesText: string,
  specTitle: string,
  manifest: WorkspaceManifest,
  config: SpecGuardConfig,
): Promise<Array<{ consumer: string; provider: string; type: string; surface: string[] }>> {
  // Only run LLM if there is meaningful dependency text and no structured block.
  if (!dependenciesText.trim()) return [];
  if (dependenciesText.includes('contracts:start')) return []; // already has block

  // Build a list of known repos for the LLM to reference
  const repoList = Object.entries(manifest.repos)
    .map(([key, r]) => `- ${key}: ${r.path} (${r.role})`)
    .join('\n');

  const prompt = `You are analyzing a spec file's Dependencies section to extract cross-repo contracts.

Spec: ${specTitle} (${consumerRepoKey}::${consumerSpecPath})

Known repos in this workspace:
${repoList}

Dependencies section text:
---
${dependenciesText}
---

Extract ONLY cross-repo dependencies (references to other repos in the workspace, GraphQL operations, REST endpoints, iframe paths, etc.).
For each dependency found, output one line in this exact format:
<repo-key>::<spec-or-api-path> [<type>: <surface-item1>, <surface-item2>]

Types: graphql, rest, iframe, upload, event, docs
For graphql: list mutation/query names.
For rest: list HTTP method + path (e.g. POST /code/send).
For iframe: list URL paths.

If a spec path in the provider repo is not known, use a best-guess relative path like specs/mutations/designer.md.
Output ONLY the formatted lines, one per dependency. No explanations. If no cross-repo dependencies, output nothing.`;

  try {
    const { llmGenerateText } = await import('../core/llm.js');
    const raw = await llmGenerateText({
      provider: config.llm.provider,
      model: config.llm.model,
      apiKeyEnv: config.llm.apiKeyEnv,
      prompt,
      maxTokens: 800,
      temperature: 0,
    });

    const edges = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Parse lines that match the expected format
      const match = trimmed.match(/^(\S+)\s*\[(\w+):\s*([^\]]*)\]$/);
      if (!match) continue;
      const provider = match[1].trim();
      const type = match[2].trim();
      const surface = match[3].split(',').map((s: string) => s.trim()).filter(Boolean);
      if (provider && provider.includes('::')) {
        edges.push({
          consumer: nodeId(consumerRepoKey, consumerSpecPath),
          provider,
          type,
          surface,
        });
      }
    }
    return edges;
  } catch {
    // LLM failures are non-fatal
    return [];
  }
}

// ---------------------------------------------------------------------------
// Node title helpers
// ---------------------------------------------------------------------------

function specTitle(repoKey: string, specRelPath: string, manifest: WorkspaceManifest): string {
  try {
    const repoAbs = path.resolve(manifest.rootDir, manifest.repos[repoKey]?.path ?? repoKey);
    const absPath = path.join(repoAbs, specRelPath);
    const content = readFileSync(absPath, 'utf-8');
    const match = content.match(/^#\s+(.+?)\s*$/m);
    if (match) return match[1].trim();
  } catch {
    // Best-effort
  }
  // Fallback: derive from path
  return path.basename(specRelPath, '.md').replace(/-/g, ' ');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runContracts(
  manifest: WorkspaceManifest,
  repos: WorkspaceRepoWithConfig[],
  opts: ContractsOpts,
  llmConfig?: SpecGuardConfig,
): Promise<PipelineResult> {
  const result = emptyResult('contracts');
  const log = (line: string) => result.messages.push(line);

  // Load existing graph or start fresh
  const existing = opts.force ? null : await loadContractGraph(manifest.rootDir);
  const graph: ContractGraph = existing ?? emptyContractGraph();

  const reposInScope = opts.repo
    ? repos.filter((r) => r.key === opts.repo)
    : repos;

  // --- Pass 1: contract importers from enabled plugins ---------------------
  const pluginNames = opts.plugins ?? [
    ...new Set(repos.flatMap((r) => r.specGuardConfig?.plugins ?? [])),
  ];
  const importers = (await loadPlugins(pluginNames)).flatMap((p) => p.contractImporters ?? []);
  log(`Pass 1: Running ${importers.length} contract importer(s)...`);
  const importManifest = {
    rootDir: manifest.rootDir,
    repos: Object.fromEntries(Object.entries(manifest.repos).map(([k, r]) => [k, { path: r.path }])),
  };
  for (const repo of reposInScope) {
    for (const importer of importers) {
      const legacyEdges = importer.read({ key: repo.key, absPath: repo.absPath }, importManifest);
      if (legacyEdges.length === 0) continue;

      log(`  ${repo.key}: ${importer.id} found ${legacyEdges.length} link(s)`);

      for (const { consumerSpec, providerPath, docPage } of legacyEdges) {
        const consumerId = nodeId(repo.key, consumerSpec);
        const type = docPage ? 'docs' : 'graphql';

        upsertNode(graph, {
          id: consumerId,
          repo: repo.key,
          spec: consumerSpec,
          title: specTitle(repo.key, consumerSpec, manifest),
        });

        const parsed = parseNodeId_safe(providerPath);
        if (parsed) {
          upsertNode(graph, {
            id: providerPath,
            repo: parsed.repo,
            spec: parsed.spec,
            title: specTitle(parsed.repo, parsed.spec, manifest),
          });
        }

        upsertEdge(graph, {
          consumer: consumerId,
          provider: providerPath,
          type,
          surface: [],
          lastVerified: new Date().toISOString().split('T')[0],
          source: 'traceability',
        });
      }
    }
  }

  // --- Pass 2: Parse structured <!-- contracts:start --> blocks ----------------
  log('Pass 2: Parsing spec contracts blocks...');
  for (const repo of reposInScope) {
    const specDir = repo.specGuardConfig
      ? path.resolve(repo.absPath, repo.specGuardConfig.apps[0]?.specDir ?? 'specs')
      : path.join(repo.absPath, 'specs');

    let specs;
    try {
      specs = loadAllSpecs(specDir);
    } catch {
      continue;
    }

    for (const spec of specs) {
      if (!spec.dependencies) continue;
      const blockEdges = extractSpecBlockEdges(repo.key, spec.filePath.replace(repo.absPath + '/', ''), spec.dependencies);
      if (blockEdges.length === 0) continue;

      log(`  ${repo.key}::${spec.specKey}: found ${blockEdges.length} structured contract(s)`);

      // Ensure consumer node exists
      upsertNode(graph, {
        id: nodeId(repo.key, spec.filePath.replace(repo.absPath + path.sep, '').split(path.sep).join('/')),
        repo: repo.key,
        spec: spec.specKey,
        title: spec.title,
      });

      for (const edge of blockEdges) {
        // Upsert provider node
        const parsed = parseNodeId_safe(edge.provider);
        if (parsed) {
          upsertNode(graph, {
            id: edge.provider,
            repo: parsed.repo,
            spec: parsed.spec,
            title: specTitle(parsed.repo, parsed.spec, manifest),
          });
        }

        upsertEdge(graph, {
          consumer: edge.consumer,
          provider: edge.provider,
          type: edge.type,
          surface: edge.surface,
          lastVerified: new Date().toISOString().split('T')[0],
          source: 'spec-block',
        });

        result.updated++;
      }
    }
  }

  // --- Pass 3: LLM extraction (optional) ------------------------------------
  if (opts.withLlm && llmConfig) {
    log('Pass 3: LLM extraction from free-text Dependencies...');
    for (const repo of reposInScope) {
      const specDir = repo.specGuardConfig
        ? path.resolve(repo.absPath, repo.specGuardConfig.apps[0]?.specDir ?? 'specs')
        : path.join(repo.absPath, 'specs');

      let specs;
      try {
        specs = loadAllSpecs(specDir);
      } catch {
        continue;
      }

      for (const spec of specs) {
        if (!spec.dependencies || spec.dependencies.includes('contracts:start')) continue;
        const specRelPath = spec.filePath
          .replace(repo.absPath + path.sep, '')
          .split(path.sep)
          .join('/');
        const llmEdges = await extractLlmEdges(
          repo.key,
          specRelPath,
          spec.dependencies,
          spec.title,
          manifest,
          llmConfig,
        );

        if (llmEdges.length === 0) continue;
        log(`  ${repo.key}::${spec.specKey}: LLM found ${llmEdges.length} contract(s)`);

        upsertNode(graph, {
          id: nodeId(repo.key, specRelPath),
          repo: repo.key,
          spec: specRelPath,
          title: spec.title,
        });

        for (const edge of llmEdges) {
          const parsed = parseNodeId_safe(edge.provider);
          if (parsed) {
            upsertNode(graph, {
              id: edge.provider,
              repo: parsed.repo,
              spec: parsed.spec,
              title: specTitle(parsed.repo, parsed.spec, manifest),
            });
          }

          upsertEdge(graph, {
            consumer: edge.consumer,
            provider: edge.provider,
            type: edge.type,
            surface: edge.surface,
            lastVerified: new Date().toISOString().split('T')[0],
            source: 'llm',
          });
          result.created++;
        }
      }
    }
  }

  // --- Validation -----------------------------------------------------------
  log('Validating graph...');
  const validationErrors = validateGraph(graph);
  if (validationErrors.length > 0) {
    for (const err of validationErrors) {
      log(`  [warn] ${err}`);
    }
    result.messages.push(`[warn] ${validationErrors.length} graph validation warning(s)`);
  }

  // --- Persist --------------------------------------------------------------
  graph.generatedAt = new Date().toISOString();
  await saveContractGraph(manifest.rootDir, graph);

  const nodeCount = graph.nodes.length;
  const edgeCount = graph.edges.length;
  log(`Saved contracts.json: ${nodeCount} node(s), ${edgeCount} edge(s)`);

  result.created = graph.nodes.filter((n) => !existing?.nodes.find((e) => e.id === n.id)).length;
  result.updated = edgeCount;
  result.exitCode = ExitCode.Success;
  result.messages.push(
    `contracts: ${nodeCount} nodes, ${edgeCount} edges, ${validationErrors.length} validation warnings`,
  );

  return result;
}

// Safely parse a node ID without the strict path validation issue
function parseNodeId_safe(id: string): { repo: string; spec: string } | null {
  const sep = id.indexOf('::');
  if (sep === -1) return null;
  return { repo: id.slice(0, sep), spec: id.slice(sep + 2) };
}
