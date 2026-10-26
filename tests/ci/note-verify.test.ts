import { describe, expect, it, vi } from 'vitest';

import type { ApiCheckRun } from '../../src/ci/github-api.js';
import { checkRunSummary, digestFromSummary, evaluateCheckRuns, NOTE_CHECK_NAME, verifyNote, verifyNoteWithConfig } from '../../src/ci/note-verify.js';
import type { ProofNote } from '../../src/core/proof-note.js';

const D = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const run = (over: Partial<ApiCheckRun> & { id: number }): ApiCheckRun => ({
  app: { slug: 'github-actions' },
  output: { summary: `note-sha256: ${D}\nschema: 1` },
  check_suite: { head_branch: 'main' },
  ...over,
});
const api = (runs: ApiCheckRun[] | Error) => ({
  listCheckRuns: vi.fn(async () => {
    if (runs instanceof Error) throw runs;
    return runs;
  }),
});

describe('note verification [note-verify]', () => {
  // [claims: capabilities/proof-store#note-verify-opt-in]
  it('off returns unverified without any call', async () => {
    const a = api([run({ id: 1 })]);
    for (const mode of ['off', undefined] as const) {
      const v = await verifyNoteWithConfig(mode, a, 'o/r', 'c1', D);
      expect(v.status).toBe('unverified');
    }
    expect(a.listCheckRuns).not.toHaveBeenCalled();
  });

  // [claims: capabilities/proof-store#note-verify-opt-in]
  it('check-run without a client or repository is unverified and makes no call', async () => {
    expect((await verifyNoteWithConfig('check-run', undefined, 'o/r', 'c1', D)).status).toBe('unverified');
    const a = api([]);
    expect((await verifyNoteWithConfig('check-run', a, undefined, 'c1', D)).status).toBe('unverified');
    expect(a.listCheckRuns).not.toHaveBeenCalled();
  });

  // [claims: capabilities/proof-store#note-verify-check-run-digest]
  it('check-run asks for the named check run on the commit and verifies a matching digest', async () => {
    const a = api([run({ id: 41, output: { summary: `note-sha256: ${OTHER}` } }), run({ id: 42 })]);
    const v = await verifyNoteWithConfig('check-run', a, 'o/r', 'c1', D);
    expect(v).toEqual({ status: 'verified', checkRunId: 42 });
    expect(a.listCheckRuns).toHaveBeenCalledWith('o/r', 'c1', NOTE_CHECK_NAME);
    expect(NOTE_CHECK_NAME).toBe('specguard/proof-note');
  });

  // [claims: capabilities/proof-store#note-verify-check-run-digest]
  it('the digest compares case-insensitively and only on the summary line that carries it', () => {
    expect(evaluateCheckRuns([run({ id: 1, output: { summary: `note-sha256: ${D.toUpperCase()}` } })], D).status).toBe('verified');
    expect(evaluateCheckRuns([run({ id: 1, output: { summary: `see note-sha256: ${D}` } })], D).status).toBe('mismatch');
    expect(digestFromSummary(null)).toBeUndefined();
    expect(digestFromSummary(`x\nnote-sha256: ${D}\ny`)).toBe(D);
  });

  // [claims: capabilities/proof-store#note-verify-mismatch-and-branch]
  it('runs that exist but carry another digest are a mismatch; no run is unverified', () => {
    expect(evaluateCheckRuns([run({ id: 1, output: { summary: `note-sha256: ${OTHER}` } })], D).status).toBe('mismatch');
    expect(evaluateCheckRuns([run({ id: 1, output: { summary: null } })], D).status).toBe('mismatch');
    expect(evaluateCheckRuns([], D).status).toBe('unverified');
  });

  // [claims: capabilities/proof-store#note-verify-mismatch-and-branch]
  it('only the workflow app counts: a run from another app with the right digest does not verify', () => {
    const forged = run({ id: 1, app: { slug: 'some-other-app' } });
    expect(evaluateCheckRuns([forged], D).status).toBe('unverified');
    expect(evaluateCheckRuns([forged, run({ id: 2, output: { summary: `note-sha256: ${OTHER}` } })], D).status).toBe('mismatch');
  });

  // [claims: capabilities/proof-store#note-verify-mismatch-and-branch]
  it('a required branch rejects a run whose suite ran elsewhere', () => {
    const elsewhere = run({ id: 1, check_suite: { head_branch: 'feature' } });
    expect(evaluateCheckRuns([elsewhere], D, { branch: 'main' }).status).toBe('mismatch');
    expect(evaluateCheckRuns([elsewhere, run({ id: 2 })], D, { branch: 'main' })).toEqual({ status: 'verified', checkRunId: 2 });
    expect(evaluateCheckRuns([elsewhere], D).status).toBe('verified');
  });

  // [claims: capabilities/proof-store#note-verify-mismatch-and-branch]
  it('an API failure is not-checked, never verified, and an invalid digest is unverified', async () => {
    const v = await verifyNote(api(Object.assign(new Error('boom'), { status: 502 })), 'o/r', 'c1', D);
    expect(v.status).toBe('not-checked');
    expect(v.detail).toContain('502');
    expect((await verifyNote(api(new Error('boom')), 'o/r', 'c1', D)).status).toBe('not-checked');
    expect(evaluateCheckRuns([run({ id: 1 })], 'not-hex').status).toBe('unverified');
  });

  // [claims: capabilities/proof-store#note-verify-summary]
  it('the summary leads with the digest and round-trips through the reader', () => {
    const note = { version: 1, rows: [{}, {}, {}], statement: { level: 'certified' } } as unknown as ProofNote;
    const text = checkRunSummary(D.toUpperCase(), note);
    expect(text).toBe(`note-sha256: ${D}\nschema: 1\nrows: 3\nlevel: certified`);
    expect(digestFromSummary(text)).toBe(D);
    expect(evaluateCheckRuns([run({ id: 5, output: { summary: text } })], D).status).toBe('verified');
  });
});
