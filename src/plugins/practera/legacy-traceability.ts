/**
 * Importer for the legacy per-repo traceability file used by older Practera
 * workspaces. It lives in `.specguard/legacy-traceability.json`, a name of its
 * own so it can no longer be overwritten by `specguard matrix`, which writes
 * `.specguard/traceability.json`.
 *
 * Spec: specs/plugins/practera.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ContractImporter, ImportedContractEdge } from '../types.js';

export const LEGACY_TRACEABILITY_FILE = 'legacy-traceability.json';

interface LegacyMapping {
  spec: string;
  sources?: string[];
  graphqlDependencies?: string[];
  docPage?: string | null;
}

function nodeFor(
  absPath: string,
  manifest: { rootDir: string; repos: Record<string, { path: string }> },
): string | null {
  const normalized = path.normalize(absPath);
  for (const [key, repo] of Object.entries(manifest.repos)) {
    const repoAbs = path.resolve(manifest.rootDir, repo.path);
    if (normalized.startsWith(repoAbs + path.sep) || normalized === repoAbs) {
      return `${key}::${path.relative(repoAbs, normalized).split(path.sep).join('/')}`;
    }
  }
  return null;
}

export const legacyTraceabilityImporter: ContractImporter = {
  id: 'practera-legacy-traceability',
  read(repo, manifest): ImportedContractEdge[] {
    let parsed: { mappings?: LegacyMapping[] };
    try {
      parsed = JSON.parse(readFileSync(path.join(repo.absPath, '.specguard', LEGACY_TRACEABILITY_FILE), 'utf8'));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed.mappings)) return [];
    const edges: ImportedContractEdge[] = [];
    for (const mapping of parsed.mappings) {
      for (const dep of mapping.graphqlDependencies ?? []) {
        const providerPath = nodeFor(path.resolve(repo.absPath, dep), manifest);
        if (providerPath) edges.push({ consumerSpec: mapping.spec, providerPath, docPage: null });
      }
      if (mapping.docPage) {
        const providerPath = nodeFor(path.resolve(repo.absPath, mapping.docPage), manifest);
        if (providerPath) edges.push({ consumerSpec: mapping.spec, providerPath, docPage: mapping.docPage });
      }
    }
    return edges;
  },
};
