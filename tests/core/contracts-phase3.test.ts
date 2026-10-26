import { describe, expect, it } from 'vitest';

import * as changeClaims from '../../src/core/change-claims.js';
import * as changeRecord from '../../src/core/change-record.js';
import * as migratePlan from '../../src/core/migrate-plan.js';
import * as proofNote from '../../src/core/proof-note.js';
import * as proofPacket from '../../src/core/proof-packet.js';
import * as unrequested from '../../src/core/unrequested.js';
import * as decide from '../../src/hooks/decide.js';
import * as prApprovals from '../../src/ci/pr-approvals.js';
import { ENFORCE_DEFAULTS, ENFORCE_LEVELS, PROOF_STORE_DEFAULTS, type EnforceLevel, type SpecMeta } from '../../src/core/types.js';

/** The names a module must keep exporting: a slice that fills in a module may add helpers, never remove one of these. */
const keepsExporting = (mod: object, names: string[]): void => expect(Object.keys(mod)).toEqual(expect.arrayContaining(names));

// The contract modules are frozen signatures whose bodies throw `not implemented: <name>` until a later slice fills
// them in. Calling each with empty input must either throw that message or, once implemented, do anything else.
const stubs: Array<[string, () => unknown]> = [
  ['parseNote', () => proofNote.parseNote('{}')],
  ['serializeNote', () => proofNote.serializeNote({} as proofNote.ProofNote)],
  ['noteDigest', () => proofNote.noteDigest('')],
  ['compactLedger', () => proofNote.compactLedger({} as never, { commit: 'x' })],
  ['expandNote', () => proofNote.expandNote({} as proofNote.ProofNote)],
  ['fitNote', () => proofNote.fitNote({} as proofNote.ProofNote)],
  ['mergeNotes', () => proofNote.mergeNotes({} as proofNote.ProofNote, {} as proofNote.ProofNote)],
  ['newChangeId', () => changeRecord.newChangeId(new Date(0), 'x', () => 'abcd')],
  ['parseChangeRecord', () => changeRecord.parseChangeRecord('{}', 'f.json')],
  ['serializeChangeRecord', () => changeRecord.serializeChangeRecord({} as changeRecord.ChangeRecord)],
  ['derivePlanApprovals', () => changeRecord.derivePlanApprovals({} as changeRecord.ChangeRecord, [], [])],
  ['diffClaims', () => changeClaims.diffClaims(new Map(), new Map())],
  ['buildPacket', () => proofPacket.buildPacket({} as proofPacket.PacketInput)],
  ['renderPacketMarkdown', () => proofPacket.renderPacketMarkdown({} as proofPacket.ProofPacket)],
  ['packetDigest', () => proofPacket.packetDigest({} as proofPacket.ProofPacket)],
  ['findUnrequested', () => unrequested.findUnrequested({} as unrequested.UnrequestedInput)],
  ['classify', () => decide.classify('a.ts', {} as decide.HookIndex, () => false)],
  ['decide', () => decide.decide({} as decide.HookEvent, [], {} as decide.HookIndex, { redValid: new Map() })],
  ['qualifyingReviews', () => prApprovals.qualifyingReviews([], 'x')],
  ['reviewCovers', () => prApprovals.reviewCovers({} as prApprovals.QualifyingReview, 'a#b', () => undefined, 'h')],
  ['trustApprovals', () => prApprovals.trustApprovals({} as prApprovals.TrustInput)],
  ['detectFormat', () => migratePlan.detectFormat({} as migratePlan.RepoFacts)],
  ['planMigration', () => migratePlan.planMigration({} as migratePlan.RepoFacts, { consolidate: false, fetchNotes: false, workflow: false })],
];

const note = (): proofNote.ProofNote => ({
  schema: 'specguard.proof-note',
  version: 1,
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  parents: ['c'.repeat(40)],
  createdAt: '2026-10-25T00:00:00.000Z',
  tool: { specguard: '0.6.0', node: '22.0.0', hashVersion: 2 },
  ci: { provider: 'github', event: 'pull_request', repo: 'o/r', runId: '1', runAttempt: 1, pr: 7 },
  files: { 'src/cart.ts': 'd'.repeat(64) },
  deps: 'e'.repeat(16),
  rows: [
    {
      claim: 'capabilities/cart#fee',
      layer: 'unit',
      verdict: 'proven',
      runId: '1-1',
      specHash: 'f'.repeat(64),
      hashVersion: 2,
      files: ['src/cart.ts'],
      exercised: 3,
      counterexamples: 0,
      provedAt: 'a'.repeat(40),
      ingestedAt: '2026-10-25T00:00:00.000Z',
      sensitivity: { kind: 'red-green', red: 'fail', tests: 2 },
    },
  ],
  approvals: [{ claim: 'capabilities/cart#fee', hash: '0123456789abcdef', method: 'pr', by: 'alice', pr: 7, reviewId: 99, reviewedAt: 'a'.repeat(40), date: '2026-10-25' }],
  countersigns: [{ entry: '2026-10-25-approve-cart', method: 'command', status: 'countersigned', by: 'alice', pr: 7 }],
  statement: {
    level: 'certified',
    counts: { certified: 1, provisional: 0, 'not-certified': 0, planned: 0 },
    capabilities: [{ id: 'cart', level: 'certified', enforce: 'warn', pillars: { approved: 'ok', testable: 'ok', aligned: 'ok', conforms: 'ok' } }],
  },
  changes: [{ id: '20261025-free-shipping-a1b2', kind: 'feature', verdict: 'pass', claims: ['capabilities/cart#fee'] }],
  packet: { pr: 7, verdict: 'ready', sha256: '9'.repeat(64) },
});

const record = (): changeRecord.ChangeRecord => ({
  version: 1,
  id: '20261025-free-shipping-a1b2',
  kind: 'feature',
  capabilities: ['cart'],
  why: 'free shipping over 50',
  createdAt: '2026-10-25T10:00:00.000Z',
  createdBy: 'Ada',
  baseRef: 'origin/main',
  startSha: 'a'.repeat(40),
  branch: 'free-shipping',
  plans: [],
});

describe('Phase 3 contract modules [phase3-contracts]', () => {
  it('export the names the design lists', () => {
    keepsExporting(proofNote, [
      'DEFAULT_NOTES_REF', 'NOTE_HARD_LIMIT', 'NOTE_SCHEMA', 'NOTE_SOFT_LIMIT', 'NOTE_VERSION', 'ProofNoteSchema',
      'compactLedger', 'expandNote', 'fitNote', 'mergeNotes', 'noteDigest', 'parseNote', 'serializeNote',
    ]);
    keepsExporting(changeRecord, ['CHANGES_DIR', 'CHANGE_KINDS', 'ChangeRecordSchema', 'derivePlanApprovals', 'newChangeId', 'parseChangeRecord', 'serializeChangeRecord']);
    keepsExporting(changeClaims, ['diffClaims']);
    keepsExporting(proofPacket, ['APPROVAL_TRUSTS', 'PACKET_VERDICTS', 'PACKET_SCHEMA', 'buildPacket', 'packetDigest', 'renderPacketMarkdown']);
    keepsExporting(unrequested, ['findUnrequested']);
    keepsExporting(decide, ['HOOK_CODES', 'classify', 'decide']);
    keepsExporting(prApprovals, ['qualifyingReviews', 'reviewCovers', 'trustApprovals']);
    keepsExporting(migratePlan, ['MIGRATE_STEP_IDS', 'REPO_FORMATS', 'detectFormat', 'planMigration']);
  });

  it('declare the constants with the design\'s values', () => {
    expect(proofNote.NOTE_SCHEMA).toBe('specguard.proof-note');
    expect(proofNote.NOTE_VERSION).toBe(1);
    expect(proofPacket.PACKET_SCHEMA).toBe('specguard.proof-packet');
    expect(proofPacket.PACKET_VERDICTS).toEqual(['ready', 'blocked', 'advisory', 'no-change']);
    expect(proofPacket.APPROVAL_TRUSTS).toEqual(['verified', 'countersigned', 'self-approved', 'inherited', 'recorded', 'missing']);
    expect(proofPacket.PACKET_MAX_CHARS).toBeLessThan(proofPacket.PACKET_GITHUB_LIMIT);
    expect(proofPacket.PACKET_GITHUB_LIMIT).toBe(65_536);
    expect(proofPacket.PACKET_MARKER).toBe('<!-- specguard-proof-packet v1 -->');
    expect(changeRecord.CHANGE_KINDS).toEqual(['feature', 'refactor', 'spike']);
    expect(changeRecord.CHANGES_DIR).toBe('.specguard/changes');
    expect(decide.HOOK_CODES).toHaveLength(21);
    expect(new Set(decide.HOOK_CODES).size).toBe(21);
    expect(decide.HOOK_CODES).toEqual(expect.arrayContaining(['DENY_NO_CHANGE', 'DENY_BEFORE_RED', 'DENY_NOT_APPROVED', 'DENY_APPROVAL_WRITE', 'ERROR_OPEN', 'ERROR_CLOSED']));
    expect(decide.HOOK_MESSAGE_MAX).toBe(300);
    expect(prApprovals.QUALIFYING_ASSOCIATIONS).toEqual(['OWNER', 'MEMBER', 'COLLABORATOR']);
    expect(migratePlan.REPO_FORMATS).toEqual(['none', 'v0.1', 'v0.2-0.3', 'v0.6']);
    expect(migratePlan.MIGRATE_STEP_IDS).toHaveLength(14);
  });

  it.each(stubs)('%s is a stub that names itself, or implemented', (name, call) => {
    try {
      call();
    } catch (err) {
      const message = (err as Error).message;
      if (message.startsWith('not implemented')) expect(message).toBe(`not implemented: ${name}`);
    }
  });

  // [claims: capabilities/proof-store#note-contract]
  it('the note schema accepts a complete note, rejects a wrong schema, a missing field and a bad approval hash, and keeps unknown fields', () => {
    expect(proofNote.ProofNoteSchema.safeParse(note()).success).toBe(true);

    const wrongSchema = proofNote.ProofNoteSchema.safeParse({ ...note(), schema: 'something.else' });
    expect(wrongSchema.success).toBe(false);
    expect(proofNote.ProofNoteSchema.safeParse({ ...note(), version: 2 }).success).toBe(false);
    for (const field of ['commit', 'tree', 'rows', 'approvals', 'statement', 'files', 'changes', 'countersigns']) {
      const { [field as keyof proofNote.ProofNote]: _dropped, ...rest } = note();
      expect(proofNote.ProofNoteSchema.safeParse(rest).success, `missing ${field}`).toBe(false);
    }
    const badHash = note();
    badHash.approvals[0].hash = 'not-a-hash';
    expect(proofNote.ProofNoteSchema.safeParse(badHash).success).toBe(false);
    const badLayer = { ...note(), rows: [{ ...note().rows[0], layer: 'smoke' }] };
    expect(proofNote.ProofNoteSchema.safeParse(badLayer).success).toBe(false);
    const badVerdict = { ...note(), rows: [{ ...note().rows[0], verdict: 'stale' }] }; // `stale` is computed, never stored
    expect(proofNote.ProofNoteSchema.safeParse(badVerdict).success).toBe(false);
    const incompleteCounts = { ...note(), statement: { ...note().statement, counts: { certified: 1 } } };
    expect(proofNote.ProofNoteSchema.safeParse(incompleteCounts).success).toBe(false);

    // fields added within a version survive a read, at the top level and inside rows
    const extended = { ...note(), futureField: { a: 1 }, rows: [{ ...note().rows[0], futureRowField: 'x' }] };
    const parsed = proofNote.ProofNoteSchema.parse(extended) as Record<string, unknown> & { rows: Array<Record<string, unknown>> };
    expect(parsed.futureField).toEqual({ a: 1 });
    expect(parsed.rows[0].futureRowField).toBe('x');
  });

  // [claims: capabilities/proof-store#note-defaults]
  it('notes default to refs/notes/specguard on origin with the 1 MiB and 8 MiB limits, and are not checked against a CI run unless asked', () => {
    expect(proofNote.DEFAULT_NOTES_REF).toBe('refs/notes/specguard');
    expect(PROOF_STORE_DEFAULTS.notesRef).toBe(proofNote.DEFAULT_NOTES_REF);
    expect(PROOF_STORE_DEFAULTS.remote).toBe('origin');
    expect(proofNote.NOTE_SOFT_LIMIT).toBe(1024 * 1024);
    expect(proofNote.NOTE_HARD_LIMIT).toBe(8 * 1024 * 1024);
    expect(PROOF_STORE_DEFAULTS.verify).toBe('off');
  });

  // [claims: capabilities/spec-first-changes#change-record-contract]
  it('the change record schema accepts a record, and rejects an id that could leave the changes directory, no capability and an unknown kind', () => {
    const schema = changeRecord.ChangeRecordSchema;
    expect(schema.safeParse(record()).success).toBe(true);
    expect(schema.safeParse({ ...record(), kind: 'spike', closed: { at: 'x', by: 'Ada', reason: 'abandoned' } }).success).toBe(true);

    for (const id of ['../../etc/passwd', '20261025-free-shipping', '20261025-free-shipping-A1B2', '20261025--a1b2', 'free-shipping-a1b2', '20261025-x/../y-a1b2', '20261025-free shipping-a1b2']) {
      expect(schema.safeParse({ ...record(), id }).success, id).toBe(false);
    }
    expect(changeRecord.CHANGE_ID_PATTERN.test('20261025-free-shipping-a1b2')).toBe(true);
    expect(schema.safeParse({ ...record(), capabilities: [] }).success).toBe(false);
    const { capabilities: _caps, ...noCaps } = record();
    expect(schema.safeParse(noCaps).success).toBe(false);
    expect(schema.safeParse({ ...record(), kind: 'hotfix' }).success).toBe(false);
    expect(schema.safeParse({ ...record(), closed: { at: 'x', by: 'Ada', reason: 'merged' } }).success).toBe(false);
    expect(schema.safeParse({ ...record(), plans: undefined }).success).toBe(false);

    const parsed = schema.parse({ ...record(), futureField: 1 }) as unknown as Record<string, unknown>;
    expect(parsed.futureField).toBe(1);
  });

  // [claims: capabilities/spec-first-changes#enforce-levels]
  it('enforcement levels are observe, warn and enforce from weakest to strongest, and the default is observe', () => {
    expect(ENFORCE_LEVELS).toEqual(['observe', 'warn', 'enforce']);
    expect(ENFORCE_DEFAULTS.default).toBe('observe');
    const levels: EnforceLevel[] = [...ENFORCE_LEVELS];
    const meta: SpecMeta = { extra: {}, enforce: levels[1] };
    expect(meta.enforce).toBe('warn');
    expect(({ extra: {} } as SpecMeta).enforce).toBeUndefined();
  });
});
