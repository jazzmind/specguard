import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { installCommandFor, renderPullRequestWorkflow, renderRemediateWorkflow, WORKFLOW_FILES } from '../../src/core/ci-workflow.js';
import { runInit } from '../../src/pipelines/init.js';

type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { if?: string; steps: Array<{ uses?: string; run?: string; with?: Record<string, string>; env?: Record<string, string> }> }>;
};
const parsed = (text: string): Workflow => parseYaml(text) as Workflow;

describe('generated CI workflows [ci-workflow]', () => {
  // [claims: capabilities/integration-surfaces#init-ci]
  it('gates pull requests with the checkout depth the changed-units test needs and the proof gate; the scan moved to its own job (Phase 3: asserted differently on purpose)', () => {
    const wf = parsed(renderPullRequestWorkflow({ install: 'npm ci', affected: true, requireLayers: true }));
    expect(Object.keys(wf.on)).toEqual(['pull_request', 'push', 'merge_group', 'workflow_dispatch']);
    expect(wf.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
    const steps = wf.jobs.prove.steps;
    expect(steps[0]).toMatchObject({ uses: 'actions/checkout@v4', with: { 'fetch-depth': 0 } });
    expect(steps.some((s) => s.run === 'npm ci')).toBe(true);
    const gate = steps.find((s) => s.uses?.startsWith('jazzmind/specguard'));
    expect(gate?.with).toMatchObject({
      gates: 'check,test,prove,proof,publish',
      'fail-on': 'missing-specs,proof-incomplete,test,prove',
      affected: 'true',
      'github-token': '${{ secrets.GITHUB_TOKEN }}',
    });
    const scan = wf.jobs.security.steps.find((s) => s.uses?.startsWith('jazzmind/specguard'));
    expect(scan?.with).toMatchObject({ gates: 'scan', 'fail-on': 'none', sarif: 'true' });
  });

  // [claims: capabilities/integration-surfaces#init-ci]
  it('does not fail on layers or security findings by default, and tests everything outside a monorepo', () => {
    const gate = parsed(renderPullRequestWorkflow()).jobs.prove.steps.find((s) => s.uses?.startsWith('jazzmind/specguard'));
    expect(gate?.with?.['fail-on']).toBe('missing-specs,test,prove');
    expect(gate?.with?.affected).toBe('false');
    // No install step without a command: the only shell step fetches the proof notes.
    expect(parsed(renderPullRequestWorkflow()).jobs.prove.steps.filter((s) => s.run).map((s) => s.run)).toEqual([expect.stringContaining('refs/notes/specguard')]);
  });

  // [claims: capabilities/integration-surfaces#init-ci]
  it('offers a manual browser verify run only when asked, and pins the action as given', () => {
    const none = parsed(renderPullRequestWorkflow());
    expect(none.jobs.verify).toBeUndefined();
    const wf = parsed(renderPullRequestWorkflow({ verify: true, actionRef: 'jazzmind/specguard@v0.3.0' }));
    expect(wf.jobs.verify.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(wf.jobs.verify.steps.find((s) => s.uses?.startsWith('jazzmind/specguard'))?.uses).toBe('jazzmind/specguard@v0.3.0');
    expect(wf.jobs.verify.steps.find((s) => s.uses?.startsWith('jazzmind/specguard'))?.with).toMatchObject({ gates: 'verify', comment: 'false', 'validate-url': '${{ github.event.inputs.verify-url }}' });
  });

  // [claims: capabilities/integration-surfaces#init-ci]
  it('schedules remediation with only the permissions it needs, and explains the token auto-merge needs', () => {
    const plain = renderRemediateWorkflow();
    const wf = parsed(plain);
    expect(wf.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
    const step = wf.jobs.remediate.steps.find((s) => s.uses?.startsWith('jazzmind/specguard'));
    expect(step?.with).toMatchObject({ mode: 'remediate', 'open-pr': 'true', 'github-token': '${{ secrets.GITHUB_TOKEN }}' });
    expect(step?.with?.['remediate-args']).not.toContain('--auto-merge');
    expect(plain).not.toContain('SPECGUARD_BOT_TOKEN');

    const merge = renderRemediateWorkflow({ autoMerge: true });
    const mergeStep = parsed(merge).jobs.remediate.steps.find((s) => s.uses?.startsWith('jazzmind/specguard'));
    expect(mergeStep?.with?.['remediate-args']).toContain('--auto-merge');
    expect(mergeStep?.with?.['github-token']).toContain('SPECGUARD_BOT_TOKEN');
    expect(merge).toContain('do not run CI');
  });

  // [claims: capabilities/integration-surfaces#init-ci]
  it('picks the install command from the lockfile', () => {
    const has = (...files: string[]) => (f: string) => files.includes(f);
    expect(installCommandFor(has('pnpm-lock.yaml', 'package-lock.json', 'package.json'))).toContain('pnpm install --frozen-lockfile');
    expect(installCommandFor(has('yarn.lock', 'package.json'))).toBe('yarn install --frozen-lockfile');
    expect(installCommandFor(has('package-lock.json', 'package.json'))).toBe('npm ci');
    expect(installCommandFor(has('package.json'))).toBe('npm install');
    expect(installCommandFor(has('go.mod'))).toBeUndefined();
  });
});

describe('init --ci github [init-ci]', () => {
  // [claims: capabilities/integration-surfaces#init-ci]
  it('writes both workflows, reads the repo for the install step, and never overwrites one that exists', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-ci-'));
    writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}');
    writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const first = await runInit({ cwd: dir, harness: 'claude', ci: 'github', autoMerge: true });
    expect(first.exitCode).toBe(0);
    expect(first.createdFiles).toEqual(expect.arrayContaining([WORKFLOW_FILES.pullRequest, WORKFLOW_FILES.remediate]));
    const pr = readFileSync(path.join(dir, WORKFLOW_FILES.pullRequest), 'utf8');
    expect(parsed(pr).jobs.prove.steps.some((s) => s.run === 'npm ci')).toBe(true);
    expect(readFileSync(path.join(dir, WORKFLOW_FILES.remediate), 'utf8')).toContain('--auto-merge');

    writeFileSync(path.join(dir, WORKFLOW_FILES.pullRequest), '# mine\n');
    const second = await runInit({ cwd: dir, harness: 'claude', ci: 'github' });
    expect(second.skippedFiles).toEqual(expect.arrayContaining([WORKFLOW_FILES.pullRequest, WORKFLOW_FILES.remediate]));
    expect(readFileSync(path.join(dir, WORKFLOW_FILES.pullRequest), 'utf8')).toBe('# mine\n');
  });

  // [claims: capabilities/integration-surfaces#init-ci]
  it('writes no workflow unless asked', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-ci-'));
    await runInit({ cwd: dir, harness: 'claude' });
    expect(existsSync(path.join(dir, WORKFLOW_FILES.pullRequest))).toBe(false);
  });
});
