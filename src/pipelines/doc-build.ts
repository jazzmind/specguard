/**
 * Documentation set build: `specguard docs build`.
 *
 * Builds the product's documentation from its own specs: guide specs (`specs/guides/`) become the
 * user and developer guides, each capability becomes a reference page for both audiences, and an
 * index, a manifest and the dashboards' help topics are derived from them. Guides, the index, the
 * manifest and the help topics are rendered deterministically. A capability's reference page is
 * written by the model through `DocService` and kept: it is regenerated only when its spec changes,
 * which the committed manifest records as `sourceHash`, so CI and other machines need no cache.
 * With `noLlm` (or no model) the page is rendered straight from the spec instead.
 *
 * Spec: specs/capabilities/documentation-api.md
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode } from '../core/exit-codes.js';
import {
  anchorize,
  collectHelpTopics,
  parseGuides,
  validateGuides,
  withCommands,
  type CommandNode,
  type GuideDoc,
  type HelpTopic,
} from '../core/guides.js';
import { slugify } from '../core/slug.js';
import { buildSpecGraph, type SpecNode } from '../core/spec-graph.js';
import { emptyResult, type PipelineResult, type SpecGuardConfig } from '../core/types.js';
import { removeFile, writeFile } from '../core/writer.js';
import { BUILTIN_PLUGINS } from '../plugins/catalog.js';
import { loadPlugins } from '../plugins/index.js';
import { DocService, renderFallback, type Audience } from '../server/docs.js';

/** Bump when the page layout changes, so every page is rebuilt. */
export const DOC_FORMAT = 'f1';
export const DEFAULT_DOCS_DIR = 'docs';

export type PageGroup = 'Start here' | 'Quickstarts' | 'Reference' | 'Developer';
const GROUP_ORDER: PageGroup[] = ['Start here', 'Quickstarts', 'Reference', 'Developer'];

export interface ManifestPage {
  id: string;
  title: string;
  audience: 'user' | 'dev';
  group: PageGroup;
  /** Path relative to the docs directory. */
  file: string;
  sections: Array<{ anchor: string; title: string }>;
  sourceHash: string;
  /** `llm` for a page the model wrote, `deterministic` for one rendered directly from the spec. */
  generator: 'llm' | 'deterministic';
}

export interface DocManifest {
  version: 1;
  pages: ManifestPage[];
}

export interface HelpTopicEntry {
  title: string;
  text: string;
  page: string;
  anchor: string;
}

export interface DocBuildOpts {
  /** Render capability pages without a model. */
  noLlm?: boolean;
  /** Compare only: report pages that are out of date, write nothing, call no model. */
  check?: boolean;
  /** Output directory (default `docs`, under the repo root). */
  out?: string;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const stable = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

function readIf(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function readManifest(file: string): DocManifest | undefined {
  const raw = readIf(file);
  if (!raw) return undefined;
  try {
    const m = JSON.parse(raw) as DocManifest;
    return Array.isArray(m.pages) ? m : undefined;
  } catch {
    return undefined;
  }
}

const yamlStr = (s: string): string => JSON.stringify(s);

function frontmatter(title: string, audience: string, source: string, extra: Record<string, string | number> = {}): string {
  const lines = ['---', `title: ${yamlStr(title)}`, `audience: ${audience}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${typeof v === 'number' ? v : yamlStr(v)}`), `source: ${yamlStr(source)}`, 'generated: true', '---', ''];
  return lines.join('\n');
}

/** Drop a leading frontmatter block and a code fence wrapped around the whole document, as models sometimes add them. */
function cleanModelPage(markdown: string, title: string): string {
  let text = markdown.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  if (!/^#\s+/.test(text)) text = `# ${title}\n\n${text}`;
  return text;
}

function guidePage(g: GuideDoc, capTitles: Map<string, string>, rel: (from: string, to: string) => string, file: string): string {
  const parts = [`# ${g.title}`];
  if (g.useCase) parts.push(`> ${g.useCase}`);
  parts.push(g.body);
  const links = g.related.filter((id) => capTitles.has(id)).map((id) => `- [${capTitles.get(id)}](${rel(file, `${g.audience === 'dev' ? 'dev' : 'guide'}/reference/${id}.md`)})`);
  if (links.length > 0) parts.push(`## Reference pages\n\n${links.join('\n')}`);
  return parts.join('\n\n');
}

interface PlannedPage {
  entry: Omit<ManifestPage, 'sections' | 'generator'> & { generator?: ManifestPage['generator'] };
  /** The full page text, once known. */
  text?: string;
  /** Reference pages: the spec node and audience to render. */
  node?: SpecNode;
  stale?: string;
}

function planPages(root: string, nodes: Iterable<SpecNode>) {
  const all = [...nodes];
  const guides = parseGuides(all, root);
  const capabilities = all.filter((n) => n.kind === 'capability').sort((a, b) => a.id.localeCompare(b.id));
  const capTitles = new Map(capabilities.map((c) => [c.id, c.spec.title || c.id]));
  const rel = (from: string, to: string): string => {
    const r = path.posix.relative(path.posix.dirname(from), to);
    return r.startsWith('.') ? r : `./${r}`;
  };

  const planned: PlannedPage[] = [];
  const orders = new Map<string, number>();
  for (const g of guides) {
    const file = `${g.audience === 'dev' ? 'dev' : 'guide'}/${g.id}.md`;
    orders.set(file, g.order);
    planned.push({
      entry: { id: g.id, title: g.title, audience: g.audience, group: g.group === 'start' ? 'Start here' : g.group === 'quickstart' ? 'Quickstarts' : 'Developer', file, sourceHash: sha(`${g.source}|${DOC_FORMAT}`), generator: 'deterministic' },
      text: `${frontmatter(g.title, g.audience, g.file, { order: g.order })}${anchorize(guidePage(g, capTitles, rel, file)).markdown}\n`,
    });
  }
  for (const node of capabilities) {
    const source = readIf(node.spec.filePath) ?? JSON.stringify(node.spec.sections);
    for (const audience of ['user', 'dev'] as const) {
      const title = node.spec.title || node.id;
      planned.push({
        entry: {
          id: node.id,
          title: audience === 'dev' ? `${title} (developer reference)` : title,
          audience,
          group: audience === 'dev' ? 'Developer' : 'Reference',
          file: `${audience === 'dev' ? 'dev' : 'guide'}/reference/${node.id}.md`,
          sourceHash: sha(`${source}|${audience}|${DOC_FORMAT}`),
        },
        node,
      });
    }
  }
  return { guides, capabilities, planned, orders, capTitles };
}

export async function runDocBuild(config: SpecGuardConfig, opts: DocBuildOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('docs-build');
  const root = config.rootDir ?? process.cwd();
  const outDir = path.resolve(root, opts.out ?? DEFAULT_DOCS_DIR);
  const manifestPath = path.join(outDir, 'manifest.json');
  const prior = readManifest(manifestPath);
  const priorByFile = new Map((prior?.pages ?? []).map((p) => [p.file, p]));

  const graph = await buildSpecGraph(config);
  const { guides, planned, orders } = planPages(root, graph.nodes.values());

  // Capability pages: keep the committed page while its spec is unchanged; render the others.
  const service = !opts.noLlm && !opts.check && config.llm.provider !== 'none' ? new DocService(config) : undefined;
  const warnings: string[] = [];
  for (const p of planned) {
    if (!p.node) continue;
    const existing = priorByFile.get(p.entry.file);
    const onDisk = readIf(path.join(outDir, p.entry.file));
    const fresh = existing !== undefined && existing.sourceHash === p.entry.sourceHash && onDisk !== undefined;
    if (opts.check) {
      p.text = onDisk ?? '';
      p.entry.generator = existing?.generator ?? 'deterministic';
      if (!fresh) p.stale = onDisk === undefined ? 'missing' : existing ? 'its spec changed' : 'not in the manifest';
      continue;
    }
    // Fresh pages stay, unless a model is available and the page was only rendered from the spec.
    if (fresh && (existing.generator === 'llm' || !service)) {
      p.text = onDisk;
      p.entry.generator = existing.generator;
      continue;
    }
    const audience: Audience = p.entry.audience;
    let markdown: string;
    let generator: ManifestPage['generator'] = 'deterministic';
    if (service) {
      const doc = await service.get(audience, p.node.id);
      markdown = doc.markdown;
      if (doc.generated) generator = 'llm';
      if (doc.warning) warnings.push(`${p.entry.file}: ${doc.warning}`);
    } else {
      markdown = renderFallback(audience, p.node);
    }
    const title = p.node.spec.title || p.node.id;
    const body = anchorize(cleanModelPage(markdown, audience === 'dev' ? `${title} (developer reference)` : title)).markdown;
    p.text = `${frontmatter(p.entry.title, audience, path.relative(root, p.node.spec.filePath).split(path.sep).join('/'))}${body}\n`;
    p.entry.generator = generator;
  }

  const tops = new Map<string, string>();
  const pages: ManifestPage[] = planned
    .map((p) => {
      const a = anchorize((p.text ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''));
      tops.set(p.entry.file, a.anchors.get('') ?? '');
      return { ...p.entry, generator: p.entry.generator ?? 'deterministic', sections: a.sections.map(({ anchor, title }) => ({ anchor, title })) } satisfies ManifestPage;
    })
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || (orders.get(a.file) ?? 1000) - (orders.get(b.file) ?? 1000) || a.file.localeCompare(b.file));

  const topics = helpTopics(collectHelpTopics(graph.nodes.values()), pages, guides, tops, warnings);
  const outputs = new Map<string, string>();
  for (const p of planned) outputs.set(p.entry.file, p.text ?? '');
  outputs.set('index.md', renderIndex(pages));
  outputs.set('help-topics.json', stable(topics));
  outputs.set('manifest.json', stable({ version: 1, pages } satisfies DocManifest));

  for (const w of warnings) result.messages.push(`  [warn] ${w}`);

  if (opts.check) {
    const stale: string[] = [];
    for (const p of planned) if (p.stale) stale.push(`${p.entry.file} (${p.stale})`);
    for (const [file, text] of outputs) {
      if (planned.some((p) => p.entry.file === file && p.node)) continue;
      const have = readIf(path.join(outDir, file));
      const entry = planned.find((p) => p.entry.file === file)?.entry;
      const recorded = priorByFile.get(file)?.sourceHash;
      if (have === undefined) stale.push(`${file} (missing)`);
      else if (have !== text) stale.push(`${file} (${entry && recorded !== undefined && recorded !== entry.sourceHash ? 'its spec changed' : 'differs from what the specs render'})`);
      else if (entry && recorded !== entry.sourceHash) stale.push(`${file} (its spec changed)`);
    }
    for (const s of stale) result.messages.push(`  [stale] ${s}`);
    result.items = [...outputs.keys()].map((key) => ({ key, status: stale.some((s) => s.startsWith(`${key} `)) ? 'failed' : 'ok' }));
    result.created = outputs.size - stale.length;
    result.failed = stale.length;
    if (stale.length > 0) {
      result.exitCode = ExitCode.DriftDetected;
      result.messages.push(`docs: ${stale.length} stale page(s); run \`specguard docs build\` and commit the result`);
    } else {
      result.messages.push(`docs: ${outputs.size} files are up to date`);
    }
    return result;
  }

  let written = 0;
  for (const [file, text] of outputs) {
    const target = path.join(outDir, file);
    if (readIf(target) === text) {
      result.skipped += 1;
      continue;
    }
    await writeFile(target, text);
    written += 1;
  }
  // Pages a previous build wrote and this one no longer plans are removed.
  for (const old of prior?.pages ?? []) {
    if (!outputs.has(old.file)) await removeFile(path.join(outDir, old.file));
  }
  result.created = written;
  result.items = [...outputs.keys()].map((key) => ({ key, status: 'ok' as const }));
  const llm = pages.filter((p) => p.generator === 'llm').length;
  result.messages.push(`docs: ${outputs.size} files (${pages.length} pages, ${llm} written by a model, ${Object.keys(topics).length} help topics) under ${path.relative(root, outDir) || '.'}; ${written} changed`);
  return result;
}

export function renderIndex(pages: ManifestPage[]): string {
  const lines = ['---', 'title: "SpecGuard documentation"', 'generated: true', '---', '', '<a id="specguard-documentation"></a>', '# SpecGuard documentation', '', 'Generated from the specs by `specguard docs build`. Edit the specs under `specs/`, not these pages.', ''];
  for (const group of GROUP_ORDER) {
    const inGroup = pages.filter((p) => p.group === group);
    if (inGroup.length === 0) continue;
    lines.push(`<a id="${group.toLowerCase().replace(/[^a-z]+/g, '-')}"></a>`, `## ${group}`, '');
    for (const p of inGroup) lines.push(`- [${p.title}](${p.file})`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Resolve each topic to a page and anchor: the section when the page has it, else the top of the page. */
function helpTopics(topics: HelpTopic[], pages: ManifestPage[], guides: GuideDoc[], tops: Map<string, string>, warnings: string[]): Record<string, HelpTopicEntry> {
  const out: Record<string, HelpTopicEntry> = {};
  const guideIds = new Set(guides.map((g) => g.id));
  for (const t of [...topics].sort((a, b) => a.key.localeCompare(b.key))) {
    if (out[t.key]) continue;
    const page = t.specKind === 'guide' && guideIds.has(t.spec)
      ? pages.find((p) => p.id === t.spec && p.file.split('/').length === 2)
      : pages.find((p) => p.id === t.spec && p.audience === 'user' && p.file.includes('/reference/'));
    if (!page) continue;
    const wanted = slugify(t.heading, 60, 'section');
    const match = page.sections.find((s) => s.anchor === wanted) ?? page.sections.find((s) => s.title.toLowerCase() === t.heading.toLowerCase());
    if (!match) warnings.push(`help topic ${t.key}: "${t.heading}" is not a section of ${page.file}; pointing at the top of the page`);
    out[t.key] = { title: t.heading, text: t.text, page: page.file, anchor: match?.anchor ?? tops.get(page.file) ?? '' };
  }
  return out;
}

/** `check` lines about the documentation set: guide problems and pages older than their specs. Cheap: no rendering, no model. */
export async function docsCheckLines(config: SpecGuardConfig, commands?: CommandNode): Promise<string[]> {
  const root = config.rootDir ?? process.cwd();
  const graph = await buildSpecGraph(config);
  const { guides, capabilities, planned } = planPages(root, graph.nodes.values());
  const lines: string[] = [];
  if (guides.length > 0) {
    let tree = commands;
    if (tree) {
      try {
        const plugins = await loadPlugins(BUILTIN_PLUGINS.map((p) => p.id), root);
        tree = withCommands(tree, plugins.flatMap((p) => p.commands ?? []).map((c) => c.name));
      } catch {
        /* built-in plugins that cannot load only narrow the known commands */
      }
    }
    const issues = validateGuides({ guides, capabilityIds: new Set(capabilities.map((c) => c.id)), topics: collectHelpTopics(graph.nodes.values()), ...(tree ? { commands: tree } : {}) });
    for (const i of issues) lines.push(`  [warn] ${i.code}: ${i.message}`);
  }
  const manifest = readManifest(path.join(root, DEFAULT_DOCS_DIR, 'manifest.json'));
  if (manifest) {
    const have = new Map(manifest.pages.map((p) => [p.file, p.sourceHash]));
    const stale = planned.filter((p) => have.get(p.entry.file) !== p.entry.sourceHash).map((p) => p.entry.file);
    if (stale.length > 0) lines.push(`  [warn] docs-stale: ${stale.length} documentation page(s) are older than their specs (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ', ...' : ''}); run \`specguard docs build\``);
  }
  return lines;
}
