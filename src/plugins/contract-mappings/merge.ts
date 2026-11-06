/**
 * Merging proposed contract mappings into an existing mappings file. Pure: no file access.
 *
 * An entry without `generated: true` is manual and never touched. A generated entry whose providers no
 * longer equal what its suggestions name was edited by hand and becomes manual. `pinned: true` keeps a
 * generated entry. Any other generated entry that is not proposed again is removed.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */

export type SuggestionSource = 'spec-text' | 'llm' | 'code';

export interface Suggestion {
  /** Provider spec path relative to the consumer repo (`../api/specs/capabilities/orders.md`). */
  provider: string;
  source: SuggestionSource;
  confidence: number;
  reason: string;
  evidence: string;
}

/** What the passes propose for one consumer spec. */
export interface Proposal {
  /** Repo-relative consumer spec path. */
  spec: string;
  suggestions: Suggestion[];
}

/** The key names of the mappings file (the `contractMappings` config). */
export interface MappingKeys {
  list: string;
  spec: string;
  /** Key the provider paths are written under. */
  providers: string;
}

export interface MergeResult {
  file: Record<string, unknown>;
  /** Consumer specs with a new generated entry. */
  added: string[];
  /** Entries left as they were (manual, pinned, hand-edited) or regenerated with the same providers. */
  kept: string[];
  /** Generated entries no longer found, dropped. */
  removed: string[];
  /** Entries that became manual because their providers were edited by hand (also in `kept`). */
  flipped: string[];
  /** Generated entries whose providers changed because the proposal did. */
  updated: string[];
}

type Entry = Record<string, unknown>;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : typeof value === 'string' ? [value] : [];

const sameSet = (a: string[], b: string[]): boolean => a.length === new Set([...a, ...b]).size && b.length === new Set([...a, ...b]).size;

/** Providers of a proposal, best first, each once. */
export function proposalProviders(suggestions: Suggestion[]): string[] {
  const best = new Map<string, number>();
  for (const s of suggestions) best.set(s.provider, Math.max(best.get(s.provider) ?? 0, s.confidence));
  return [...best.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
}

function generatedEntry(p: Proposal, keys: MappingKeys): Entry {
  return {
    [keys.spec]: p.spec,
    [keys.providers]: proposalProviders(p.suggestions),
    generated: true,
    suggestions: [...p.suggestions].sort((a, b) => b.confidence - a.confidence || a.provider.localeCompare(b.provider)),
  };
}

export function mergeMappings(existing: Record<string, unknown> | null, proposals: Proposal[], keys: MappingKeys): MergeResult {
  const file: Record<string, unknown> = { ...(existing ?? {}) };
  const current = Array.isArray(file[keys.list]) ? (file[keys.list] as Entry[]) : [];
  const proposed = new Map(proposals.filter((p) => p.suggestions.length > 0).map((p) => [p.spec, p] as const));
  const result: MergeResult = { file, added: [], kept: [], removed: [], flipped: [], updated: [] };
  const out: Entry[] = [];
  const seen = new Set<string>();

  for (const raw of current) {
    const spec = raw && typeof raw === 'object' ? raw[keys.spec] : undefined;
    if (typeof spec !== 'string') {
      out.push(raw);
      continue;
    }
    seen.add(spec);
    if (raw.generated !== true) {
      out.push(raw);
      result.kept.push(spec);
      continue;
    }
    const wasProposed = proposalProviders(Array.isArray(raw.suggestions) ? (raw.suggestions as Suggestion[]).filter((s) => s && typeof s.provider === 'string') : []);
    if (!sameSet(strings(raw[keys.providers]), wasProposed)) {
      const { generated: _generated, ...manual } = raw;
      out.push(manual);
      result.kept.push(spec);
      result.flipped.push(spec);
      continue;
    }
    if (raw.pinned === true) {
      out.push(raw);
      result.kept.push(spec);
      continue;
    }
    const next = proposed.get(spec);
    if (!next) {
      result.removed.push(spec);
      continue;
    }
    const entry = generatedEntry(next, keys);
    if (!sameSet(strings(entry[keys.providers]), strings(raw[keys.providers]))) result.updated.push(spec);
    else result.kept.push(spec);
    out.push(entry);
  }

  for (const [spec, p] of [...proposed.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (seen.has(spec)) continue;
    out.push(generatedEntry(p, keys));
    result.added.push(spec);
  }
  file[keys.list] = out;
  return result;
}
