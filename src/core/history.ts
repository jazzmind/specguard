/**
 * Requirement history: the prompts, approved plans and decisions that shaped
 * each capability, committed under `specs/history/`.
 *
 * An entry is a markdown file with YAML frontmatter. Capabilities point back at
 * the entries behind them through their `history:` list. Claim hashes ignore
 * frontmatter, so adding a back-reference never stales a proof.
 *
 * Spec: specs/capabilities/requirement-history.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { specsRootDir } from './spec-key.js';
import type { SpecGuardConfig } from './types.js';

export type HistoryKind = 'prompt' | 'plan' | 'prompt+plan' | 'decision' | 'import';

export interface HistoryMeta {
  id: string;
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  kind: HistoryKind;
  author?: string;
  source?: string;
  title?: string;
  /** Capability ids the entry changed. */
  affects: string[];
}

export interface HistoryEntry extends HistoryMeta {
  /** Absolute path of the entry file. */
  file: string;
  body: string;
}

export const HISTORY_DIR = 'history';
const FRONT = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function historyDir(config: SpecGuardConfig): string {
  return path.join(specsRootDir(config), HISTORY_DIR);
}

export function slugify(text: string, max = 40): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'entry'
  );
}

/** `YYYY-MM-DD-slug`, made unique among `taken` with a numeric suffix. */
export function historyId(date: string, title: string, taken: Set<string> = new Set()): string {
  const base = `${date}-${slugify(title)}`;
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

const q = (s: string): string => JSON.stringify(s);

export function renderHistoryEntry(meta: HistoryMeta, body: string): string {
  const lines = [
    '---',
    `id: ${meta.id}`,
    `date: ${meta.date}`,
    `kind: ${meta.kind}`,
    ...(meta.author ? [`author: ${q(meta.author)}`] : []),
    ...(meta.source ? [`source: ${meta.source}`] : []),
    ...(meta.title ? [`title: ${q(meta.title)}`] : []),
    ...(meta.affects.length > 0 ? ['affects:', ...meta.affects.map((a) => `  - ${a}`)] : ['affects: []']),
    '---',
    '',
  ];
  return `${lines.join('\n')}${body.trim()}\n`;
}

export function parseHistoryEntry(content: string, file: string): HistoryEntry | null {
  const m = content.match(FRONT);
  if (!m) return null;
  let doc: Record<string, unknown>;
  try {
    doc = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof doc.id !== 'string') return null;
  const date = doc.date instanceof Date ? doc.date.toISOString().slice(0, 10) : String(doc.date ?? '');
  return {
    id: doc.id,
    date,
    kind: (typeof doc.kind === 'string' ? doc.kind : 'plan') as HistoryKind,
    author: typeof doc.author === 'string' ? doc.author : undefined,
    source: typeof doc.source === 'string' ? doc.source : undefined,
    title: typeof doc.title === 'string' ? doc.title : undefined,
    affects: Array.isArray(doc.affects) ? doc.affects.filter((a): a is string => typeof a === 'string') : [],
    file,
    body: content.slice(m[0].length),
  };
}

/** Every history entry, oldest first. */
export function listHistory(config: SpecGuardConfig): HistoryEntry[] {
  const dir = historyDir(config);
  if (!fs.existsSync(dir)) return [];
  const out: HistoryEntry[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(dir, name);
    const entry = parseHistoryEntry(fs.readFileSync(file, 'utf8'), file);
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/**
 * Add `id` to the `history:` list in a spec's frontmatter, creating the list
 * when missing. Idempotent. Handles a block list (indented or not), a flow list
 * (`history: [a, b]`) and an empty one. Content without frontmatter, with a
 * `history:` value it cannot read, or whose edited frontmatter would no longer
 * parse is returned unchanged: a spec is never left unreadable by a history write.
 */
export function addHistoryRef(content: string, id: string): string {
  const m = content.match(/^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/);
  if (!m) return content;
  const eol = m[1].endsWith('\r\n') ? '\r\n' : '\n';
  const lines = m[2].split(/\r?\n/);
  const at = lines.findIndex((l) => /^history:/.test(l));
  let next: string[];
  if (at === -1) {
    next = [...lines, 'history:', `  - ${id}`];
  } else {
    const value = lines[at].slice('history:'.length).trim();
    if (value.startsWith('[')) {
      let existing: unknown;
      try {
        existing = parseYaml(value);
      } catch {
        return content;
      }
      const ids = Array.isArray(existing) ? existing.map(String) : [];
      if (ids.includes(id)) return content;
      next = [...lines.slice(0, at), 'history:', ...[...ids, id].map((x) => `  - ${x}`), ...lines.slice(at + 1)];
    } else if (value === '') {
      let end = at + 1;
      while (end < lines.length && /^[ \t]*-(?:[ \t]|$)/.test(lines[end])) end += 1;
      const items = lines.slice(at + 1, end);
      if (items.some((l) => l.replace(/^[ \t]*-[ \t]*/, '').replace(/^["']|["']$/g, '').trim() === id)) return content;
      const indent = items[0]?.match(/^[ \t]*/)?.[0] ?? '  ';
      next = [...lines.slice(0, end), `${indent}- ${id}`, ...lines.slice(end)];
    } else {
      return content;
    }
  }
  const out = `${m[1]}${next.join(eol)}${m[3]}${content.slice(m[0].length)}`;
  try {
    const doc = parseYaml(next.join('\n')) as { history?: unknown } | null;
    if (!doc || !Array.isArray(doc.history) || !doc.history.map(String).includes(id)) return content;
  } catch {
    return content;
  }
  return out;
}
