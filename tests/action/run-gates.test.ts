import { describe, it, expect } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

// @ts-expect-error plain ESM script without type declarations
import { argsFor, averageAlignment, buildComment, COMMENT_MARKER, DEFAULT_FAIL_ON, DEFAULT_GATES, evaluate, GATES, main, metricsOf, parseProofCounts, POINTER_BODY, postComment, previousMetrics, PROVE_FAIL_ON, resolveFailOn, resolveGates, splitList, usesPhase3Features } from '../../action/run-gates.mjs';

const root = path.join(__dirname, '..', '..');

describe('action.yml', () => {
  const action = parseYaml(readFileSync(path.join(root, 'action.yml'), 'utf8')) as {
    inputs: Record<string, { default?: string }>;
    outputs: Record<string, unknown>;
    runs: { using: string; steps: Array<{ uses?: string; run?: string; with?: Record<string, string>; env?: Record<string, string> }> };
  };

  // [claims: capabilities/integration-surfaces#action-gates]
  it('is a composite action with the documented inputs', () => {
    expect(action.runs.using).toBe('composite');
    for (const name of ['version', 'gates', 'fail-on', 'results', 'run-id', 'drift-since', 'validate-url', 'upload-evidence', 'working-directory']) {
      expect(action.inputs).toHaveProperty(name);
    }
    expect(action.inputs['fail-on'].default).toBe(DEFAULT_FAIL_ON);
    expect(Object.keys(action.outputs)).toEqual(['remediate-exit', 'failed', 'tripped']);
  });

  // [claims: capabilities/integration-surfaces#action-gates]
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
  // [claims: capabilities/integration-surfaces#action-fail-on]
  it('parses lists and the PROOFS summary line', () => {
    expect(splitList('a, b\nc')).toEqual(['a', 'b', 'c']);
    expect(parseProofCounts(['x', 'PROOFS: 3 proven, 1 failed, 2 error, 4 unexercised, 5 stale, 6 unproven'])).toMatchObject({
      proven: 3, failed: 1, error: 2, unexercised: 4, stale: 5, unproven: 6, ledger: true,
    });
    expect(parseProofCounts(['PROOFS: no ledger']).ledger).toBe(true);
    expect(parseProofCounts([]).ledger).toBe(false);
  });

  // [claims: capabilities/integration-surfaces#action-fail-on]
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

  // [claims: capabilities/integration-surfaces#action-fail-on]
  it('error verdicts count as failed proofs, and gates that did not run never trip', () => {
    const proofErr = { proof: { ran: true, exitCode: 2, messages: ['PROOFS: 0 proven, 0 failed, 1 error, 0 unexercised, 0 stale, 0 unproven'] } };
    expect(evaluate(proofErr, ['proof-failed']).tripped).toEqual(['proof-failed']);
    expect(evaluate({ status: { ran: false, exitCode: 4 } }, ['missing-specs']).tripped).toEqual([]);
  });

  // [claims: capabilities/integration-surfaces#action-fail-on]
  it('a missing ledger is a note, not a failure', () => {
    const out = evaluate({ proof: { ran: true, exitCode: 0, messages: ['PROOFS: no ledger'] } }, ['proof-failed']);
    expect(out.tripped).toEqual([]);
    expect(out.notes).toEqual([]);
    const none = evaluate({ proof: { ran: true, exitCode: 0, messages: [] } }, ['proof-stale']);
    expect(none.notes[0]).toMatch(/no proof ledger/);
  });

  // [claims: capabilities/integration-surfaces#action-fail-on]
  it('align-below compares the average score', () => {
    expect(averageAlignment({ entries: [{ alignmentScore: 100 }, { alignmentScore: 50 }] })).toBe(75);
    expect(averageAlignment({ entries: [] })).toBeNull();
    expect(evaluate({ align: { ran: true, exitCode: 0, alignAverage: 70 } }, ['align-below:80']).tripped).toEqual(['align-below:80 (average 70%)']);
    expect(evaluate({ align: { ran: true, exitCode: 0, alignAverage: 90 } }, ['align-below:80']).tripped).toEqual([]);
    expect(evaluate({}, ['mystery']).notes[0]).toMatch(/unknown fail-on rule/);
  });

  // [claims: capabilities/integration-surfaces#action-gates]
  it('builds the CLI arguments per gate', () => {
    expect(argsFor('status', {})).toEqual(['status']);
    expect(argsFor('drift', { SG_DRIFT_SINCE: 'origin/main' })).toEqual(['drift', '--since', 'origin/main']);
    expect(argsFor('proof', {})).toEqual(['proof', 'status']);
    expect(argsFor('results', {})).toBeNull();
    expect(argsFor('results', { SG_RESULTS: 'a.json\nb/*.xml', SG_RUN_ID: '7-1' })).toEqual(['results', 'ingest', 'a.json', 'b/*.xml', '--run-id', '7-1']);
    expect(argsFor('validate', { SG_VALIDATE_URL: 'https://stg' })).toEqual(['validate', '--all', '--url', 'https://stg']);
  });

  it('builds the arguments for the gates of the functional-spec commands [new-gates]', () => {
    expect(argsFor('check', {})).toEqual(['check']);
    expect(argsFor('test', {})).toEqual(['test', 'run']);
    expect(argsFor('test', { SG_AFFECTED: 'true', SG_RUN_ID: '9-1' })).toEqual(['test', 'run', '--affected', '--run-id', '9-1']);
    expect(argsFor('test', { SG_AFFECTED: 'false' })).toEqual(['test', 'run']);
    expect(argsFor('verify', { SG_VALIDATE_URL: 'https://stg' })).toEqual(['verify', '--all', '--url', 'https://stg']);
    expect(argsFor('scan', {})).toEqual(['security', 'scan']);
    // The retired deps gate now runs the unified scan; publish writes the snapshot a team server pulls.
    expect(argsFor('deps', {})).toEqual(['security', 'scan']);
    expect(argsFor('publish', {})).toEqual(['publish', '--out', '.specguard/publish/snapshot.json']);
    expect(argsFor('publish', { SG_SERVER_URL: 'http://sandbox/specguard' })).toEqual(['publish', '--out', '.specguard/publish/snapshot.json', '--server', 'http://sandbox/specguard']);
  });

  // [claims: capabilities/integration-surfaces#action-fail-on]
  it('trips the new gates on a non-zero exit, and only when they ran [new-gate-rules]', () => {
    const runs = { check: { ran: true, exitCode: 4 }, test: { ran: true, exitCode: 0 }, verify: { ran: false, exitCode: 2 }, scan: { ran: true, exitCode: 5 }, publish: { ran: true, exitCode: 1 } };
    expect(evaluate(runs, ['check', 'test', 'verify', 'scan', 'publish']).tripped).toEqual(['check', 'scan', 'publish']);
    expect(evaluate(runs, ['none']).tripped).toEqual([]);
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

  // [claims: capabilities/integration-surfaces#action-fail-on, capabilities/integration-surfaces#action-gates]
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

  // [claims: capabilities/integration-surfaces#action-gates]
  it('rejects an unknown gate', () => {
    expect(main({ SG_GATES: 'status,bogus' })).toBe(2);
  });
});

describe('remediate mode', () => {
  // [claims: capabilities/integration-surfaces#action-remediate-and-release]
  it('action.yml exposes mode: remediate without merging', async () => {
    // claim: remediate-mode
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../../action.yml', import.meta.url), 'utf8');
    expect(text).toMatch(/mode:\s*\n\s+description:/);
    expect(text).toContain('specguard remediate $args');
    expect(text).toContain('--pr');
    expect(text).not.toMatch(/gh pr merge|--auto|automerge/i);
  });

  // [claims: capabilities/integration-surfaces#action-affected-since]
  it('measures affected units against the pull request base, not the working tree [affected-since]', () => {
    // On a clean checkout `--affected` alone compares the working tree with HEAD: nothing changed, nothing tested.
    expect(argsFor('test', { SG_AFFECTED: 'true', SG_BASE_REF: 'abc123' })).toEqual(['test', 'run', '--affected', '--since', 'abc123']);
    expect(argsFor('test', { SG_AFFECTED: 'true', SG_BASE_REF: 'abc123', SG_AFFECTED_SINCE: 'origin/main' })).toEqual(['test', 'run', '--affected', '--since', 'origin/main']);
    expect(argsFor('test', { SG_AFFECTED: 'true', SG_AFFECTED_SINCE: '' })).toEqual(['test', 'run', '--affected']);
    expect(argsFor('test', { SG_BASE_REF: 'abc123' })).toEqual(['test', 'run']);
  });

  // [claims: capabilities/integration-surfaces#action-fail-on]
  it('trips proof-incomplete on claims missing a required layer, and counts none from an older CLI [proof-incomplete]', () => {
    const messages = [
      '  [proof-incomplete] capabilities/auth#login (missing: e2e)',
      '  [proof-incomplete] capabilities/auth#logout (missing: unit)',
      'PROOFS: 5 proven, 0 failed, 0 error, 0 unexercised, 0 stale, 0 unproven',
    ];
    expect(parseProofCounts(messages).incomplete).toBe(2);
    expect(evaluate({ proof: { ran: true, exitCode: 0, messages } }, ['proof-incomplete']).tripped).toEqual(['proof-incomplete']);
    expect(evaluate({ proof: { ran: true, exitCode: 0, messages } }, ['proof-failed']).tripped).toEqual([]);
    const older = ['PROOFS: 5 proven, 0 failed, 0 error, 0 unexercised, 0 stale, 0 unproven'];
    expect(parseProofCounts(older).incomplete).toBe(0);
    expect(evaluate({ proof: { ran: true, exitCode: 0, messages: older } }, ['proof-incomplete']).tripped).toEqual([]);
  });

  // [claims: capabilities/integration-surfaces#action-pr-comment]
  it('reads the numbers a run printed, and shows how each moved since the last comment [comment-metrics]', () => {
    const runs = {
      check: { ran: true, exitCode: 0, messages: ['TOTAL: 120 source files, 110 specs (92%), 90 tests (75%), 10 missing specs'] },
      proof: { ran: true, exitCode: 0, messages: ['  [proof-incomplete] x#a (missing: e2e)', 'PROOFS: 40 proven, 2 failed, 0 error, 0 unexercised, 3 stale, 5 unproven', 'LAYERS: unit 38/40  e2e 1/4; 1 claim(s) missing a required layer'] },
      scan: { ran: true, exitCode: 5, messages: ['security scan: 4 item(s), 2 unresolved at or above high; plan scan-1'] },
    };
    expect(metricsOf(runs)).toEqual({
      sourceFiles: 120, specPct: 92, testedPct: 75, missingSpecs: 10,
      proven: 40, failed: 2, stale: 3, unproven: 5, incomplete: 1, layers: { unit: [38, 40], e2e: [1, 4] },
      findings: 4, unresolved: 2,
    });
    expect(metricsOf({})).toEqual({});
    const body = buildComment(runs, ['proof-failed'], ['a note'], { proven: 35, failed: 2, unresolved: 5, specPct: 92 });
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain('**Failed on:** proof-failed');
    expect(body).toContain('| Claims proven | 40 | ▲ better (35 → 40) |');
    expect(body).toContain('| Unresolved findings | 2 | ▲ better (5 → 2) |'); // fewer findings is better
    expect(body).toMatch(/\| Claims failed \| 2 \|\s+\|/); // unchanged: no arrow
    expect(body).toContain('Proof by layer: unit 38/40 · e2e 1/4');
    expect(previousMetrics(body)?.proven).toBe(40);
    expect(previousMetrics('no marker')).toBeUndefined();
    expect(buildComment({ proof: { ran: true, exitCode: 0, messages: ['PROOFS: 5 proven, 0 failed, 0 error, 0 unexercised, 0 stale, 0 unproven'] } }, [], [], { proven: 9 })).toContain('| Claims proven | 5 | ▼ worse (9 → 5) |');
  });

  // [claims: capabilities/integration-surfaces#action-pr-comment]
  it('posts one comment, updates it on the next run, and never throws [comment-post]', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-event-'));
    const event = path.join(dir, 'event.json');
    writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
    const env = { SG_GITHUB_TOKEN: 't', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'o/r' };
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fakeFetch = (existing: unknown[]) => async (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body });
      if (!init.method) return { ok: true, status: 200, json: async () => existing };
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const first = await postComment(env, (prev: unknown) => `body ${prev === undefined ? 'fresh' : 'again'}`, fakeFetch([{ id: 1, body: 'someone else' }]) as never);
    expect(first).toEqual({ posted: true, updated: false });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: 'https://api.github.com/repos/o/r/issues/7/comments', body: JSON.stringify({ body: 'body fresh' }) });

    calls.length = 0;
    const second = await postComment(env, (prev: unknown) => `body ${JSON.stringify(prev)}`, fakeFetch([{ id: 9, body: `${COMMENT_MARKER}\n<!-- specguard-metrics: {"proven":3} -->` }]) as never);
    expect(second).toEqual({ posted: true, updated: true });
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', url: 'https://api.github.com/repos/o/r/issues/comments/9' });
    expect(calls.at(-1)?.body).toContain('{\\"proven\\":3}');

    expect((await postComment({ ...env, GITHUB_EVENT_NAME: 'push' }, () => 'x', fakeFetch([]) as never)).posted).toBe(false);
    expect((await postComment({ ...env, SG_GITHUB_TOKEN: '' }, () => 'x', fakeFetch([]) as never)).posted).toBe(false);
    const forbidden = async () => ({ ok: false, status: 403, json: async () => [] });
    expect(await postComment(env, () => 'x', forbidden as never)).toEqual({ posted: false, reason: 'listing comments: HTTP 403' });
    const boom = async () => {
      throw new Error('network down');
    };
    expect(await postComment(env, () => 'x', boom as never)).toEqual({ posted: false, reason: 'network down' });
  });

  // [claims: capabilities/integration-surfaces#action-sarif]
  it('writes SARIF from the scan gate only when asked [scan-sarif]', () => {
    expect(argsFor('scan', {})).toEqual(['security', 'scan']);
    expect(argsFor('scan', { SG_SARIF: 'true' })).toEqual(['security', 'scan', '--sarif']);
    const action = parseYaml(readFileSync(path.join(root, 'action.yml'), 'utf8')) as { inputs: Record<string, { default?: string }>; runs: { steps: Array<{ uses?: string; if?: string }> } };
    expect(action.inputs.comment.default).toBe('true');
    expect(action.inputs.sarif.default).toBe('false');
    const upload = action.runs.steps.find((st) => st.uses?.startsWith('github/codeql-action/upload-sarif'));
    expect(upload?.if).toContain("inputs.sarif == 'true'");
  });
});

describe('the prove gate [action-prove]', () => {
  const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'sg-prove-'));
  const put = (dir: string, rel: string, text: string): void => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };

  // [claims: capabilities/integration-surfaces#action-prove-gate]
  it('runs specguard ci run, with the flags the inputs ask for', () => {
    expect(GATES).toContain('prove');
    expect(argsFor('prove', {})).toEqual(['ci', 'run']);
    expect(argsFor('prove', { SG_FULL: 'true', SG_NOTES: 'false', SG_COMMENT: 'false' })).toEqual(['ci', 'run', '--full', '--no-push', '--no-comment']);
    expect(argsFor('prove', { SG_FULL: 'false', SG_NOTES: 'true', SG_COMMENT: 'true' })).toEqual(['ci', 'run']);
  });

  // [claims: capabilities/integration-surfaces#action-prove-gate]
  it('trips prove on a blocked packet (exit 13) or a run that failed, never when it did not run', () => {
    expect(evaluate({ prove: { ran: true, exitCode: 13 } }, ['prove']).tripped).toEqual(['prove']);
    expect(evaluate({ prove: { ran: true, exitCode: 1 } }, ['prove']).tripped).toEqual(['prove']);
    expect(evaluate({ prove: { ran: true, exitCode: 0 } }, ['prove']).tripped).toEqual([]);
    expect(evaluate({ prove: { ran: false, exitCode: 13 } }, ['prove']).tripped).toEqual([]);
    expect(evaluate({ prove: { ran: true, exitCode: 13 } }, ['none']).tripped).toEqual([]);
  });

  // [claims: capabilities/integration-surfaces#action-prove-gate]
  it('adds prove to the default gates only for a repository that uses the Phase 3 features, and honours the input', () => {
    const uses = (): boolean => true;
    const plain = (): boolean => false;
    expect(resolveGates({}, uses)).toEqual(['status', 'proof', 'prove']);
    expect(resolveGates({}, plain)).toEqual(['status', 'proof']);
    expect(resolveGates({ SG_GATES: DEFAULT_GATES, SG_PROVE: 'auto' }, uses)).toEqual(['status', 'proof', 'prove']);
    // A list the user chose is left alone unless prove is asked for.
    expect(resolveGates({ SG_GATES: 'check,test' }, uses)).toEqual(['check', 'test']);
    expect(resolveGates({ SG_GATES: 'check,test', SG_PROVE: 'true' }, plain)).toEqual(['check', 'test', 'prove']);
    expect(resolveGates({ SG_GATES: 'check,prove', SG_PROVE: 'true' }, plain)).toEqual(['check', 'prove']);
    expect(resolveGates({ SG_GATES: 'check,prove', SG_PROVE: 'false' }, uses)).toEqual(['check']);
    expect(resolveGates({ SG_PROVE: 'false' }, uses)).toEqual(['status', 'proof']);
  });

  // [claims: capabilities/integration-surfaces#action-prove-gate]
  it('replaces the legacy ledger thresholds with prove when prove runs, because a gitignored ledger is not in a fresh checkout', () => {
    expect(PROVE_FAIL_ON).toBe('missing-specs,drift,prove,results');
    expect(resolveFailOn({}, ['status', 'proof', 'prove'])).toBe(PROVE_FAIL_ON);
    expect(resolveFailOn({ SG_FAIL_ON: DEFAULT_FAIL_ON }, ['status', 'proof', 'prove'])).toBe(PROVE_FAIL_ON);
    expect(resolveFailOn({}, ['status', 'proof'])).toBe(DEFAULT_FAIL_ON);
    expect(resolveFailOn({ SG_FAIL_ON: 'proof-stale,prove' }, ['prove'])).toBe('proof-stale,prove');
  });

  // [claims: capabilities/integration-surfaces#action-prove-gate]
  it('recognises a repository that uses proof notes, the change protocol or enforce, and none other', () => {
    const none = tmp();
    expect(usesPhase3Features(none)).toBe(false);
    put(none, '.specguard/config.json', '{"apps":[]}');
    put(none, 'specs/capabilities/a.md', '---\nid: a\nkind: capability\n---\n# A\n');
    expect(usesPhase3Features(none)).toBe(false);

    for (const key of ['proofStore', 'enforce', 'change', 'approvals']) {
      const dir = tmp();
      put(dir, '.specguard/config.json', JSON.stringify({ apps: [], [key]: {} }));
      expect(usesPhase3Features(dir)).toBe(true);
    }
    const spec = tmp();
    put(spec, '.specguard/config.json', '{"apps":[]}');
    put(spec, 'specs/capabilities/a.md', '---\nid: a\nkind: capability\nenforce: warn\n---\n# A\n');
    expect(usesPhase3Features(spec)).toBe(true);
    const body = tmp();
    put(body, '.specguard/config.json', '{"apps":[]}');
    put(body, 'specs/capabilities/a.md', '---\nid: a\n---\n# A\n\nenforce: warn is mentioned in prose\n');
    expect(usesPhase3Features(body)).toBe(false);
    const record = tmp();
    put(record, '.specguard/config.json', '{"apps":[]}');
    put(record, '.specguard/changes/20261026-x-ab12.json', '{}');
    expect(usesPhase3Features(record)).toBe(true);
  });

  // [claims: capabilities/integration-surfaces#action-prove-gate]
  it('leaves one comment per pull request: the legacy comment becomes a pointer, and is never posted when there is none', async () => {
    const dir = tmp();
    const event = path.join(dir, 'event.json');
    writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
    const env = { SG_GITHUB_TOKEN: 't', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'o/r' };
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fakeFetch = (existing: unknown[]) => async (url: string, init: { method?: string; body?: string }) => {
      calls.push({ method: init.method ?? 'GET', url, body: init.body });
      return { ok: true, status: 200, json: async () => (init.method ? {} : existing) };
    };

    const none = await postComment(env, () => POINTER_BODY, fakeFetch([{ id: 1, body: 'someone else' }]) as never, { onlyUpdate: true });
    expect(none).toEqual({ posted: false, reason: 'no earlier comment to update' });
    expect(calls.every((c) => c.method === 'GET')).toBe(true);

    calls.length = 0;
    const had = await postComment(env, () => POINTER_BODY, fakeFetch([{ id: 9, body: `${COMMENT_MARKER}\nold results` }]) as never, { onlyUpdate: true });
    expect(had).toEqual({ posted: true, updated: true });
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', url: 'https://api.github.com/repos/o/r/issues/comments/9' });
    expect(JSON.parse(calls.at(-1)?.body ?? '{}').body).toContain('proof packet below');
    expect(POINTER_BODY).toContain(COMMENT_MARKER);
  });

  // [claims: capabilities/integration-surfaces#action-prove-gate]
  it('end to end with a fake specguard: runs ci run for a repository that uses enforce, fails the job on exit 13, and echoes the run\'s own lines', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-bin-'));
    const bin = path.join(dir, 'specguard');
    const calls = path.join(dir, 'calls.txt');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const args = process.argv.slice(2).filter((a) => a !== '--json');
require('fs').appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
if (args[0] === 'ci') { console.log(JSON.stringify({ failed: 1, messages: ['[ci] packet: blocked', '::warning title=SpecGuard::shop warns'], gate: 'fail', packet: { verdict: 'blocked' }, note: { written: true, pushed: false } })); process.exit(13); }
console.log(JSON.stringify({ failed: 0, messages: [] }));
`,
    );
    chmodSync(bin, 0o755);
    const cwd = tmp();
    put(cwd, '.specguard/config.json', '{"apps":[],"enforce":{"default":"warn"}}');
    writeFileSync(calls, '');
    const summary = path.join(cwd, 'summary.md');
    const prev = process.cwd();
    process.chdir(cwd);
    const log = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => void lines.push(a.join(' '));
    try {
      const code = main({ SG_BIN: bin, GITHUB_STEP_SUMMARY: summary } as never);
      expect(code).toBe(1);
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['status', 'proof status', 'ci run']);
      expect(readFileSync(summary, 'utf8')).toContain('**Failed on:** prove');
      expect(lines).toContain('::warning title=SpecGuard::shop warns');
      expect(JSON.parse(readFileSync(path.join(cwd, '.specguard/ci/prove.json'), 'utf8'))).toMatchObject({ gate: 'prove', exitCode: 13 });

      // The proof note not pushed is reported by default and fails the job only when it is required.
      writeFileSync(calls, '');
      expect(main({ SG_BIN: bin, SG_FAIL_ON: 'none', SG_NOTE_REQUIRED: 'false', GITHUB_STEP_SUMMARY: summary } as never)).toBe(0);
      expect(main({ SG_BIN: bin, SG_FAIL_ON: 'none', SG_NOTE_REQUIRED: 'true', GITHUB_STEP_SUMMARY: summary } as never)).toBe(1);
    } finally {
      console.log = log;
      process.chdir(prev);
    }
  });

  // [claims: capabilities/integration-surfaces#action-prove-gate]
  it('action.yml exposes the inputs and passes them on', () => {
    const action = parseYaml(readFileSync(path.join(root, 'action.yml'), 'utf8')) as {
      inputs: Record<string, { default?: string }>;
      runs: { steps: Array<{ id?: string; env?: Record<string, string> }> };
    };
    expect(action.inputs.prove.default).toBe('auto');
    expect(action.inputs.notes.default).toBe('true');
    expect(action.inputs.full.default).toBe('false');
    expect(action.inputs['note-required'].default).toBe('false');
    // Unchanged on purpose: the legacy default stays, and run-gates swaps it when prove runs.
    expect(action.inputs['fail-on'].default).toBe(DEFAULT_FAIL_ON);
    const env = action.runs.steps.find((st) => st.id === 'gates')?.env ?? {};
    expect(env).toMatchObject({ SG_PROVE: '${{ inputs.prove }}', SG_NOTES: '${{ inputs.notes }}', SG_FULL: '${{ inputs.full }}', SG_NOTE_REQUIRED: '${{ inputs.note-required }}', SG_GITHUB_TOKEN: '${{ inputs.github-token }}' });
  });
});
