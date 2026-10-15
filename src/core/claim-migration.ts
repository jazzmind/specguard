/**
 * Claim migration: moving claims from many v1 specs into one capability spec.
 *
 * `spec consolidate` merges the acceptance criteria of several per-file specs
 * into a capability's `## Requirements`. Claim ids must stay unique inside the
 * capability, so colliding slugs are made unique by prefixing the old spec's
 * name; ids never get numeric suffixes, because those depend on merge order.
 *
 * The result is a one-shot rewrite: test tags, ledger rows and the drift
 * registry are rekeyed to the new refs. The alias map is kept in
 * `.specguard/claim-migration.json` so results that still carry old tags are
 * accepted on ingest for one release.
 *
 * Spec: specs/capabilities/conformance-testing.md
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { parseClaimRef, slugFromText } from './claims.js';
import type { DriftRegistry } from './drift-registry.js';
import { fileExists, readFile } from './reader.js';
import type { ProofLedger } from './proof-ledger.js';
import type { SpecClaim } from './types.js';

const MAX_ID = 48;

/** A bullet to merge. `id` is an existing anchor (it has refs to preserve); `suggestedId` is only a proposal for a new claim. */
export type MergeClaim = Pick<SpecClaim, 'text' | 'id'> & { suggestedId?: string };

export interface ClaimSource {
  /** Canonical key of the v1 spec the bullets come from. */
  specKey: string;
  claims: MergeClaim[];
}

export interface MergedClaim {
  id: string;
  text: string;
}

export interface MergeResult {
  claims: MergedClaim[];
  /** Old `specKey#claimId` to the new claim id inside the capability, for claims that had an anchor. */
  aliases: Record<string, string>;
}

function clip(id: string): string {
  return id.slice(0, MAX_ID).replace(/-+$/g, '');
}

/**
 * Make a suggested id a valid claim id: lowercase kebab-case that starts with a
 * letter and fits the length cap. An id that is already valid is returned as is,
 * so existing anchors keep working.
 */
export function normalizeClaimId(id: string): string {
  let out = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(out)) out = `claim-${out}`;
  return clip(out) || 'claim';
}

function normText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Merge claims from several specs into one list with unique ids.
 *
 * - Bullets with identical text merge into one claim; every old ref aliases to it.
 * - A claim keeps its slug when no other distinct claim wants it.
 * - Otherwise each contender is prefixed with its spec's leaf name, then its
 *   whole key, and an error is thrown if that still collides.
 */
export function mergeClaims(sources: ClaimSource[]): MergeResult {
  interface Candidate {
    text: string;
    base: string;
    specKey: string;
    olds: string[];
    id?: string;
  }
  const byText = new Map<string, Candidate>();
  const order: Candidate[] = [];

  for (const source of sources) {
    for (const claim of source.claims) {
      if (!claim.text.trim()) continue;
      const key = normText(claim.text);
      let cand = byText.get(key);
      if (!cand) {
        const wanted = claim.id ?? claim.suggestedId;
        cand = { text: claim.text.trim(), base: wanted ? normalizeClaimId(wanted) : slugFromText(claim.text), specKey: source.specKey, olds: [] };
        byText.set(key, cand);
        order.push(cand);
      }
      if (claim.id) cand.olds.push(`${source.specKey}#${claim.id}`);
    }
  }

  const wanting = new Map<string, Candidate[]>();
  for (const cand of order) wantingAdd(wanting, cand.base, cand);

  const taken = new Set<string>();
  const assign = (cand: Candidate, id: string): void => {
    const final = clip(id);
    if (taken.has(final)) throw new Error(`cannot give claim "${cand.text}" a unique id: "${final}" is taken`);
    taken.add(final);
    cand.id = final;
  };
  // Uncontested slugs first so a prefixed id can never steal one.
  for (const [base, group] of wanting) if (group.length === 1) assign(group[0], base);
  for (const [base, group] of wanting) {
    if (group.length === 1) continue;
    // Contenders that would get the same prefixed id (several bullets from one spec) are told apart by a short
    // hash of their text, so the result does not depend on which came first.
    const proposal = (cand: Candidate): string => clip(`${path.posix.basename(cand.specKey)}-${base}`);
    const sameProposal = new Map<string, number>();
    for (const cand of group) sameProposal.set(proposal(cand), (sameProposal.get(proposal(cand)) ?? 0) + 1);
    for (const cand of group) {
      const root = proposal(cand);
      const contested = (sameProposal.get(root) ?? 0) > 1;
      let id = contested ? withHash(root, cand.text, 4) : taken.has(root) ? clip(`${cand.specKey.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${base}`) : root;
      for (let width = 6; taken.has(clip(id)) && width <= 40; width += 2) id = withHash(root, cand.text, width);
      assign(cand, id);
    }
  }

  const aliases: Record<string, string> = {};
  for (const cand of order) for (const old of cand.olds) aliases[old] = cand.id as string;
  return { claims: order.map((c) => ({ id: c.id as string, text: c.text })), aliases };
}

/** `id` made unique by a hash of `text`, kept inside the 48-character limit and a valid id. */
function withHash(id: string, text: string, width: number): string {
  const hash = createHash('sha1').update(normText(text)).digest('hex').slice(0, width);
  return `${id.slice(0, 48 - width - 1).replace(/-+$/g, '')}-${hash}`;
}

function wantingAdd<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

export interface ClaimMigration {
  version: 1;
  generated: string;
  /** Old ref `specKey#claimId` (no repo prefix) to new ref. */
  aliases: Record<string, string>;
  /** Old spec key to the capability spec key that absorbed it. */
  specs: Record<string, string>;
}

export const MIGRATION_FILE = '.specguard/claim-migration.json';

export function emptyMigration(): ClaimMigration {
  return { version: 1, generated: new Date().toISOString(), aliases: {}, specs: {} };
}

/** Resolve one ref through the alias map, keeping a repo prefix. Undefined when the ref is not aliased. */
export function aliasRef(ref: string, migration: Pick<ClaimMigration, 'aliases'>, ownRepoKeys: string[] = []): string | undefined {
  const parsed = parseClaimRef(ref);
  if (!parsed) return undefined;
  // The aliases describe this repo's specs. A ref that names another repo is that repo's claim and is not ours to rewrite.
  if (parsed.repo && !ownRepoKeys.includes(parsed.repo)) return undefined;
  const hit = migration.aliases[`${parsed.specKey}#${parsed.claimId}`];
  if (!hit) return undefined;
  return parsed.repo ? `${parsed.repo}:${hit}` : hit;
}

export async function loadClaimMigration(root: string): Promise<ClaimMigration | null> {
  const file = path.join(root, MIGRATION_FILE);
  if (!(await fileExists(file))) return null;
  try {
    const parsed = JSON.parse(await readFile(file)) as ClaimMigration;
    return parsed && typeof parsed.aliases === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Rekey proof rows through the alias map. Rows stay as they were, so they go stale on their own hashes. */
export function rekeyLedger(ledger: ProofLedger, migration: Pick<ClaimMigration, 'aliases'>, ownRepoKeys: string[] = []): { ledger: ProofLedger; moved: number } {
  const proofs: ProofLedger['proofs'] = {};
  let moved = 0;
  for (const [ref, record] of Object.entries(ledger.proofs)) {
    const next = aliasRef(ref, migration, ownRepoKeys);
    if (next) moved += 1;
    const key = next ?? ref;
    const existing = proofs[key];
    // When two old claims merged, keep the row that was ingested last.
    if (!existing || existing.ingestedAt <= record.ingestedAt) proofs[key] = { ...record, claim: key };
  }
  return { ledger: { ...ledger, proofs }, moved };
}

/** Merge drift-registry entries of absorbed specs into the capability that took them over. */
export function rekeyRegistry(registry: DriftRegistry, specs: Record<string, string>): { registry: DriftRegistry; moved: number } {
  const out: DriftRegistry = {};
  // Entries that are not absorbed go in first, so a capability that already has its own entry is
  // never replaced by a stub made from whichever absorbed spec happened to come first.
  for (const [key, entry] of Object.entries(registry)) {
    if (!specs[key]) out[key] = { ...entry, files: { ...entry.files } };
  }
  let moved = 0;
  for (const [key, entry] of Object.entries(registry)) {
    const target = specs[key];
    if (!target) continue;
    moved += 1;
    const into = out[target] ?? (out[target] = { specKey: target, specHash: entry.specHash, files: {} });
    for (const [file, meta] of Object.entries(entry.files ?? {})) into.files[file] ??= meta;
  }
  return { registry: out, moved };
}
