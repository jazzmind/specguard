/**
 * Guide specs and help topics.
 *
 * A guide is a `kind: journey` spec under `specs/guides/` that documents how to do one thing with the
 * product (a quickstart) or how the product works (concepts, architecture). `docs build` renders each
 * guide to a page; this module reads them, parses the `## Help Topics` sections that back the
 * dashboards' "?" popovers, and checks both against the CLI and the capability list.
 *
 * Everything here is pure: callers pass in the parsed specs and the command tree.
 *
 * Spec: specs/capabilities/documentation-api.md
 */
import fs from 'node:fs';

import { slugify, uniqueSlug } from './slug.js';
import type { SpecNode } from './spec-graph.js';

export type GuideAudience = 'user' | 'dev';
export type GuideGroup = 'start' | 'quickstart' | 'developer';

export interface GuideDoc {
  id: string;
  specKey: string;
  title: string;
  audience: GuideAudience;
  order: number;
  useCase?: string;
  /** Capability ids the guide points to. */
  related: string[];
  group: GuideGroup;
  /** The guide as page content: no frontmatter, no title heading, no Help Topics section. */
  body: string;
  /** The whole spec file, for hashing. */
  source: string;
  /** Spec path relative to the repo, for the page's `source` line. */
  file: string;
}

export interface HelpTopic {
  key: string;
  /** The section heading the topic points to. */
  heading: string;
  text: string;
  /** Id of the spec that defines the topic. */
  spec: string;
  /** `guide` topics point into the guide's page; `capability` topics into the capability's reference page. */
  specKind: 'guide' | 'capability';
}

export interface GuideIssue {
  code: 'guide-unknown-command' | 'guide-unknown-related' | 'help-duplicate-key' | 'help-unknown-anchor';
  message: string;
  spec?: string;
}

/** The part of a commander `Command` the validator reads. */
export interface CommandLike {
  name(): string;
  commands: readonly CommandLike[];
  registeredArguments?: readonly unknown[];
}

export interface CommandNode {
  name: string;
  subs: CommandNode[];
  takesArgs: boolean;
}

export function commandTree(program: CommandLike): CommandNode {
  const walk = (c: CommandLike): CommandNode => ({
    name: c.name(),
    subs: c.commands.map(walk),
    takesArgs: (c.registeredArguments?.length ?? 0) > 0,
  });
  return walk(program);
}

/** Add top-level command names (a plugin's) to a tree. */
export function withCommands(tree: CommandNode, names: Iterable<string>): CommandNode {
  const have = new Set(tree.subs.map((s) => s.name));
  const extra = [...names].filter((n) => !have.has(n)).map((name) => ({ name, subs: [], takesArgs: true }));
  return { ...tree, subs: [...tree.subs, ...extra] };
}

// A provider the CLI registers when it loads, so the check pipeline can validate guide commands without importing the CLI.
let treeProvider: (() => CommandNode) | undefined;
export function registerCommandTree(provider: () => CommandNode): void {
  treeProvider = provider;
}
export function registeredCommandTree(): CommandNode | undefined {
  return treeProvider?.();
}

const FRONT = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const FENCE = /^\s*(```|~~~)/;

/** Lines outside fenced code blocks, with their index. */
function proseLines(markdown: string): Array<{ line: string; index: number }> {
  const out: Array<{ line: string; index: number }> = [];
  let fence: string | undefined;
  markdown.split(/\r?\n/).forEach((line, index) => {
    const m = FENCE.exec(line);
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1] === fence) fence = undefined;
      return;
    }
    if (!fence) out.push({ line, index });
  });
  return out;
}

export interface Heading {
  level: number;
  title: string;
}

/** Markdown headings (levels 1-4) outside code fences. */
export function headingsOf(markdown: string): Heading[] {
  const out: Heading[] = [];
  for (const { line } of proseLines(markdown)) {
    const m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, title: m[2].trim() });
  }
  return out;
}

/** Remove one `## <name>` section (to the next H2 or the end), leaving the rest as it was. */
export function stripSection(markdown: string, name: string): string {
  const lines = markdown.split(/\r?\n/);
  const prose = new Set(proseLines(markdown).map((p) => p.index));
  const target = name.trim().toLowerCase();
  const out: string[] = [];
  let skipping = false;
  lines.forEach((line, i) => {
    const h2 = prose.has(i) ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (h2) skipping = h2[1].trim().toLowerCase() === target;
    if (!skipping) out.push(line);
  });
  return out.join('\n');
}

/** The body of the `## <name>` section outside code fences, or ''. */
export function sectionBody(markdown: string, name: string): string {
  const lines = markdown.split(/\r?\n/);
  const prose = new Set(proseLines(markdown).map((p) => p.index));
  const target = name.trim().toLowerCase();
  const out: string[] = [];
  let inside = false;
  lines.forEach((line, i) => {
    const h2 = prose.has(i) ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (h2) {
      inside = h2[1].trim().toLowerCase() === target;
      return;
    }
    if (inside) out.push(line);
  });
  return out.join('\n').trim();
}

const HELP_LINE = /^[-*]\s+`([A-Za-z0-9_.-]+)`\s*(?:→|->)\s*(.+?):\s+(.+?)\s*$/;

/** The topics of a `## Help Topics` section: ``- `key.name` → Section Heading: one-line popover text``. */
export function parseHelpTopics(markdown: string, spec: string, specKind: HelpTopic['specKind']): HelpTopic[] {
  const out: HelpTopic[] = [];
  for (const line of sectionBody(markdown, 'Help Topics').split(/\r?\n/)) {
    const m = HELP_LINE.exec(line.trim());
    if (m) out.push({ key: m[1], heading: m[2].trim(), text: m[3], spec, specKind });
  }
  return out;
}

function stripFrontmatter(text: string): string {
  return text.replace(FRONT, '');
}

function stripTitle(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim() !== '');
  if (i >= 0 && /^#\s+/.test(lines[i])) lines.splice(i, 1);
  return lines.join('\n');
}

function readSpecFile(node: SpecNode): string {
  try {
    return fs.readFileSync(node.spec.filePath, 'utf8');
  } catch {
    return '';
  }
}

const listValue = (raw: string | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* a plain comma list */
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
};

/** A spec is a guide when it is a journey under `specs/guides/`. */
export function isGuide(node: SpecNode): boolean {
  return node.kind === 'journey' && node.specKey.startsWith('guides/');
}

export function parseGuide(node: SpecNode, repoRoot: string): GuideDoc {
  const extra = node.spec.meta.extra;
  const source = readSpecFile(node);
  const body = stripSection(stripTitle(stripFrontmatter(source)), 'Help Topics').trim();
  const audience: GuideAudience = extra.audience === 'dev' ? 'dev' : 'user';
  const useCase = extra.useCase?.trim() || undefined;
  const declared = extra.group as GuideGroup | undefined;
  const group: GuideGroup = declared === 'start' || declared === 'quickstart' || declared === 'developer' ? declared : audience === 'dev' ? 'developer' : useCase ? 'quickstart' : 'start';
  const order = Number.parseInt(extra.order ?? '', 10);
  const file = node.spec.filePath.startsWith(repoRoot) ? node.spec.filePath.slice(repoRoot.length).replace(/^[\\/]+/, '').split('\\').join('/') : node.specKey;
  return {
    id: node.id,
    specKey: node.specKey,
    title: node.spec.title || extra.title || node.id,
    audience,
    order: Number.isFinite(order) ? order : 999,
    ...(useCase ? { useCase } : {}),
    related: listValue(extra.related),
    group,
    body,
    source,
    file,
  };
}

export function parseGuides(nodes: Iterable<SpecNode>, repoRoot: string): GuideDoc[] {
  return [...nodes].filter(isGuide).map((n) => parseGuide(n, repoRoot)).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Every help topic the specs define: guides and capability specs. */
export function collectHelpTopics(nodes: Iterable<SpecNode>): HelpTopic[] {
  const out: HelpTopic[] = [];
  for (const node of nodes) {
    if (node.kind !== 'journey' && node.kind !== 'capability') continue;
    if (node.kind === 'journey' && !isGuide(node)) continue;
    out.push(...parseHelpTopics(readSpecFile(node), node.id, node.kind === 'journey' ? 'guide' : 'capability'));
  }
  return out;
}

/** Headings every user reference page has, in the order the fallback renders them. A capability's help topic points at one of these. */
export const REFERENCE_HEADINGS = ['Why it exists', 'What you can do', 'What to expect'] as const;

const SHELL_LANGS = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal']);

/** `specguard ...` command lines inside shell code fences, as token lists after the program name. */
export function commandLines(markdown: string): string[][] {
  const out: string[][] = [];
  let fence: string | undefined;
  let lang = '';
  for (const line of markdown.split(/\r?\n/)) {
    const m = FENCE.exec(line);
    if (m) {
      if (!fence) {
        fence = m[1];
        lang = line.trim().slice(3).trim().toLowerCase();
      } else if (m[1] === fence) fence = undefined;
      continue;
    }
    if (!fence || !SHELL_LANGS.has(lang)) continue;
    const text = line.trim().replace(/^\$\s+/, '').replace(/^#.*$/, '');
    const tokens = text.split(/\s+/).filter(Boolean);
    // `npx -y -p specguard-ai specguard ...` and plain `specguard ...`.
    const at = tokens.indexOf('specguard');
    if (at < 0 || (at > 0 && tokens[0] !== 'npx')) continue;
    out.push(tokens.slice(at + 1));
  }
  return out;
}

/** The first token that is not a command, when the line names one that the tree lacks. */
export function unknownCommand(tokens: string[], tree: CommandNode): string | undefined {
  let node = tree;
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '--config') {
      i += 1;
      continue;
    }
    if (t.startsWith('-')) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(t)) return undefined;
    const sub = node.subs.find((s) => s.name === t);
    if (sub) {
      node = sub;
      depth += 1;
      continue;
    }
    if (depth === 0 || (node.subs.length > 0 && !node.takesArgs)) return [...tokens.slice(0, i + 1)].join(' ');
    return undefined;
  }
  return undefined;
}

export interface GuideValidationInput {
  guides: GuideDoc[];
  /** Ids of the capability specs. */
  capabilityIds: ReadonlySet<string>;
  topics: HelpTopic[];
  /** Absent when the CLI is not loaded (MCP, tests): command checks are skipped. */
  commands?: CommandNode;
}

export function validateGuides(input: GuideValidationInput): GuideIssue[] {
  const issues: GuideIssue[] = [];
  const { guides, capabilityIds, topics, commands } = input;
  for (const g of guides) {
    for (const id of g.related) {
      if (!capabilityIds.has(id)) issues.push({ code: 'guide-unknown-related', spec: g.id, message: `${g.id}: related "${id}" is not a capability id` });
    }
    if (commands) {
      const seen = new Set<string>();
      for (const tokens of commandLines(g.body)) {
        const bad = unknownCommand(tokens, commands);
        if (bad && !seen.has(bad)) {
          seen.add(bad);
          issues.push({ code: 'guide-unknown-command', spec: g.id, message: `${g.id}: \`specguard ${bad}\` is not a command` });
        }
      }
    }
  }
  const byKey = new Map<string, HelpTopic>();
  const guideById = new Map(guides.map((g) => [g.id, g]));
  for (const t of topics) {
    const prior = byKey.get(t.key);
    if (prior) {
      issues.push({ code: 'help-duplicate-key', spec: t.spec, message: `help topic "${t.key}" is defined in both ${prior.spec} and ${t.spec}` });
      continue;
    }
    byKey.set(t.key, t);
    const want = slugify(t.heading, 60, 'section');
    const allowed =
      t.specKind === 'guide'
        ? headingsOf(guideById.get(t.spec)?.body ?? '').map((h) => slugify(h.title, 60, 'section'))
        : REFERENCE_HEADINGS.map((h) => slugify(h, 60, 'section'));
    if (!allowed.includes(want)) {
      issues.push({ code: 'help-unknown-anchor', spec: t.spec, message: `help topic "${t.key}" in ${t.spec} points to "${t.heading}", which is not a section of its page${t.specKind === 'capability' ? ` (use one of: ${REFERENCE_HEADINGS.join(', ')})` : ''}` });
    }
  }
  return issues;
}

/**
 * Add `<a id="slug"></a>` on the line before every heading outside code fences, and list the H2/H3 sections.
 * Existing anchor lines are dropped first, so running it twice changes nothing. Slugs are unique within the page.
 */
export function anchorize(markdown: string): { markdown: string; sections: Array<{ anchor: string; title: string; level: number }>; anchors: Map<string, string> } {
  const cleaned = markdown.split(/\r?\n/).filter((l) => !/^<a id="[^"]*"><\/a>\s*$/.test(l));
  const prose = new Set(proseLines(cleaned.join('\n')).map((p) => p.index));
  const taken = new Set<string>();
  const sections: Array<{ anchor: string; title: string; level: number }> = [];
  const anchors = new Map<string, string>();
  const out: string[] = [];
  cleaned.forEach((line, i) => {
    const m = prose.has(i) ? /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (m) {
      const title = m[2].trim();
      const anchor = uniqueSlug(title, taken);
      out.push(`<a id="${anchor}"></a>`);
      if (m[1].length >= 2 && m[1].length <= 3) sections.push({ anchor, title, level: m[1].length });
      if (!anchors.has(slugify(title, 60, 'section'))) anchors.set(slugify(title, 60, 'section'), anchor);
      if (m[1].length === 1 && !anchors.has('')) anchors.set('', anchor);
    }
    out.push(line);
  });
  return { markdown: out.join('\n'), sections, anchors };
}
