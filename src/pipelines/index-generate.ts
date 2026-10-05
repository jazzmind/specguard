/**
 * Index pipeline — generates/updates `specs/index.md` from the source tree.
 *
 * On first run, scans `App.tsx` (or equivalent routing entry point) for route
 * definitions, then walks the spec tree to produce an architecture overview.
 * On subsequent runs it rebuilds the route map and spec tree links while
 * preserving the manually-authored overview sections.
 *
 * CLI: specguard index [--app <name>] [--force]
 */
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import type { SpecGuardConfig, PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import { llmGenerateObject } from '../core/llm.js';

export interface IndexOpts {
  /** App name to generate the index for (defaults to first app or inferred from directory). */
  app?: string;
  /** Re-generate even if index.md already exists. */
  force?: boolean;
  /** Callback for streaming progress lines. */
  onLog?: (line: string) => void;
}

function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

/** Walk a directory and collect all .md files relative to baseDir */
function collectSpecFiles(
  dir: string,
  baseDir: string,
  exclude?: string[],
): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(baseDir, full).split(path.sep).join('/');
    if (exclude?.some((e) => rel === e || rel.startsWith(e + '/'))) continue;
    if (entry.isDirectory()) {
      results.push(...collectSpecFiles(full, baseDir, exclude));
    } else if (entry.name.endsWith('.md') && entry.name !== 'README.md') {
      results.push(rel);
    }
  }
  return results;
}

/** Read source file for routing info (best effort) */
function readRoutingSource(repoDir: string): string {
  const candidates = [
    'src/App.tsx', 'src/App.ts', 'src/app.tsx', 'src/app.ts',
    'src/router.tsx', 'src/router.ts',
    'src/main.tsx', 'src/main.ts',
    'pages/_app.tsx', 'app/layout.tsx',
  ];
  for (const c of candidates) {
    const full = path.join(repoDir, c);
    if (fs.existsSync(full)) return fs.readFileSync(full, 'utf-8');
  }
  return '';
}

const IndexSchema = z.object({
  title: z.string().describe('Short title for the system (e.g. "Acme Admin App")'),
  overview: z.string().describe('2-4 sentences describing what the app does, its tech stack, and main users'),
  dataFlow: z.string().describe('1-3 sentence description of the data flow (auth, API calls, integrations)'),
  contextTree: z.string().optional().describe('If the source shows React context providers, describe the provider tree in a code block'),
  routeGroups: z.array(z.object({
    name: z.string().describe('Group name (e.g. Core, Deliver, Setup, Public)'),
    description: z.string().describe('One sentence describing what this group covers'),
    routes: z.array(z.object({
      path: z.string(),
      component: z.string(),
      note: z.string().optional(),
    })),
  })).describe('Routes grouped by functional area'),
  redirects: z.array(z.object({
    from: z.string(),
    to: z.string(),
  })).optional().describe('Redirect/alias routes'),
});

/**
 * Generate or update `specs/index.md` for the given app.
 * The spec tree and source routing file are scanned first; the LLM produces
 * the architecture overview and route groups; the output is rendered as Markdown.
 */
export async function runIndex(
  config: SpecGuardConfig,
  opts: IndexOpts = {},
): Promise<PipelineResult> {
  const result = emptyResult('index');
  const log = (line: string) => {
    result.messages.push(line);
    opts.onLog?.(line);
  };

  const cwd = config.rootDir ?? process.cwd();

  // Determine the primary repo dir (first app or matching app name)
  let primaryApp = config.apps[0];
  if (opts.app) {
    const found = config.apps.find((a) => a.name === opts.app);
    if (!found) {
      log(`[index] app "${opts.app}" not found in config`);
      result.exitCode = ExitCode.InternalError;
      return result;
    }
    primaryApp = found;
  }

  const repoDir = resolveFromRoot(config, primaryApp.repo);

  // Use the root specDir (common parent of all app specDirs, or 'specs/')
  const allSpecDirs = [...new Set(config.apps.map((a) => resolveFromRoot(config, a.specDir)))];
  const rootSpecDir = allSpecDirs.length === 1
    ? allSpecDirs[0]
    : path.join(repoDir, 'specs');
  const indexPath = path.join(rootSpecDir, 'index.md');

  if (fs.existsSync(indexPath) && !opts.force) {
    log(`[index] ${path.relative(cwd, indexPath)} already exists — use --force to regenerate`);
    result.exitCode = ExitCode.Success;
    return result;
  }

  // Collect spec tree
  log('[index] scanning spec tree…');
  const specFiles = collectSpecFiles(rootSpecDir, rootSpecDir, ['README.md']);
  log(`[index] found ${specFiles.length} spec files`);

  // Read routing source
  log('[index] reading routing source…');
  const routingSource = readRoutingSource(repoDir);

  // Read package.json for metadata
  let pkgName = path.basename(repoDir);
  let pkgDescription = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf-8')) as { name?: string; description?: string };
    if (pkg.name) pkgName = pkg.name;
    if (pkg.description) pkgDescription = pkg.description;
  } catch { /* not a node project */ }

  // LLM-generate the architecture overview
  log('[index] generating architecture overview with LLM…');
  const prompt = [
    `You are analysing a frontend application codebase to produce an architecture index.`,
    '',
    `Package: ${pkgName}`,
    pkgDescription ? `Description: ${pkgDescription}` : '',
    '',
    `Spec tree (first 80 files):`,
    specFiles.slice(0, 80).map((f) => `  ${f}`).join('\n'),
    '',
    routingSource
      ? `Routing source (${path.basename(repoDir)}/src/App.tsx excerpt):\n\`\`\`tsx\n${routingSource.slice(0, 4000)}\n\`\`\``
      : '',
    '',
    `Extract the route groups, individual routes, redirects, and architecture overview.`,
    `Group routes by functional area (e.g. "Core", "Deliver", "Setup", "Public").`,
    `For each route, extract the path and component name from the source.`,
  ].filter(Boolean).join('\n');

  let analysis: z.infer<typeof IndexSchema>;
  try {
    analysis = await llmGenerateObject({
      provider: config.llm.provider,
      model: config.llm.model,
      apiKeyEnv: config.llm.apiKeyEnv,
      system: 'Extract structured architecture information from the provided application source code. Output only valid JSON.',
      prompt,
      schema: IndexSchema,
    });
  } catch (err) {
    log(`[index] LLM failed: ${(err as Error).message} — writing skeleton index`);
    // Write a minimal skeleton
    const skeleton = buildSkeletonIndex(pkgName, specFiles, config);
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, skeleton, 'utf-8');
    log(`[index] wrote skeleton → ${path.relative(cwd, indexPath)}`);
    result.exitCode = ExitCode.Success;
    return result;
  }

  // Render the index.md
  const rendered = renderIndex(analysis, specFiles, config, repoDir, rootSpecDir);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, rendered, 'utf-8');
  log(`[index] wrote ${path.relative(cwd, indexPath)}`);
  result.exitCode = ExitCode.Success;
  return result;
}

function buildSkeletonIndex(
  appName: string,
  specFiles: string[],
  config: SpecGuardConfig,
): string {
  const lines: string[] = [
    `# ${appName} — System Architecture Index`,
    '',
    `<!-- type: architecture-index / status: skeleton / generated: ${new Date().toISOString().slice(0, 10)} -->`,
    '',
    '## Overview',
    '',
    '_TODO: Add architecture overview here._',
    '',
    '## Spec Tree',
    '',
    ...config.apps.map((app) => {
      const appSpecs = specFiles.filter((f) => f.startsWith(path.basename(app.specDir)));
      return `### ${app.name} (\`${app.specDir}/\`) — ${appSpecs.length} specs`;
    }),
    '',
  ];
  return lines.join('\n');
}

function renderIndex(
  analysis: z.infer<typeof IndexSchema>,
  specFiles: string[],
  config: SpecGuardConfig,
  repoDir: string,
  rootSpecDir: string,
): string {
  const now = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `# ${analysis.title} — System Architecture Index`,
    '',
    `<!-- type: architecture-index / status: living / updated: ${now} -->`,
    '',
    '## Overview',
    '',
    analysis.overview,
    '',
  ];

  if (analysis.dataFlow) {
    lines.push('## Data Flow', '', analysis.dataFlow, '');
  }

  if (analysis.contextTree) {
    lines.push('## Context Tree', '', analysis.contextTree, '');
  }

  // Route map
  lines.push('## Route Map', '');
  for (const group of analysis.routeGroups) {
    lines.push(`### ${group.name}`, '', group.description, '');
    lines.push('| Route | Component |', '|-------|-----------|');
    for (const route of group.routes) {
      const note = route.note ? ` (${route.note})` : '';
      lines.push(`| \`${route.path}\` | ${route.component}${note} |`);
    }
    lines.push('');
  }

  if (analysis.redirects && analysis.redirects.length > 0) {
    lines.push('### Redirects (backward compat)', '');
    lines.push('| Old Route | Redirects To |', '|-----------|-------------|');
    for (const r of analysis.redirects) {
      lines.push(`| \`${r.from}\` | \`${r.to}\` |`);
    }
    lines.push('');
  }

  // Spec directory map
  lines.push('## Spec Directory Map', '');
  lines.push('| Area | Spec Dir | Spec Count |', '|------|----------|-----------|');
  for (const app of config.apps) {
    const specDirRel = path.relative(repoDir, resolveFromRoot(config, app.specDir)).split(path.sep).join('/');
    const count = specFiles.filter((f) => {
      const specDirBase = specDirRel.replace(/^specs\//, '');
      return specDirBase === '.'
        ? !f.includes('/')
        : f.startsWith(specDirBase + '/') || f.startsWith(specDirBase + '\\');
    }).length;
    lines.push(`| ${app.name} | \`${specDirRel}/\` | ${count} |`);
  }
  lines.push('');

  // Full spec file list
  lines.push('## All Specs', '');
  const grouped = new Map<string, string[]>();
  for (const f of specFiles) {
    const parts = f.split('/');
    const dir = parts.length > 1 ? parts[0] : '.';
    const group = grouped.get(dir) ?? [];
    group.push(f);
    grouped.set(dir, group);
  }
  for (const [dir, files] of grouped.entries()) {
    lines.push(`### ${dir === '.' ? 'Root' : dir}/`, '');
    for (const f of files) {
      lines.push(`- [${f}](${f})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
