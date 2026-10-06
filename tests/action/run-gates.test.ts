import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

// @ts-expect-error plain ESM script without type declarations
import { argsFor, averageAlignment, DEFAULT_FAIL_ON, evaluate, main, parseProofCounts, splitList } from '../../action/run-gates.mjs';

const root = path.join(__dirname, '..', '..');

describe('action.yml', () => {
  const action = parseYaml(readFileSync(path.join(root, 'action.yml'), 'utf8')) as {
    inputs: Record<string, { default?: string }>;
    outputs: Record<string, unknown>;
    runs: { using: string; steps: Array<{ uses?: string; run?: string; with?: Record<string, string>; env?: Record<string, string> }> };
  };

  it('is a composite action with the documented inputs', () => {
    expect(action.runs.using).toBe('composite');
    for (const name of ['version', 'gates', 'fail-on', 'results', 'run-id', 'drift-since', 'validate-url', 'upload-evidence', 'working-directory']) {
      expect(action.inputs).toHaveProperty(name);
    }
    expect(action.inputs['fail-on'].default).toBe(DEFAULT_FAIL_ON);
    expect(Object.keys(action.outputs)).toEqual(['remediate-exit', 'failed', 'tripped']);
  });

  it('sets up Node, installs specguard-ai@<version>, runs the gates, and uploads evidence without secrets', () => {
    const steps = action.runs.steps;
    expect(steps[0].uses).toMatch(/^actions\/setup-node@/);
    const install = steps.find((s) => s.run?.includes('npm install -g'))!;
    expect(install.run).toContain('specguard-ai@${SG_VERSION}');
    expect(install.run).not.toMatch(/npm install -g specguard( |$)/);
    expect(steps.find((s) => s.run?.includes('run-gates.mjs'))).toBeTruthy();
    const upload = steps.find((s) => s.uses?.startsWith('actions/upload-artifact'))!;
    expect(upload.with?.path).toContain('.specguard/.env');
    expect(upload.with?.path).toContain('.specguard/auth/');
    expect(upload.with?.path).toMatch(/!.*\.env/);
  });
});

describe('gate evaluation', () => {
  it('parses lists and the PROOFS summary line', () => {
    expect(splitList('a, b\nc')).toEqual(['a', 'b', 'c']);
    expect(parseProofCounts(['x', 'PROOFS: 3 proven, 1 failed, 2 error, 4 unexercised, 5 stale, 6 unproven'])).toMatchObject({
      proven: 3, failed: 1, error: 2, unexercised: 4, stale: 5, unproven: 6, ledger: true,
    });
    expect(parseProofCounts(['PROOFS: no ledger']).ledger).toBe(true);
    expect(parseProofCounts([]).ledger).toBe(false);
  });

  it('trips only the thresholds that are configured and violated', () => {
    const runs = {
      status: { ran: true, exitCode: 4 },
      drift: { ran: true, exitCode: 3 },
      proof: { ran: true, exitCode: 2, messages: ['PROOFS: 1 proven, 1 failed, 0 error, 0 unexercised, 2 stale, 0 unproven'] },
      results: { ran: true, exitCode: 2 },
    };
    expect(evaluate(runs, ['missing-specs', 'drift']).tripped).toEqual(['missing-specs', 'drift']);
    expect(evaluate(runs, ['proof-failed', 'proof-stale', 'results']).tripped).toEqual(['proof-failed', 'proof-stale', 'results']);
    expect(evaluate(runs, ['proof-unexercised', 'proof-unproven']).tripped).toEqual([]);
    expect(evaluate(runs, ['none']).tripped).toEqual([]);
    expect(evaluate(runs, DEFAULT_FAIL_ON.split(',')).tripped).toHaveLength(5);
  });

  it('error verdicts count as failed proofs, and gates that did not run never trip', () => {
    const proofErr = { proof: { ran: true, exitCode: 2, messages: ['PROOFS: 0 proven, 0 failed, 1 error, 0 unexercised, 0 stale, 0 unproven'] } };
    expect(evaluate(proofErr, ['proof-failed']).tripped).toEqual(['proof-failed']);
    expect(evaluate({ status: { ran: false, exitCode: 4 } }, ['missing-specs']).tripped).toEqual([]);
  });

  it('a missing ledger is a note, not a failure', () => {
    const out = evaluate({ proof: { ran: true, exitCode: 0, messages: ['PROOFS: no ledger'] } }, ['proof-failed']);
    expect(out.tripped).toEqual([]);
    expect(out.notes).toEqual([]);
    const none = evaluate({ proof: { ran: true, exitCode: 0, messages: [] } }, ['proof-stale']);
    expect(none.notes[0]).toMatch(/no proof ledger/);
  });

  it('align-below compares the average score', () => {
    expect(averageAlignment({ entries: [{ alignmentScore: 100 }, { alignmentScore: 50 }] })).toBe(75);
    expect(averageAlignment({ entries: [] })).toBeNull();
    expect(evaluate({ align: { ran: true, exitCode: 0, alignAverage: 70 } }, ['align-below:80']).tripped).toEqual(['align-below:80 (average 70%)']);
    expect(evaluate({ align: { ran: true, exitCode: 0, alignAverage: 90 } }, ['align-below:80']).tripped).toEqual([]);
    expect(evaluate({}, ['mystery']).notes[0]).toMatch(/unknown fail-on rule/);
  });

  it('builds the CLI arguments per gate', () => {
    expect(argsFor('status', {})).toEqual(['status']);
    expect(argsFor('drift', { SG_DRIFT_SINCE: 'origin/main' })).toEqual(['drift', '--since', 'origin/main']);
    expect(argsFor('proof', {})).toEqual(['proof', 'status']);
    expect(argsFor('results', {})).toBeNull();
    expect(argsFor('results', { SG_RESULTS: 'a.json\nb/*.xml', SG_RUN_ID: '7-1' })).toEqual(['results', 'ingest', 'a.json', 'b/*.xml', '--run-id', '7-1']);
    expect(argsFor('validate', { SG_VALIDATE_URL: 'https://stg' })).toEqual(['validate', '--all', '--url', 'https://stg']);
  });
});

describe('main (end to end with a fake specguard)', () => {
  function fakeBin(script: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-bin-'));
    const file = path.join(dir, 'specguard');
    writeFileSync(file, `#!/usr/bin/env node\n${script}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  it('runs gates, writes per-gate JSON and the summary, and exits 1 when a threshold trips', () => {
    const bin = fakeBin(`
      const args = process.argv.slice(2).filter((a) => a !== '--json');
      if (args[0] === 'proof') { console.log(JSON.stringify({ failed: 1, messages: ['PROOFS: 0 proven, 1 failed, 0 error, 0 unexercised, 0 stale, 0 unproven'] })); process.exit(2); }
      console.log(JSON.stringify({ failed: 0, messages: [] }));
    `);
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'sg-gate-'));
    const summary = path.join(cwd, 'summary.md');
    const output = path.join(cwd, 'output.txt');
    const prev = process.cwd();
    process.chdir(cwd);
    try {
      writeFileSync(summary, '');
      writeFileSync(output, '');
      const code = main({ SG_BIN: bin, SG_GATES: 'status,proof', SG_FAIL_ON: 'proof-failed', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output });
      expect(code).toBe(1);
      expect(readFileSync(summary, 'utf8')).toContain('**Failed on:** proof-failed');
      expect(readFileSync(output, 'utf8')).toContain('failed=true');
      const proofJson = JSON.parse(readFileSync(path.join(cwd, '.specguard/ci/proof.json'), 'utf8'));
      expect(proofJson).toMatchObject({ gate: 'proof', exitCode: 2 });
      writeFileSync(output, '');
      expect(main({ SG_BIN: bin, SG_GATES: 'status', SG_FAIL_ON: 'proof-failed', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output })).toBe(0);
      expect(readFileSync(output, 'utf8')).toContain('failed=false');
    } finally {
      process.chdir(prev);
    }
  });

  it('rejects an unknown gate', () => {
    expect(main({ SG_GATES: 'status,bogus' })).toBe(2);
  });
});

describe('remediate mode', () => {
  it('action.yml exposes mode: remediate without merging', async () => {
    // claim: remediate-mode
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../../action.yml', import.meta.url), 'utf8');
    expect(text).toMatch(/mode:\s*\n\s+description:/);
    expect(text).toContain('specguard remediate $args');
    expect(text).toContain('--pr');
    expect(text).not.toMatch(/gh pr merge|--auto|automerge/i);
  });
});
