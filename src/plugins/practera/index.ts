/**
 * The `practera` plugin: everything specific to the Practera platform layout.
 *
 * Enabled with `"plugins": ["practera"]`. It supplies the catalog location and
 * the restricted catalog files, the results directories, repo-to-channel maps,
 * GraphQL-first module resolution, the admin/learner MCP tool discovery, the
 * Zephyr id adapter, and the legacy traceability importer. Core SpecGuard has
 * none of these defaults.
 *
 * Spec: specs/plugins/practera.md
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { loadCatalogDir, parseFeatureList } from '../catalog.js';
import { graphqlOperations, repoDirMap, uiModules, moduleSources } from '../discoverers.js';
import { zephyrAdapter } from '../external-id.js';
import { caseDirSource } from '../result-sources.js';
import type {
  CatalogFeatureInput,
  CatalogProvider,
  ChannelImplementation,
  DiscoveryContext,
  ImplementationDiscoverer,
  SpecGuardPlugin,
} from '../types.js';
import { legacyTraceabilityImporter } from './legacy-traceability.js';

export const PRACTERA_CATALOG_DIR = 'practera-test-suite/catalog';
export const PRACTERA_RESULTS_DIRS = ['.results/cases', 'practera-test-suite/.results/cases'];

/** A drafted summary shaped like `experiences-list — …` is a scenario heading, not a sentence. */
export function headingSummary(summary: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+ — /.test(summary.trim());
}

export const practeraCatalogProvider: CatalogProvider = {
  id: 'practera-catalog',
  defaultDir: PRACTERA_CATALOG_DIR,
  async load(ctx): Promise<CatalogFeatureInput[]> {
    // Catalog files in this layout are bare feature lists; an `agent:` block is ignored.
    return loadCatalogDir(path.resolve(ctx.rootDir, ctx.dir ?? PRACTERA_CATALOG_DIR), parseFeatureList);
  },
};

interface McpToolHit {
  name: string;
  audience: 'admin' | 'learner';
  fields: string[];
}

function walkTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) walkTs(abs, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

function mcpTools(toolsDir: string): McpToolHit[] {
  const hits: McpToolHit[] = [];
  for (const file of walkTs(toolsDir)) {
    const source = readFileSync(file, 'utf8');
    const name = source.match(/server\.tool\(\s*['"]([^'"]+)['"]/)?.[1];
    if (!name) continue;
    const audience = /\/student\/|\/learner\//.test(file) ? 'learner' : 'admin';
    hits.push({ name, audience, fields: graphqlOperations(source).map((op) => op.field) });
  }
  return hits;
}

/**
 * Finds the MCP tool that wraps the same GraphQL field a feature's screen
 * calls. A learner tool is recorded as evidence and does not count as built.
 */
export const practeraMcpDiscoverer: ImplementationDiscoverer = {
  id: 'practera-mcp',
  discover(ctx: DiscoveryContext) {
    const dirs = repoDirMap(ctx);
    const toolsDir = dirs.get('mcp-server');
    const found: Record<string, ChannelImplementation> = {};
    if (!toolsDir) return found;
    const tools = mcpTools(path.join(toolsDir, 'src', 'tools'));
    for (const feature of ctx.features) {
      const fields = new Set<string>();
      for (const mod of uiModules(feature, ctx, dirs)) {
        const ops = graphqlOperations(moduleSources(mod.abs));
        const queries = ops.filter((op) => op.kind === 'query');
        const index = /[.\-_](list|index)$/i.test(feature.id) || /\b(list|index)\b/i.test(feature.title);
        for (const op of index ? queries.slice(0, 1) : ops) fields.add(op.field);
      }
      const matched = tools.filter((tool) => tool.fields.some((field) => fields.has(field)));
      const admin = matched.find((tool) => tool.audience === 'admin');
      const learner = matched.find((tool) => tool.audience === 'learner');
      const impl: ChannelImplementation = {};
      if (admin) impl.mcpAdmin = admin.name;
      else if (learner) impl.mcpLearner = `learner ${learner.name}; no admin tool`;
      if (impl.mcpAdmin || impl.mcpLearner) found[feature.id] = impl;
    }
    return found;
  },
};

export const plugin: SpecGuardPlugin = {
  id: 'practera',
  catalogProviders: [practeraCatalogProvider],
  discoverers: [practeraMcpDiscoverer],
  externalIdAdapters: [zephyrAdapter],
  resultSources: [caseDirSource('practera-results', PRACTERA_RESULTS_DIRS)],
  moduleStems: ['src/pages', 'src/components', 'src/schema'],
  featureState: {
    channelByType: { page: 'ui', ui: 'ui', mutation: 'api', query: 'api', api: 'api', mcp: 'mcp' },
    repoChannels: {
      'admin-app': 'ui',
      app: 'ui',
      'login-app': 'ui',
      'project-hub': 'ui',
      'graphql-api': 'api',
      'login-api': 'api',
      services: 'api',
      mcp: 'mcp',
    },
    // Practera ids are area.entity.action; the area segments say nothing about which sibling owns a test file.
    idTokens: (id) => id.split('.').slice(2).join('-').split(/[^a-z0-9]+/).filter((part) => part.length > 3),
    isPlaceholderSummary: headingSummary,
    mcpModulePattern: /\/mcp\/|\/tools\/|mcp-server/i,
  },
  contractImporters: [legacyTraceabilityImporter],
};

export { plugin as practeraPlugin };
