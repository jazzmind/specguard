/**
 * The `contract-mappings` plugin: add contract edges from a JSON file of
 * spec-to-provider mappings that another tool or an older SpecGuard wrote.
 *
 * Enabled with `"plugins": ["contract-mappings"]`. The file's location and
 * every key name are `contractMappings` config; the defaults are plain
 * (`.specguard/contract-mappings.json`, a `mappings` list of
 * `{ spec, providers, docs }`), so a file in any other shape is read by naming
 * its keys, not by changing code.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { SpecGuardConfig } from '../../core/types.js';
import type { ContractImporter, ImportedContractEdge, SpecGuardPlugin } from '../types.js';

export const DEFAULT_MAPPINGS_FILE = '.specguard/contract-mappings.json';

type Mappings = NonNullable<SpecGuardConfig['contractMappings']>;

/** `<repoKey>::<path>` for a file inside one of the workspace's repos, or null. */
function nodeFor(absPath: string, manifest: { rootDir: string; repos: Record<string, { path: string }> }): string | null {
  const normalized = path.normalize(absPath);
  for (const [key, repo] of Object.entries(manifest.repos)) {
    const repoAbs = path.resolve(manifest.rootDir, repo.path);
    if (normalized.startsWith(repoAbs + path.sep) || normalized === repoAbs) {
      return `${key}::${path.relative(repoAbs, normalized).split(path.sep).join('/')}`;
    }
  }
  return null;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : typeof value === 'string' ? [value] : [];

export const mappingImporter: ContractImporter = {
  id: 'contract-mappings',
  read(repo, manifest, config): ImportedContractEdge[] {
    const opts: Mappings = config?.contractMappings ?? {};
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(path.join(repo.absPath, opts.file ?? DEFAULT_MAPPINGS_FILE), 'utf8')) as Record<string, unknown>;
    } catch {
      return [];
    }
    const list = parsed[opts.list ?? 'mappings'];
    if (!Array.isArray(list)) return [];
    const edgeType = opts.edgeType ?? 'dependency';
    const edges: ImportedContractEdge[] = [];
    for (const raw of list as Array<Record<string, unknown>>) {
      const consumerSpec = raw[opts.spec ?? 'spec'];
      if (typeof consumerSpec !== 'string') continue;
      for (const key of opts.providers ?? ['providers']) {
        for (const dep of strings(raw[key])) {
          const providerPath = nodeFor(path.resolve(repo.absPath, dep), manifest);
          if (providerPath) edges.push({ consumerSpec, providerPath, docPage: null, type: edgeType });
        }
      }
      for (const doc of strings(raw[opts.docs ?? 'docs'])) {
        const providerPath = nodeFor(path.resolve(repo.absPath, doc), manifest);
        if (providerPath) edges.push({ consumerSpec, providerPath, docPage: doc, type: 'docs' });
      }
    }
    return edges;
  },
};

export const plugin: SpecGuardPlugin = {
  id: 'contract-mappings',
  contractImporters: [mappingImporter],
};
