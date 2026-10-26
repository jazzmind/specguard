import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  NOTE_HARD_LIMIT,
  NOTE_SOFT_LIMIT,
  compactLedger,
  expandNote,
  fitNote,
  mergeNotes,
  noteDigest,
  parseNote,
  serializeNote,
  type NoteRow,
  type ProofNote,
} from '../../src/core/proof-note.js';
import { effectiveVerdict, mergeLayerRecord, type ProofLedger, type ProofRecord } from '../../src/core/proof-ledger.js';
import type { EvidenceLayer } from '../../src/core/test-layers.js';

const COMMIT = 'a'.repeat(40);
const HASH = (c: string): string => c.repeat(64);

function row(over: Partial<NoteRow> = {}): NoteRow {
  return {
    claim: 'capabilities/cart#fee',
    layer: 'unit',
    verdict: 'proven',
    runId: 'run-1',
    specHash: HASH('f'),
    hashVersion: 2,
    files: ['src/cart.ts'],
    exercised: 3,
    counterexamples: 0,
    provedAt: COMMIT,
    ingestedAt: '2026-10-25T00:00:00.000Z',
    ...over,
  };
}

function note(over: Partial<ProofNote> = {}): ProofNote {
  return {
    schema: 'specguard.proof-note',
    version: 1,
    commit: COMMIT,
    tree: 'b'.repeat(40),
    parents: ['c'.repeat(40)],
    createdAt: '2026-10-25T00:00:00.000Z',
    tool: { specguard: '0.6.0', node: '22.0.0', hashVersion: 2 },
    ci: { provider: 'github', event: 'pull_request', repo: 'o/r', ref: 'feat/x', actor: 'ci-bot', runId: '1', runAttempt: 1, pr: 7 },
    files: { 'src/cart.ts': HASH('d') },
    deps: 'e'.repeat(16),
    rows: [row()],
    approvals: [],
    countersigns: [],
    statement: {
      level: 'certified',
      counts: { certified: 1, provisional: 0, 'not-certified': 0, planned: 0 },
      capabilities: [{ id: 'cart', level: 'certified', enforce: 'warn', pillars: { approved: 'ok', testable: 'ok', aligned: 'ok', conforms: 'ok' } }],
    },
    changes: [],
    ...over,
  };
}

const approval = (over: Partial<ProofNote['approvals'][number]> = {}): ProofNote['approvals'][number] => ({
  claim: 'capabilities/cart#fee',
  hash: '0123456789abcdef',
  method: 'pr',
  by: 'alice',
  pr: 7,
  reviewId: 99,
  reviewedAt: COMMIT,
  date: '2026-10-25',
  ...over,
});

function record(claim: string, verdict: ProofRecord['verdict'], files: Record<string, string>, over: Partial<ProofRecord> = {}): ProofRecord {
  return {
    claim,
    verdict,
    runId: 'run-1',
    specHash: HASH('f'),
    claimHash: HASH('9'),
    hashVersion: 2,
    repoSha: COMMIT,
    fileHashes: files,
    exercised: 2,
    counterexamples: 0,
    ingestedAt: '2026-10-25T00:00:00.000Z',
    origin: 'local',
    ...over,
  };
}

function ledgerOf(entries: Array<[ProofRecord, EvidenceLayer]>): ProofLedger {
  const proofs: Record<string, ProofRecord> = {};
  for (const [rec, layer] of entries) proofs[rec.claim] = mergeLayerRecord(proofs[rec.claim], rec, layer);
  return { version: 1, proofs };
}

describe('proof note serialization [proof-store]', () => {
  // [claims: capabilities/proof-store#note-serialize-canonical]
  it('serializeNote is byte-stable for equal input', () => {
    const a = note({ rows: [row({ claim: 'capabilities/b#x' }), row({ claim: 'capabilities/a#x' }), row({ claim: 'capabilities/a#x', layer: 'e2e' })] });
    // Same note built with its keys and rows in another order.
    const reordered = JSON.parse(JSON.stringify(a)) as ProofNote;
    reordered.rows.reverse();
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse()) as unknown as ProofNote;
    shuffled.rows = shuffled.rows.map((r) => Object.fromEntries(Object.entries(r).reverse()) as unknown as NoteRow);

    const text = serializeNote(a);
    expect(serializeNote(shuffled)).toBe(text);
    expect(serializeNote(a)).toBe(text);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd()).not.toContain('\n');
    const parsed = JSON.parse(text) as ProofNote;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    expect(parsed.rows.map((r) => `${r.claim}/${r.layer}`)).toEqual(['capabilities/a#x/e2e', 'capabilities/a#x/unit', 'capabilities/b#x/unit']);
  });

  // [claims: capabilities/proof-store#note-serialize-canonical]
  it('leaves undefined members out of the bytes', () => {
    const withUndefined = note({ deps: undefined, rows: [row({ claimHash: undefined })] });
    expect(serializeNote(withUndefined)).toBe(serializeNote(note({ deps: undefined, rows: [row()] })));
    expect(serializeNote(withUndefined)).not.toContain('claimHash');
  });

  // [claims: capabilities/proof-store#note-digest-stable]
  it('noteDigest is the sha256 of the serialized bytes, equal for equal notes and different for a changed one', () => {
    const text = serializeNote(note());
    expect(noteDigest(text)).toBe(createHash('sha256').update(text).digest('hex'));
    expect(noteDigest(text)).toMatch(/^[0-9a-f]{64}$/);
    expect(noteDigest(serializeNote(note()))).toBe(noteDigest(text));
    expect(noteDigest(serializeNote(note({ rows: [row({ verdict: 'failed' })] })))).not.toBe(noteDigest(text));
  });

  // [claims: capabilities/proof-store#note-digest-stable]
  it('the digest survives a parse and serialize round trip', () => {
    const text = serializeNote(note({ approvals: [approval()] }));
    const parsed = parseNote(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(noteDigest(serializeNote(parsed.note))).toBe(noteDigest(text));
  });
});

describe('proof note parsing [proof-store]', () => {
  // [claims: capabilities/proof-store#note-parse-defensive]
  it('parseNote accepts a complete note and keeps unknown fields', () => {
    const extended = { ...note(), futureTop: { a: 1 }, rows: [{ ...row(), evidencePath: 'out/x.json' }] };
    const parsed = parseNote(JSON.stringify(extended));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((parsed.note as unknown as Record<string, unknown>).futureTop).toEqual({ a: 1 });
    expect((parsed.note.rows[0] as unknown as Record<string, unknown>).evidencePath).toBe('out/x.json');
    expect(JSON.parse(serializeNote(parsed.note)).futureTop).toEqual({ a: 1 });
  });

  // [claims: capabilities/proof-store#note-parse-defensive]
  it('parseNote reports not-json, wrong-schema and invalid without throwing', () => {
    expect(parseNote('not json {')).toMatchObject({ ok: false, reason: 'not-json' });
    expect(parseNote('')).toMatchObject({ ok: false, reason: 'not-json' });
    for (const text of ['null', '[]', '42', '"x"', '{}', JSON.stringify({ ...note(), schema: 'something.else' })]) {
      expect(parseNote(text), text).toMatchObject({ ok: false, reason: 'wrong-schema' });
    }
    const missing = JSON.parse(JSON.stringify(note())) as Record<string, unknown>;
    delete missing.rows;
    const noVersion = JSON.parse(JSON.stringify(note())) as Record<string, unknown>;
    delete noVersion.version;
    const badHash = note({ approvals: [approval({ hash: 'xyz' })] });
    for (const bad of [missing, noVersion, badHash, { ...note(), version: 0 }, { ...note(), version: 'one' }]) {
      const result = parseNote(JSON.stringify(bad));
      expect(result).toMatchObject({ ok: false, reason: 'invalid' });
      if (!result.ok) expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  // [claims: capabilities/proof-store#note-newer-version]
  it('parseNote reports a newer version before checking the shape', () => {
    const newer = parseNote(JSON.stringify({ ...note(), version: 2 }));
    expect(newer).toMatchObject({ ok: false, reason: 'newer-version' });
    // A newer note may have a shape this reader cannot validate; it is still reported as newer, never invalid or thrown.
    const different = parseNote(JSON.stringify({ schema: 'specguard.proof-note', version: 7, rows: 'a different layout' }));
    expect(different).toMatchObject({ ok: false, reason: 'newer-version' });
    if (!different.ok) expect(different.detail).toContain('7');
  });

  // [claims: capabilities/proof-store#note-newer-version]
  it('a wrong schema wins over a newer version', () => {
    expect(parseNote(JSON.stringify({ schema: 'other', version: 9 }))).toMatchObject({ ok: false, reason: 'wrong-schema' });
  });
});

describe('proof note and ledger [proof-store]', () => {
  const shared = { 'src/a.ts': HASH('1'), 'src/b.ts': HASH('2'), 'src/c.ts': HASH('3') };

  // [claims: capabilities/proof-store#note-compact-files-once]
  it('compactLedger stores each file hash once and rows list sorted paths', () => {
    const ledger = ledgerOf([
      [record('capabilities/x#one', 'proven', shared), 'unit'],
      [record('capabilities/x#two', 'proven', { 'src/c.ts': HASH('3'), 'src/a.ts': HASH('1') }), 'unit'],
      [record('capabilities/x#two', 'proven', shared, { runId: 'run-2' }), 'e2e'],
    ]);
    const { files, rows, deps } = compactLedger(ledger, { commit: COMMIT, deps: 'd'.repeat(16) });
    expect(files).toEqual(shared);
    expect(Object.keys(files)).toHaveLength(3);
    expect(deps).toBe('d'.repeat(16));
    expect(rows.map((r) => `${r.claim}/${r.layer}`)).toEqual(['capabilities/x#one/unit', 'capabilities/x#two/e2e', 'capabilities/x#two/unit']);
    expect(rows[2].files).toEqual(['src/a.ts', 'src/c.ts']);
    expect(JSON.stringify(rows)).not.toContain(HASH('1'));
    expect(rows[0]).toMatchObject({ provedAt: COMMIT, hashVersion: 2, claimHash: HASH('9'), exercised: 2 });
  });

  // [claims: capabilities/proof-store#note-compact-files-once]
  it('compactLedger reads a row written before layers existed, defaults hashVersion and omits deps when none', () => {
    const legacy = record('capabilities/x#old', 'proven', {}, { hashVersion: undefined, repoSha: undefined, claimHash: undefined });
    const out = compactLedger({ version: 1, proofs: { [legacy.claim]: legacy } }, { commit: COMMIT });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ layer: 'unclassified', hashVersion: 1, provedAt: COMMIT, files: [] });
    expect('deps' in out).toBe(false);
    expect('claimHash' in out.rows[0]).toBe(false);
  });

  // [claims: capabilities/proof-store#note-expand-origin-ci]
  it('expandNote rehydrates fileHashes, origin ci, repoSha = provedAt', () => {
    const other = 'b'.repeat(40);
    const n = note({
      files: { 'src/a.ts': HASH('1'), 'src/b.ts': HASH('2') },
      rows: [row({ claim: 'capabilities/x#one', files: ['src/a.ts', 'src/b.ts'], provedAt: other, claimHash: HASH('9'), evidence: 'test' }), row({ claim: 'capabilities/x#two', files: ['src/a.ts', 'src/gone.ts'] })],
    });
    const ledger = expandNote(n);
    expect(ledger.version).toBe(1);
    const one = ledger.proofs['capabilities/x#one'];
    expect(one).toMatchObject({ origin: 'ci', repoSha: other, fileHashes: { 'src/a.ts': HASH('1'), 'src/b.ts': HASH('2') }, dependencyFingerprint: n.deps, hashVersion: 2, evidence: 'test', repo: 'o/r' });
    expect(one.layers?.unit).toMatchObject({ origin: 'ci', repoSha: other, fileHashes: { 'src/a.ts': HASH('1'), 'src/b.ts': HASH('2') } });
    // A path the table does not hold is left out rather than invented.
    expect(ledger.proofs['capabilities/x#two'].fileHashes).toEqual({ 'src/a.ts': HASH('1') });
  });

  // [claims: capabilities/proof-store#note-expand-origin-ci]
  it('expandNote keeps one layer per row and lets a failing layer decide the claim', () => {
    const n = note({
      rows: [
        row({ layer: 'unit', verdict: 'proven', ingestedAt: '2026-10-25T02:00:00.000Z' }),
        row({ layer: 'e2e', verdict: 'failed', runId: 'run-2', ingestedAt: '2026-10-25T01:00:00.000Z' }),
      ],
    });
    const rec = expandNote(n).proofs['capabilities/cart#fee'];
    expect(Object.keys(rec.layers ?? {}).sort()).toEqual(['e2e', 'unit']);
    expect(rec.verdict).toBe('failed');
    expect(rec.origin).toBe('ci');
  });

  // [claims: capabilities/proof-store#note-roundtrip-verdicts]
  it('round trip ledger -> note -> ledger keeps effective verdicts', () => {
    const ledger = ledgerOf([
      [record('capabilities/x#proven', 'proven', shared), 'unit'],
      [record('capabilities/x#failing', 'failed', { 'src/a.ts': HASH('1') }), 'unit'],
      [record('capabilities/x#mixed', 'proven', shared), 'unit'],
      [record('capabilities/x#mixed', 'failed', shared, { runId: 'run-2', ingestedAt: '2026-10-25T01:00:00.000Z' }), 'e2e'],
      [record('capabilities/x#drifted', 'proven', { 'src/a.ts': HASH('1') }), 'unit'],
    ]);
    const compact = compactLedger(ledger, { commit: COMMIT });
    const text = serializeNote(note({ ...compact }));
    const parsed = parseNote(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const back = expandNote(parsed.note);

    const current = (hashes: Record<string, string>) => ({ specHash: HASH('f'), claimHash: HASH('9'), fileHashes: hashes });
    for (const claim of Object.keys(ledger.proofs)) {
      for (const hashes of [shared, { ...shared, 'src/a.ts': HASH('0') }]) {
        expect(effectiveVerdict(back.proofs[claim], current(hashes)), claim).toBe(effectiveVerdict(ledger.proofs[claim], current(hashes)));
      }
    }
    expect(Object.keys(back.proofs).sort()).toEqual(Object.keys(ledger.proofs).sort());
    expect(effectiveVerdict(back.proofs['capabilities/x#drifted'], current({ ...shared, 'src/a.ts': HASH('0') }))).toBe('stale');
  });
});

describe('proof note limits [proof-store]', () => {
  const manyRows = (count: number, extra?: Record<string, unknown>): NoteRow[] =>
    Array.from({ length: count }, (_, i) => ({ ...row({ claim: `capabilities/spec-${String(i).padStart(6, '0')}#claim-${i}`, exercised: 12, counterexamples: 3 }), ...extra }));

  // [claims: capabilities/proof-store#note-size-limits]
  it('fitNote leaves a note within the soft limit unchanged', () => {
    const n = note();
    const fitted = fitNote(n);
    expect('refused' in fitted).toBe(false);
    if ('refused' in fitted) return;
    expect(fitted.note).toBe(n);
    expect(fitted.serialized).toBe(serializeNote(n));
    expect(fitted.warnings).toEqual([]);
  });

  // [claims: capabilities/proof-store#note-size-limits]
  it('fitNote strips optional fields above the soft limit and warns', () => {
    const n = note({ rows: manyRows(2500, { evidencePath: `.specguard/evidence/${'p'.repeat(200)}.json`, runner: { name: 'vitest', args: ['--run', 'x'.repeat(50)] } }) });
    expect(Buffer.byteLength(serializeNote(n))).toBeGreaterThan(NOTE_SOFT_LIMIT);
    const fitted = fitNote(n);
    expect('refused' in fitted).toBe(false);
    if ('refused' in fitted) return;
    expect(Buffer.byteLength(fitted.serialized)).toBeLessThanOrEqual(NOTE_SOFT_LIMIT);
    expect(fitted.serialized).not.toContain('evidencePath');
    expect(fitted.serialized).not.toContain('vitest');
    expect(fitted.warnings).toHaveLength(1);
    expect(fitted.warnings[0]).toContain('soft limit');
    // The counts survive when the first step was enough, and the input is not changed.
    expect(fitted.note.rows[0]).toMatchObject({ exercised: 12, counterexamples: 3 });
    expect(JSON.stringify(n.rows[0])).toContain('evidencePath');
    // What is kept still parses and has the same bytes the result reports.
    expect(parseNote(fitted.serialized).ok).toBe(true);
    expect(serializeNote(fitted.note)).toBe(fitted.serialized);
  });

  // [claims: capabilities/proof-store#note-size-limits]
  it('fitNote zeroes the counts next and warns again when the note is still over the soft limit', () => {
    const n = note({ rows: manyRows(5000) });
    const fitted = fitNote(n);
    expect('refused' in fitted).toBe(false);
    if ('refused' in fitted) return;
    expect(fitted.note.rows.every((r) => r.exercised === 0 && r.counterexamples === 0)).toBe(true);
    expect(fitted.warnings.length).toBe(2);
    expect(fitted.warnings[1]).toContain('still over');
    expect(fitNote(n).serialized).toBe(fitted.serialized);
  });

  // [claims: capabilities/proof-store#note-size-limits]
  it('fitNote refuses a note above the hard limit and reports its size', () => {
    const big = note({ files: { ['p'.repeat(NOTE_HARD_LIMIT + 1)]: HASH('d') } });
    const fitted = fitNote(big);
    expect('refused' in fitted).toBe(true);
    if ('refused' in fitted) expect(fitted.bytes).toBeGreaterThan(NOTE_HARD_LIMIT);
  });
});

describe('proof note merge [proof-store]', () => {
  const T1 = '2026-10-25T01:00:00.000Z';
  const T2 = '2026-10-25T02:00:00.000Z';

  // [claims: capabilities/proof-store#note-merge-deterministic]
  it('mergeNotes: newer evidence wins per claim and layer', () => {
    const a = note({
      createdAt: T1,
      rows: [row({ claim: 'capabilities/x#one', verdict: 'failed', runId: 'run-a', ingestedAt: T1 }), row({ claim: 'capabilities/x#two', runId: 'run-a', ingestedAt: T1 })],
    });
    const b = note({
      createdAt: T2,
      rows: [row({ claim: 'capabilities/x#one', verdict: 'proven', runId: 'run-b', ingestedAt: T2 }), row({ claim: 'capabilities/x#three', runId: 'run-b', ingestedAt: T2 })],
    });
    const merged = mergeNotes(a, b);
    const by = Object.fromEntries(merged.rows.map((r) => [r.claim, r]));
    expect(by['capabilities/x#one']).toMatchObject({ verdict: 'proven', runId: 'run-b' });
    expect(Object.keys(by).sort()).toEqual(['capabilities/x#one', 'capabilities/x#three', 'capabilities/x#two']);
    expect(merged.createdAt).toBe(T2);
  });

  // [claims: capabilities/proof-store#note-merge-deterministic]
  it('mergeNotes: layers of one claim are kept apart', () => {
    const a = note({ rows: [row({ layer: 'unit', runId: 'run-a', ingestedAt: T2 })] });
    const b = note({ rows: [row({ layer: 'e2e', runId: 'run-b', ingestedAt: T1 })] });
    expect(mergeNotes(a, b).rows.map((r) => r.layer)).toEqual(['e2e', 'unit']);
  });

  // [claims: capabilities/proof-store#note-merge-deterministic]
  it('mergeNotes: a failure from the same run id beats a later pass', () => {
    const failed = note({ rows: [row({ verdict: 'failed', runId: 'run-a', ingestedAt: T1 })] });
    const passed = note({ rows: [row({ verdict: 'proven', runId: 'run-a', ingestedAt: T2 })] });
    expect(mergeNotes(failed, passed).rows[0].verdict).toBe('failed');
    expect(mergeNotes(passed, failed).rows[0].verdict).toBe('failed');
  });

  // [claims: capabilities/proof-store#note-merge-deterministic]
  it('mergeNotes: approvals, countersigns and changes union; files follow the kept rows', () => {
    const a = note({
      files: { 'src/a.ts': HASH('1') },
      rows: [row({ claim: 'capabilities/x#one', files: ['src/a.ts'] })],
      approvals: [approval(), approval({ reviewId: 100, by: 'bob' })],
      countersigns: [{ entry: 'e1', method: 'command', status: 'countersigned', by: 'alice', pr: 7 }],
      changes: [{ id: 'c1', kind: 'feature', verdict: 'pass', claims: ['capabilities/x#one'] }],
    });
    const b = note({
      createdAt: '2026-10-25T03:00:00.000Z',
      files: { 'src/a.ts': HASH('1'), 'src/z.ts': HASH('4'), 'src/orphan.ts': HASH('5') },
      rows: [row({ claim: 'capabilities/x#two', files: ['src/z.ts'] })],
      approvals: [approval(), approval({ hash: 'fedcba9876543210' })],
      countersigns: [{ entry: 'e1', method: 'command', status: 'self-approved' }, { entry: 'e2', method: 'plan', status: 'inherited' }],
      changes: [{ id: 'c1', kind: 'feature', verdict: 'fail', claims: [] }, { id: 'c2', kind: 'refactor', verdict: 'pass', claims: [] }],
    });
    const merged = mergeNotes(a, b);
    expect(merged.approvals).toHaveLength(3);
    expect(merged.approvals.filter((x) => x.reviewId === 99 && x.hash === '0123456789abcdef')).toHaveLength(1);
    expect(merged.countersigns.map((c) => [c.entry, c.status])).toEqual([['e1', 'self-approved'], ['e2', 'inherited']]);
    expect(merged.changes.map((c) => [c.id, c.verdict])).toEqual([['c1', 'fail'], ['c2', 'pass']]);
    expect(merged.files).toEqual({ 'src/a.ts': HASH('1'), 'src/z.ts': HASH('4') });
    expect(parseNote(serializeNote(merged)).ok).toBe(true);
  });

  // [claims: capabilities/proof-store#note-merge-deterministic]
  it('mergeNotes is commutative, idempotent and leaves its inputs alone', () => {
    const a = note({
      createdAt: T1,
      rows: [row({ claim: 'capabilities/x#one', runId: 'run-a', ingestedAt: T1 }), row({ claim: 'capabilities/x#two', verdict: 'failed', runId: 'run-a', ingestedAt: T1 })],
      approvals: [approval()],
    });
    const b = note({
      createdAt: T2,
      rows: [row({ claim: 'capabilities/x#one', verdict: 'failed', runId: 'run-b', ingestedAt: T2 }), row({ claim: 'capabilities/x#two', runId: 'run-b', ingestedAt: T2 })],
      approvals: [approval({ reviewId: 5 })],
    });
    const before = [serializeNote(a), serializeNote(b)];
    expect(serializeNote(mergeNotes(a, b))).toBe(serializeNote(mergeNotes(b, a)));
    expect([serializeNote(a), serializeNote(b)]).toEqual(before);
    const once = mergeNotes(a, b);
    expect(serializeNote(mergeNotes(once, once))).toBe(serializeNote(once));
    expect(serializeNote(mergeNotes(once, a))).toBe(serializeNote(mergeNotes(a, once)));
  });

  // [claims: capabilities/proof-store#note-merge-deterministic]
  it('mergeNotes breaks a same-instant tie the same way in both orders', () => {
    const a = note({ rows: [row({ verdict: 'proven', runId: 'run-a', ingestedAt: T1 })] });
    const b = note({ rows: [row({ verdict: 'failed', runId: 'run-b', ingestedAt: T1 })] });
    const c = note({ rows: [row({ verdict: 'proven', runId: 'run-c', ingestedAt: T1 })] });
    expect(mergeNotes(a, b).rows[0].verdict).toBe('failed');
    expect(serializeNote(mergeNotes(a, b))).toBe(serializeNote(mergeNotes(b, a)));
    expect(mergeNotes(a, c).rows[0].runId).toBe('run-c');
    expect(serializeNote(mergeNotes(a, c))).toBe(serializeNote(mergeNotes(c, a)));
  });
});
