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
import { z } from 'zod';

import { runContractsMap, type MapOpts } from './map.js';
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
  commands: [
    {
      name: 'contracts-map',
      description: 'propose consumer-to-provider spec mappings (from spec text, optionally a model and code) and write .specguard/contract-mappings.json',
      needsConfig: false,
      output: 'messages',
      options: [
        { flags: '--workspace <path>', description: 'workspace manifest, root or .code-workspace' },
        { flags: '--repo <key>', description: 'map only this consumer repo' },
        { flags: '--dry-run', description: 'print the proposal, write nothing' },
        { flags: '--min-confidence <n>', description: 'drop suggestions below this confidence, 0 to 1 (default 0.6)' },
        { flags: '--with-llm', description: 'ask the model about specs the text did not settle (sends their text; says so first)' },
        { flags: '--max-llm-specs <n>', description: 'most specs or files one run sends to the model (default 50)' },
        { flags: '--all-specs', description: 'with --with-llm: ask about every spec, not only the unmatched ones' },
        { flags: '--with-code', description: 'also match client calls to endpoint definitions in code (local, no model)' },
        { flags: '--send-code', description: 'with --with-llm and --with-code: send code excerpts around unmatched calls to the model' },
        { flags: '--assess', description: 'report whether reading code would help; no model, nothing written' },
      ],
      mcpParams: {
        workspace: z.string().optional().describe('Workspace manifest, root or .code-workspace.'),
        repo: z.string().optional().describe('Map only this consumer repo.'),
        dryRun: z.boolean().optional().describe('Print the proposal, write nothing.'),
        minConfidence: z.number().optional().describe('Drop suggestions below this confidence (default 0.6).'),
        withLlm: z.boolean().optional().describe('Ask the model about specs the text did not settle.'),
        maxLlmSpecs: z.number().optional().describe('Most specs or files one run sends to the model (default 50).'),
        allSpecs: z.boolean().optional().describe('With withLlm: ask about every spec.'),
        withCode: z.boolean().optional().describe('Also match client calls to endpoint definitions in code.'),
        sendCode: z.boolean().optional().describe('With withLlm and withCode: send code excerpts to the model.'),
        assess: z.boolean().optional().describe('Report whether reading code would help; writes nothing.'),
      },
      run: ({ opts }) => runContractsMap(opts as MapOpts),
    },
  ],
};
