/**
 * The documentation that ships inside the extension (`media/docs`, copied from `docs/` at build time):
 * the manifest, the help topics, topic resolution and markdown rendering. No VS Code imports, so the
 * dashboards and the tests can use it too.
 */
import * as fs from 'fs';
import * as path from 'path';
import MarkdownIt from 'markdown-it';
import type { HelpTopic } from './dashboard/protocol.js';

export type { HelpTopic };

export interface DocSection { anchor: string; title: string }
export interface DocPage { id: string; title: string; audience: string; group: string; file: string; sections: DocSection[] }
export interface DocManifest { version: number; pages: DocPage[] }
export type HelpTopics = Record<string, HelpTopic>;

/** Where a topic opens: a manifest page file (relative to the docs root) and an optional anchor. */
export interface DocTarget { file: string; anchor?: string }

export const INDEX_FILE = 'index.md';

let docsDir: string | undefined;
let manifestCache: DocManifest | undefined;
let topicsCache: HelpTopics | undefined;

/** Point the loader at the extension's folder; the docs are at `<extension>/media/docs`. */
export function initDocs(extensionPath: string): void {
  docsDir = path.join(extensionPath, 'media', 'docs');
  manifestCache = undefined;
  topicsCache = undefined;
}

export function docsRoot(): string | undefined { return docsDir; }

function readJson<T>(file: string): T | undefined {
  if (!docsDir) return undefined;
  try { return JSON.parse(fs.readFileSync(path.join(docsDir, file), 'utf8')) as T; } catch { return undefined; }
}

export function loadManifest(): DocManifest {
  manifestCache ??= readJson<DocManifest>('manifest.json') ?? { version: 1, pages: [] };
  return manifestCache;
}

export function loadHelpTopics(): HelpTopics {
  topicsCache ??= readJson<HelpTopics>('help-topics.json') ?? {};
  return topicsCache;
}

/** Page markdown by docs-relative file name, or undefined when it is not part of the shipped set. */
export function readPage(file: string, manifest: DocManifest = loadManifest()): string | undefined {
  if (!docsDir) return undefined;
  if (file !== INDEX_FILE && !manifest.pages.some((p) => p.file === file)) return undefined;
  try { return fs.readFileSync(path.join(docsDir, file), 'utf8'); } catch { return undefined; }
}

/**
 * Resolve a topic to a page. A topic is a help key (`workspace.status`), a page with an optional anchor
 * (`guide/contracts.md#steps`), or anything else, which opens the index.
 */
export function resolveTopic(topic: string | undefined, topics: HelpTopics = loadHelpTopics(), manifest: DocManifest = loadManifest()): DocTarget {
  const index: DocTarget = { file: INDEX_FILE };
  if (!topic) return index;
  if (Object.prototype.hasOwnProperty.call(topics, topic)) {
    const t = topics[topic];
    return { file: t.page, anchor: t.anchor || undefined };
  }
  const [file, anchor] = topic.split('#');
  if (file === INDEX_FILE || manifest.pages.some((p) => p.file === file)) return { file, anchor: anchor || undefined };
  return index;
}

export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'page'; file: string; anchor?: string }
  | { kind: 'anchor'; anchor: string }
  | { kind: 'none' };

/** Classify a link in a page: http(s) opens outside, relative .md links navigate in the panel, the rest is inert. */
export function classifyLink(href: string, currentFile: string): LinkTarget {
  if (/^https?:\/\//i.test(href)) return { kind: 'external', url: href };
  if (href.startsWith('#')) return href.length > 1 ? { kind: 'anchor', anchor: href.slice(1) } : { kind: 'none' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return { kind: 'none' };
  const [rel, anchor] = href.split('#');
  if (!/\.md$/i.test(rel)) return { kind: 'none' };
  const file = path.posix.normalize(path.posix.join(path.posix.dirname(currentFile), rel));
  if (file.startsWith('..')) return { kind: 'none' };
  return { kind: 'page', file, anchor: anchor || undefined };
}

const FENCE = /^\s*(```|~~~)/;
const ANCHOR_LINE = /^<a id="([A-Za-z0-9_-]+)"><\/a>\s*$/;
const HEADING = /^#{1,6}\s/;

/**
 * Remove the front matter and the `<a id="slug"></a>` lines that precede headings, returning the markdown
 * and the ids by heading position, so raw HTML never has to be enabled to keep stable anchors.
 */
export function preprocessMarkdown(source: string): { markdown: string; ids: (string | undefined)[] } {
  let text = source.replace(/\r\n/g, '\n');
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4);
    if (end !== -1) text = text.slice(text.indexOf('\n', end + 1) + 1);
  }
  const ids: (string | undefined)[] = [];
  const out: string[] = [];
  let pending: string | undefined;
  let fenced = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    if (!fenced) {
      const a = ANCHOR_LINE.exec(line);
      if (a) { pending = a[1]; continue; }
      if (HEADING.test(line)) { ids.push(pending); pending = undefined; }
    }
    out.push(line);
  }
  return { markdown: out.join('\n'), ids };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}

function makeRenderer(currentFile: string, ids: (string | undefined)[]): InstanceType<typeof MarkdownIt> {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  md.core.ruler.push('specguard_heading_ids', (state) => {
    let n = 0;
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'heading_open') continue;
      const id = ids[n++] ?? slugify(tokens[i + 1]?.content ?? '');
      t.attrSet('id', id);
    }
  });
  const defaultOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const target = classifyLink(String(token.attrGet('href') ?? ''), currentFile);
    token.attrs = [];
    token.attrSet('href', '#');
    if (target.kind === 'external') { token.attrSet('data-kind', 'external'); token.attrSet('data-url', target.url); }
    else if (target.kind === 'page') { token.attrSet('data-kind', 'page'); token.attrSet('data-file', target.file); if (target.anchor) token.attrSet('data-anchor', target.anchor); }
    else if (target.kind === 'anchor') { token.attrSet('data-kind', 'anchor'); token.attrSet('data-anchor', target.anchor); }
    return defaultOpen(tokens, idx, options, env, self);
  };
  return md;
}

/** Render one page to HTML. Raw HTML in the markdown is escaped; links carry `data-kind` for the panel script. */
export function renderMarkdown(source: string, currentFile: string): string {
  const { markdown, ids } = preprocessMarkdown(source);
  return makeRenderer(currentFile, ids).render(markdown);
}

/** Pages grouped for a table of contents: user groups in manifest order, then developer groups. */
export function groupPages(manifest: DocManifest = loadManifest()): { audience: string; group: string; pages: DocPage[] }[] {
  const groups: { audience: string; group: string; pages: DocPage[] }[] = [];
  for (const p of manifest.pages) {
    let g = groups.find((x) => x.audience === p.audience && x.group === p.group);
    if (!g) { g = { audience: p.audience, group: p.group, pages: [] }; groups.push(g); }
    g.pages.push(p);
  }
  return groups.sort((a, b) => (a.audience === b.audience ? 0 : a.audience === 'user' ? -1 : 1));
}
