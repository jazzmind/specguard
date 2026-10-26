/**
 * The effective proof ledger: the local cache (`.specguard/proofs.json`) together with the nearest noted ancestor's
 * proof note, so a clone with no local ledger still sees what CI proved. Per claim and test layer one row stands:
 * the note's row when it is fresh at this checkout, else the local row, judged by the same hash rules as every other
 * read. A local row is always `local` evidence, whatever origin it was written with: CI evidence comes from notes only
 * (the one exception is the CI job that has just run the tests, which asks to keep the stored origin).
 *
 * Reading is local: no network, and a repo with no notes reads exactly as before.
 *
 * Spec: specs/capabilities/proof-store.md
 */
import { githubApi, type GitHubApi } from '../ci/github-api.js';
import { verifyNoteWithConfig, type NoteVerification } from '../ci/note-verify.js';
import type { Approval } from '../core/approvals.js';
import { parseClaimRef } from '../core/claims.js';
import {
  layersOf,
  mergeLayerRecord,
  type EffectiveVerdict,
  type LayerProof,
  type ProofLedger,
  type ProofRecord,
  type StoredVerdict,
} from '../core/proof-ledger.js';
import { expandNote, noteDigest, serializeNote, type NoteApproval, type NoteCountersign } from '../core/proof-note.js';
import { headCommit, hasNotesRef, isShallow, nearestNoted, notesFetchedAt, resolveNotesConfig } from '../core/proof-store.js';
import { fileLedgerStore, type LedgerStore } from '../core/state/ledger-store.js';
import type { EvidenceLayer } from '../core/test-layers.js';
import type { SpecGuardConfig } from '../core/types.js';
import { ledgerPath, migrateLedgerPaths, walkClaimVerdicts } from './proof.js';

/** Where the row standing for one claim and layer came from. */
export type RowSource =
  | { kind: 'local'; fresh?: boolean }
  | { kind: 'note'; commit: string; verified: NoteVerification['status']; distance: number; fresh?: boolean };

export interface EffectiveNote {
  commit: string;
  /** Commits between HEAD and the noted ancestor (0 = HEAD itself). */
  distance: number;
  verified: NoteVerification['status'];
  createdAt: string;
  runUrl?: string;
  /** Written with `proof publish --force-local`: its rows read as local evidence. */
  provisional: boolean;
}

export interface EffectiveLedger {
  /** Merged rows, each with its origin set (local rows `local`, note rows `ci`). */
  ledger: ProofLedger;
  /** Per `claim\0layer` of the merged ledger. `fresh` is set when staleness was judged (a note was read, or it was asked for). */
  sourceOf: Map<string, RowSource>;
  note?: EffectiveNote;
  noteApprovals: NoteApproval[];
  countersigns: NoteCountersign[];
  /** Shallow clone, newer-version or unreadable notes, a note that does not match its check run, notes not fetched for a week. */
  warnings: string[];
}

export interface EffectiveOpts {
  /** Ignore notes: the local cache alone. */
  noNotes?: boolean;
  /** Commit whose nearest noted ancestor is read. Default HEAD. */
  head?: string;
  /**
   * How a local row is labelled. `local` (default) calls every local row local whatever it says. `stored` keeps the
   * origin written at ingest: only for the CI job that has just run the tests and is about to write the note.
   */
  localOrigin?: 'local' | 'stored';
  /** Judge staleness even when no note is read (a caller that wants to know which local rows are fresh). */
  withFreshness?: boolean;
  /** GitHub client for `proofStore.verify: check-run`. Default: built from the token in the environment, when there is one. */
  api?: Pick<GitHubApi, 'listCheckRuns'>;
  /** The local ledger instead of the file (tests and callers that already hold it). */
  local?: ProofLedger;
  now?: Date;
}

export const rowKey = (claim: string, layer: string): string => `${claim}\u0000${layer}`;

const WEEK_MS = 7 * 86_400_000;

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/** A ledger store over a ledger already in memory that cannot be written: no pipeline may write a merged view. */
export function readOnlyLedgerStore(location: string, ledger: ProofLedger): LedgerStore {
  return {
    location,
    read: async () => ledger,
    update: () => {
      throw new Error(`the proof ledger from ${location} is a merged read-only view; write to the local cache with test run or results ingest`);
    },
  };
}

/** Read-only store over an effective ledger: `read()` returns it, `update()` throws. */
export function readOnlyStore(eff: EffectiveLedger): LedgerStore {
  return readOnlyLedgerStore(eff.note ? `proof note @${eff.note.commit.slice(0, 7)} and the local cache` : 'the local cache', eff.ledger);
}

// ---------------------------------------------------------------------------
// Choosing a row
// ---------------------------------------------------------------------------

const isFailure = (v: StoredVerdict): boolean => v === 'failed' || v === 'error';

/** The newer row; on the same instant the note's, which was earned by a trusted run. */
function newer(local: LayerProof, note: LayerProof): 'local' | 'note' {
  return local.ingestedAt > note.ingestedAt ? 'local' : 'note';
}

/**
 * Pure: per claim and layer, the local row or the note row. Conservative, because a fresh failure is evidence whatever
 * its origin:
 *  1. a fresh failed or error row from either side (the newer when both),
 *  2. a fresh CI proven row from the note,
 *  3. a fresh local proven row, or a fresh proven row of a provisional note (the newer of the two),
 *  4. any other fresh row (the newer),
 *  5. otherwise the newer of the stale rows, so the verdict reads stale.
 */
export function chooseRow(local: { row: LayerProof; fresh: boolean } | undefined, note: { row: LayerProof; fresh: boolean } | undefined): 'local' | 'note' | undefined {
  if (!local && !note) return undefined;
  if (!local) return 'note';
  if (!note) return 'local';
  const bad = (x: { row: LayerProof; fresh: boolean }): boolean => x.fresh && isFailure(x.row.verdict);
  if (bad(local) && bad(note)) return newer(local.row, note.row);
  if (bad(local)) return 'local';
  if (bad(note)) return 'note';
  const proven = (x: { row: LayerProof; fresh: boolean }): boolean => x.fresh && x.row.verdict === 'proven';
  if (proven(note) && note.row.origin !== 'local') return 'note';
  if (proven(local) && proven(note)) return newer(local.row, note.row);
  if (proven(local)) return 'local';
  if (proven(note)) return 'note';
  if (local.fresh && note.fresh) return newer(local.row, note.row);
  if (local.fresh) return 'local';
  if (note.fresh) return 'note';
  return newer(local.row, note.row);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Every row of `ledger` labelled `origin` (rows and layers), without touching the caller's copy. */
function relabelled(ledger: ProofLedger, origin: 'local' | 'ci'): ProofLedger {
  const copy = structuredClone(ledger);
  for (const record of Object.values(copy.proofs)) {
    record.origin = origin;
    for (const layer of Object.values(record.layers ?? {})) if (layer) layer.origin = origin;
  }
  return copy;
}

async function readLocal(config: SpecGuardConfig, root: string): Promise<ProofLedger> {
  const ledger = await fileLedgerStore(ledgerPath(root, config.paths?.proofLedger)).read();
  // Absolute paths from another machine are read as repo-relative, as every ledger read does (nothing is written back).
  migrateLedgerPaths(ledger, [root]);
  return ledger;
}

type Layers = Partial<Record<EvidenceLayer, EffectiveVerdict>>;

/** The effective verdict of each layer of every record, judged by hashes alone, for the records the specs name. */
async function layerFreshness(config: SpecGuardConfig, location: string, ledger: ProofLedger): Promise<Map<ProofRecord, Layers>> {
  const out = new Map<ProofRecord, Layers>();
  await walkClaimVerdicts(
    config,
    (_ref, _verdict, detail) => {
      if (detail?.record) out.set(detail.record, detail.layers);
    },
    { store: readOnlyLedgerStore(location, ledger), deterministic: true },
  );
  return out;
}

const isFresh = (verdict: EffectiveVerdict | undefined): boolean => verdict !== undefined && verdict !== 'stale';

function apiFromEnv(env: NodeJS.ProcessEnv): Pick<GitHubApi, 'listCheckRuns'> | undefined {
  const token = env.SG_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN;
  return token ? githubApi(token, env.GITHUB_API_URL || undefined) : undefined;
}

/**
 * The local cache and the nearest noted ancestor of HEAD as one ledger. Without a note (no notes ref, none reachable,
 * `noNotes`, not a git checkout, or a note that does not match its check run) it is the local ledger alone.
 */
export async function loadEffectiveLedger(config: SpecGuardConfig, opts: EffectiveOpts = {}): Promise<EffectiveLedger> {
  const root = config.rootDir ?? process.cwd();
  const warnings: string[] = [];
  const localOrigin = opts.localOrigin ?? 'local';
  const raw = opts.local ?? (await readLocal(config, root));
  const local = localOrigin === 'local' ? relabelled(raw, 'local') : structuredClone(raw);
  const localOnly = async (): Promise<EffectiveLedger> => {
    const sourceOf = new Map<string, RowSource>();
    const fresh = opts.withFreshness ? await layerFreshness(config, 'the local cache', local) : undefined;
    for (const [key, record] of Object.entries(local.proofs)) {
      for (const layer of Object.keys(layersOf(record))) {
        const verdict = (fresh?.get(record) ?? {})[layer as EvidenceLayer];
        sourceOf.set(rowKey(key, layer), { kind: 'local', ...(fresh ? { fresh: isFresh(verdict) } : {}) });
      }
    }
    return { ledger: local, sourceOf, noteApprovals: [], countersigns: [], warnings };
  };
  if (opts.noNotes) return localOnly();

  let head: string | undefined;
  let notes;
  try {
    notes = resolveNotesConfig(config.proofStore);
    head = opts.head ?? headCommit(root);
  } catch (err) {
    warnings.push(`proof notes were not read: ${(err as Error).message}`);
    return localOnly();
  }
  if (!head) return localOnly();

  const nearest = nearestNoted(root, notes, head);
  warnings.push(...nearest.warnings);
  if (nearest.commit === undefined) {
    if (nearest.truncated) {
      warnings.push(
        isShallow(root)
          ? 'shallow clone: no noted ancestor is reachable; run `specguard proof fetch` or deepen the clone'
          : `no proof note within ${notes.maxWalk} commits of HEAD`,
      );
    }
    return localOnly();
  }
  const fetchedAt = hasNotesRef(root, notes) ? notesFetchedAt(root) : undefined;
  if (fetchedAt && (opts.now ?? new Date()).getTime() - fetchedAt.getTime() > WEEK_MS) {
    warnings.push(`proof notes were last fetched on ${fetchedAt.toISOString().slice(0, 10)}; run \`specguard proof fetch\``);
  }

  const note = nearest.note;
  const short = nearest.commit.slice(0, 7);
  let verified: NoteVerification = { status: 'unverified' };
  if (notes.verify === 'check-run') {
    verified = await verifyNoteWithConfig('check-run', opts.api ?? apiFromEnv(process.env), note.ci.repo, nearest.commit, noteDigest(serializeNote(note)));
    if (verified.status === 'mismatch') {
      warnings.push(`the proof note on ${short} does not match its CI check run (${verified.detail ?? 'digest differs'}); it was ignored`);
      return localOnly();
    }
  }
  const provisional = note.ci.event === 'local';
  const fromNote = relabelled(expandNote(note), provisional ? 'local' : 'ci');
  const [localFresh, noteFresh] = await Promise.all([
    layerFreshness(config, 'the local cache', local),
    layerFreshness(config, `proof note @${short}`, fromNote),
  ]);
  const meta: EffectiveNote = {
    commit: nearest.commit,
    distance: nearest.distance,
    verified: verified.status,
    createdAt: note.createdAt,
    ...(note.ci.runUrl ? { runUrl: note.ci.runUrl } : {}),
    provisional,
  };

  const proofs: Record<string, ProofRecord> = {};
  const sourceOf = new Map<string, RowSource>();
  for (const key of [...new Set([...Object.keys(local.proofs), ...Object.keys(fromNote.proofs)])].sort()) {
    const l = local.proofs[key];
    const n = fromNote.proofs[key];
    const localLayers = l ? layersOf(l) : {};
    const noteLayers = n ? layersOf(n) : {};
    const chosen = new Map<EvidenceLayer, { row: LayerProof; source: RowSource }>();
    for (const layer of new Set([...Object.keys(localLayers), ...Object.keys(noteLayers)]) as Set<EvidenceLayer>) {
      const lr = localLayers[layer];
      const nr = noteLayers[layer];
      const lFresh = lr !== undefined && l !== undefined && isFresh((localFresh.get(l) ?? {})[layer]);
      const nFresh = nr !== undefined && n !== undefined && isFresh((noteFresh.get(n) ?? {})[layer]);
      const pick = chooseRow(lr ? { row: lr, fresh: lFresh } : undefined, nr ? { row: nr, fresh: nFresh } : undefined);
      if (pick === 'local' && lr) chosen.set(layer, { row: lr, source: { kind: 'local', fresh: lFresh } });
      else if (pick === 'note' && nr) chosen.set(layer, { row: nr, source: { kind: 'note', commit: meta.commit, verified: meta.verified, distance: meta.distance, fresh: nFresh } });
    }
    // Classified evidence supersedes unclassified evidence of the same tests, as in every ledger write.
    if ([...chosen.keys()].some((layer) => layer !== 'unclassified')) chosen.delete('unclassified');
    let record: ProofRecord | undefined;
    for (const [layer, { row, source }] of chosen) {
      record = mergeLayerRecord(record, { claim: key, ...row } as ProofRecord, layer);
      sourceOf.set(rowKey(key, layer), source);
    }
    if (record) proofs[key] = record;
  }

  return {
    ledger: { version: 1, proofs },
    sourceOf,
    note: meta,
    noteApprovals: structuredClone(note.approvals),
    countersigns: structuredClone(note.countersigns),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Reading the result
// ---------------------------------------------------------------------------

/** Pull-request approvals carried in the note, in the form the statement counts. Each names the note and the review it came from. */
export function noteApprovalsAsApprovals(eff: EffectiveLedger): Approval[] {
  if (!eff.note) return [];
  return eff.noteApprovals.map((a) => ({ claim: a.claim, hash: a.hash, method: 'pr', by: a.by, date: a.date, entry: `note:${eff.note!.commit.slice(0, 7)}#${a.reviewId}` }));
}

/** The spec key of a ledger key (`repo:specKey#claim/row` or `specKey#claim`). */
const specKeyOfKey = (key: string): string | undefined => parseClaimRef(key)?.specKey;

/** How many fresh rows of a capability's spec came from a CI note and how many were earned locally. */
export function sourceCounts(eff: EffectiveLedger, specKey?: string): { ci: number; local: number } {
  let ci = 0;
  let local = 0;
  for (const [key, source] of eff.sourceOf) {
    if (source.fresh === false) continue;
    const claim = key.slice(0, key.indexOf('\u0000'));
    if (specKey !== undefined && specKeyOfKey(claim) !== specKey) continue;
    if (source.kind === 'note' && !eff.note?.provisional) ci += 1;
    else local += 1;
  }
  return { ci, local };
}

/**
 * Where a capability's evidence comes from, for `check`: `ci note @abc1234 (2 commits back, unverified)`,
 * `local (provisional)` or `mixed: 30 ci, 4 local`. Undefined when no fresh row of the spec exists (or no note is read).
 */
export function evidenceSourceLabel(eff: EffectiveLedger, specKey: string): string | undefined {
  if (!eff.note) return undefined;
  const { ci, local } = sourceCounts(eff, specKey);
  if (ci === 0 && local === 0) return undefined;
  if (ci === 0) return 'local (provisional)';
  if (local > 0) return `mixed: ${ci} ci, ${local} local`;
  const where = eff.note.distance > 0 ? `${eff.note.distance} commit${eff.note.distance === 1 ? '' : 's'} back, ` : '';
  return `ci note @${eff.note.commit.slice(0, 7)} (${where}${eff.note.verified})`;
}

/**
 * The rows that are fresh at this checkout and CI-origin, as a ledger: what a note for HEAD holds. With `includeLocal`
 * (`proof publish --force-local`) fresh local rows are in it too.
 */
export function freshLedger(eff: EffectiveLedger, opts: { includeLocal?: boolean } = {}): ProofLedger {
  const proofs: Record<string, ProofRecord> = {};
  for (const [key, record] of Object.entries(eff.ledger.proofs)) {
    let kept: ProofRecord | undefined;
    for (const [layer, row] of Object.entries(layersOf(record)) as Array<[EvidenceLayer, LayerProof]>) {
      if (eff.sourceOf.get(rowKey(key, layer))?.fresh !== true) continue;
      if (row.origin !== 'ci' && !opts.includeLocal) continue;
      kept = mergeLayerRecord(kept, { claim: record.claim ?? key, ...row } as ProofRecord, layer);
    }
    if (kept) proofs[key] = kept;
  }
  return { version: 1, proofs };
}

/** `note`, `local` or `mixed`, for the snapshot: where its proof rows came from. */
export function proofSourceKind(eff: EffectiveLedger): 'note' | 'local' | 'mixed' {
  if (!eff.note) return 'local';
  const kinds = new Set([...eff.sourceOf.values()].map((s) => s.kind));
  return kinds.has('local') ? (kinds.has('note') ? 'mixed' : 'local') : 'note';
}
