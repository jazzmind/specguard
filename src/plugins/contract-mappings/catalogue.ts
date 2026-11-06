/**
 * The catalogue of provider specs a consumer spec may depend on, and the deterministic spec-text matcher.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadAllSpecs } from '../../core/spec-parser.js';
import type { WorkspaceRepoWithConfig } from '../../core/workspace.js';
import type { Suggestion } from './merge.js';

export interface CatalogueSpec {
  repo: string;
  /** Repo-relative POSIX path. */
  relPath: string;
  abs: string;
  /** Path relative to the spec directory, without `.md` (`capabilities/orders`). */
  key: string;
  id: string | undefined;
  title: string;
  /** Spec kind from frontmatter (`system`, `capability`, ...), when given. */
  kind?: string;
  /** First sentence of Problem & Value, else the first paragraph. */
  summary: string;
}

export interface ConsumerSpec extends CatalogueSpec {
  /** Spec text without frontmatter. */
  text: string;
}

export const specDirOf = (repo: WorkspaceRepoWithConfig): string => path.resolve(repo.absPath, repo.specGuardConfig?.apps[0]?.specDir ?? 'specs');

export const stripFrontmatter = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

/** First sentence of the Problem & Value section, else the first paragraph after the title. */
export function summaryOf(text: string): string {
  const body = stripFrontmatter(text);
  const section = body.match(/^##\s+Problem\s*(?:&|and)\s*Value\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im)?.[1];
  const paragraph = (section ?? body.replace(/^#\s.*$/m, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^##.*$/gm, ''))
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p !== '');
  if (!paragraph) return '';
  const flat = paragraph.replace(/\s+/g, ' ');
  return (flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat).slice(0, 240);
}

/** The specs of a repo, as catalogue entries (consumer entries carry their text). */
export function loadRepoCatalogue(repo: WorkspaceRepoWithConfig): ConsumerSpec[] {
  const dir = specDirOf(repo);
  let specs;
  try {
    specs = loadAllSpecs(dir);
  } catch {
    return [];
  }
  return specs.map((s) => {
    const abs = path.resolve(s.filePath);
    let text = '';
    try {
      text = stripFrontmatter(readFileSync(abs, 'utf8'));
    } catch {
      /* unreadable: matched on its title only */
    }
    return {
      repo: repo.key,
      relPath: path.relative(repo.absPath, abs).split(path.sep).join('/'),
      abs,
      key: s.localKey ?? s.specKey,
      id: s.meta.id,
      title: s.title,
      kind: typeof s.meta.kind === 'string' ? s.meta.kind : path.basename(abs) === 'system.md' ? 'system' : undefined,
      summary: summaryOf(text),
      text,
    };
  });
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const sentences = (text: string): string[] =>
  text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** Headings and table rows describe the consumer itself (its own title, a capability map), not what it calls. */
const describesSelf = (sentence: string): boolean => /^#{1,6}\s/.test(sentence) || /^\|/.test(sentence);

/** Below the default minimum confidence, so an ambiguous title match is reported only when asked for. */
export const AMBIGUOUS_TITLE_SCORE = 0.5;

const trim200 = (s: string): string => (s.length > 200 ? `${s.slice(0, 197)}...` : s);

/** A key or id counts only when written as a reference, so a spec named `orders` is not matched by every use of the word. */
function referenceLike(token: string, sentence: string): boolean {
  const quoted = new RegExp('[`\'"]' + escapeRe(token) + '[`\'"]', 'i').test(sentence);
  const distinctive = /[/_-]/.test(token);
  return (quoted || distinctive) && new RegExp('(?<![\\w/-])' + escapeRe(token) + '(?![\\w/-])', 'i').test(sentence);
}

/**
 * How a sentence refers to a provider spec, as a score and a reason, or null: `repo::spec` reference 0.95,
 * spec path 0.9, spec key or id 0.8, whole-phrase title of two or more words 0.7.
 */
export function referenceIn(sentence: string, provider: CatalogueSpec): { score: number; reason: string } | null {
  const own = describesSelf(sentence);
  const lower = sentence.toLowerCase();
  for (const target of [provider.relPath, provider.key, provider.id].filter((t): t is string => !!t)) {
    if (lower.includes(`${provider.repo}::${target}`.toLowerCase())) return { score: 0.95, reason: `names ${provider.repo}::${target}` };
  }
  if (lower.includes(provider.relPath.toLowerCase())) return { score: 0.9, reason: `names the spec path ${provider.relPath}` };
  for (const token of [provider.key, provider.id].filter((t): t is string => !!t)) {
    if (referenceLike(token, sentence)) return { score: 0.8, reason: `names the spec ${token}` };
  }
  const title = provider.title.trim();
  if (!own && title.split(/\s+/).length >= 2 && new RegExp('(?<![\\w])' + escapeRe(title).replace(/\s+/g, '\\s+') + '(?![\\w])', 'i').test(sentence)) {
    return { score: 0.7, reason: `names "${title}"` };
  }
  return null;
}

/** Deterministic suggestions for one consumer spec: the best reference to each provider spec in its text. */
export function matchSpecText(consumer: ConsumerSpec, providers: CatalogueSpec[], consumerRepoAbs: string): Suggestion[] {
  const lines = sentences(consumer.text);
  const out: Array<Suggestion & { title?: string; repo?: string }> = [];
  for (const provider of providers) {
    let best: { score: number; reason: string; evidence: string } | null = null;
    for (const sentence of lines) {
      const ref = referenceIn(sentence, provider);
      if (ref && (!best || ref.score > best.score)) best = { ...ref, evidence: trim200(sentence) };
    }
    if (best) {
      out.push({
        title: provider.title,
        repo: provider.repo,
        provider: path.relative(consumerRepoAbs, provider.abs).split(path.sep).join('/'),
        source: 'spec-text',
        confidence: best.score,
        reason: best.reason,
        evidence: best.evidence,
      });
    }
  }
  // A title phrase that names specs in more than one provider repo does not say which one is called.
  const titleRepos = new Map<string, Set<string>>();
  for (const o of out) {
    if (o.confidence !== 0.7) continue;
    const k = `${o.evidence}|${(o as { title?: string }).title?.toLowerCase()}`;
    titleRepos.set(k, (titleRepos.get(k) ?? new Set()).add((o as { repo?: string }).repo ?? ''));
  }
  return out.map(({ title, repo: _repo, ...o }) => {
    const repos = titleRepos.get(`${o.evidence}|${title?.toLowerCase()}`);
    return repos && repos.size > 1
      ? { ...o, confidence: AMBIGUOUS_TITLE_SCORE, reason: `${o.reason}, ambiguous: specs with that title in ${[...repos].sort().join(', ')}` }
      : o;
  });
}
