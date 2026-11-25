import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { compareVer } from '../../src/core/ecosystems/semver.js';
import { RemediateExit } from '../../src/core/exit-codes.js';
import type { PlanItem, RemediationPlan } from '../../src/core/remediation-schema.js';
import { findingLinkKey } from '../../src/pipelines/remediate/finding-links.js';
import { runRemediate } from '../../src/pipelines/remediate/index.js';
import { sastBranch } from '../../src/pipelines/remediate/plan.js';
import type { Exec } from '../../src/pipelines/remediate/types.js';
import { runSecurityFix } from '../../src/pipelines/security-fix.js';
import { writePlan } from '../../src/pipelines/security-plan.js';
import { makeFixture } from '../fixtures/remediate/make-project.js';

const T = 180_000;

/** `git log` text as git prints it, with nothing trimmed. */
function commitMessage(dir: string, rev: string): string {
  const r = spawnSync('git', ['log', '-1', '--format=%B', rev], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

const UNCHANGED_COMMIT =
  'fix(deps): bump vulnlib 1.0.0 -> 1.0.1 (GHSA-test-vuln-0001)\n\nSpecGuard remediate run run-safe. Verdict: PRESERVED.\nA person reviews and merges unless the auto-merge policy allowed it (see the pull request comment).\n\n';

const UNCHANGED_BODY = `## SpecGuard remediation: PRESERVED

**Behavior preserved.** Every baseline-passing test and proven claim still passes after the change, and the advisory is gone. A person reviews and merges unless the auto-merge policy allows it (its decision is posted as a comment).

### Advisories fixed

| Advisory | Aliases | Package | Severity | Installed | Fixed in | Direct |
|---|---|---|---|---|---|---|
| GHSA-test-vuln-0001 | npm:424242 | vulnlib | high | 1.0.0 | 1.0.1 | yes |

### Version change

\`vulnlib\` 1.0.0 -> **1.0.1** (patch, direct dependency)

Risk: **low** (20/100): patch bump (+10); no release notes found, confidence is lower (+10)

Changelog / breaking-change analysis (heuristic, confidence low): No release notes were available; judged from the version change alone.

### Changed files

- \`package-lock.json\` (+1/-1)
- \`package.json\` (+1/-1)

### Tests

Selected first (fast failure): **2** test(s) (0 claim-tagged, 2 in files importing the package). The full suite then ran in every case.

| Run | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|
| Baseline (unpatched) | 2 | 2 | 0 | 0 |
| Patched (full suite) | 2 | 2 | 0 | 0 |

Build: not configured. Typecheck: not configured.

### Baseline vs patched

- Tests: 2 -> 2
- Claims: 2 -> 2
- Regressed tests: 0
- Vanished tests: 0
- Proven claims that dropped: 0

### Static analysis

Not run (Semgrep unavailable or not applicable).

### Verdict

**PRESERVED**
- every preservation condition held

Run \`run-safe\`. Evidence: \`.specguard/remediation/run-safe/ghsa-test-vuln-0001\` (baseline and patched proof ledgers, full report JSON).

_Opened by \`specguard remediate\`. It merges nothing itself: a person decides, except where the auto-merge policy arms GitHub auto-merge for a dependency fix that provably keeps every proof._
`;

function remoteBranches(remote: string): string[] {
  return spawnSync('git', ['branch', '--list'], { cwd: remote, encoding: 'utf8' }).stdout.split('\n').map((l) => l.replace('*', '').trim()).filter(Boolean);
}

describe('remediate end to end (local bare remote, fake gh, canned npm audit)', () => {
  // [claims: capabilities/security-and-remediation#branch-and-evidence, capabilities/security-and-remediation#pr-modes-no-merge, capabilities/security-and-remediation#finding-links]
  it('PRESERVED: a safe bump produces a branch and a normal PR; the user tree is untouched', async () => {
    // claim: pr-modes
    // claim: worktree-only
    // claim: select-then-full
    // claim: proofs-restale
    // claim: scoped-commit
    // claim: no-test-rewrite
    // claim: redetect
    // claim: write-allowlist
    // claim: evidence-report
    // claim: no-auto-merge
    const fx = makeFixture('safe');
    const config = await fx.config();
    const res = await runRemediate(config, { pr: true, runId: 'run-safe' }, fx.deps);
    expect(res.messages.join('\n')).not.toMatch(/\[error\]/);
    expect(res.exitCode).toBe(RemediateExit.Preserved);

    const item = res.report!.results[0];
    expect(item.verdict).toBe('PRESERVED');
    expect(item.branch).toBe('specguard/remediate/ghsa-test-vuln-0001');
    expect(item.changedFiles.map((f) => f.path).sort()).toEqual(['package-lock.json', 'package.json']);
    expect(item.selectedTests.total).toBeGreaterThan(0);
    expect(item.baseline!.total).toBe(2);
    expect(item.patched!.total).toBe(2);

    // branch exists locally and on the bare remote, with exactly one commit that only touches manifest + lockfile
    expect(fx.git('branch', '--list', item.branch)).toContain(item.branch);
    expect(remoteBranches(fx.remote)).toContain(item.branch);
    const changed = fx.git('diff', '--name-only', `main..${item.branch}`).split('\n').sort();
    expect(changed).toEqual(['package-lock.json', 'package.json']);
    expect(fx.git('show', `${item.branch}:package.json`)).toContain('"vulnlib": "^1.0.1"');

    // fake gh recorded a normal (non-draft) PR with the full body
    const create = fx.ghCalls.find((c) => c.args[1] === 'create')!;
    expect(create.args).not.toContain('--draft');
    expect(create.args).toContain('--base');
    expect(create.body).toContain('SpecGuard remediation: PRESERVED');
    expect(create.body).toContain('GHSA-test-vuln-0001');
    expect(create.body).toContain('1.0.0 -> **1.0.1**');
    expect(create.body).toMatch(/Baseline \(unpatched\) \| 2 \|/);
    expect(create.body).toContain('Selected first');
    expect(item.pr).toMatchObject({ draft: false, pushed: true, url: 'https://example.test/acme/fixture/pull/7' });
    // No plan item was supplied, so the commit message and body stay exactly what this run writes on its own.
    expect(commitMessage(fx.dir, item.branch)).toBe(UNCHANGED_COMMIT);
    expect(create.body).toBe(UNCHANGED_BODY);
    expect(fx.ghCalls.every((c) => !c.args.includes('merge'))).toBe(true);

    // evidence: report json, baseline and patched ledgers; patched claims re-proven with a new fingerprint
    const evid = path.join(fx.dir, '.specguard/remediation');
    expect(existsSync(path.join(evid, 'run-safe.json'))).toBe(true);
    const baselineLedger = JSON.parse(readFileSync(path.join(evid, 'run-safe/baseline-proofs.json'), 'utf8'));
    const patchedLedger = JSON.parse(readFileSync(path.join(evid, 'run-safe/ghsa-test-vuln-0001/patched-proofs.json'), 'utf8'));
    const claim = 'app/clean#trims';
    expect(baselineLedger.proofs[claim].verdict).toBe('proven');
    expect(patchedLedger.proofs[claim].verdict).toBe('proven');
    expect(patchedLedger.proofs[claim].dependencyFingerprint).not.toBe(baselineLedger.proofs[claim].dependencyFingerprint);
    expect(item.verdictDetail!.diff.claimCount).toEqual({ baseline: 2, patched: 2 });

    // the user's working tree and branch were never touched, and no worktree remains
    expect(fx.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(fx.git('status', '--porcelain')).toBe('');
    expect(readFileSync(path.join(fx.dir, 'package.json'), 'utf8')).toContain('"^1.0.0"');
    expect(fx.git('worktree', 'list').split('\n')).toHaveLength(1);
    expect(existsSync(path.join(fx.dir, '.specguard/remediate.lock'))).toBe(false);
  }, T);

  // [claims: capabilities/security-and-remediation#branch-and-evidence]
  it('idempotent: a re-run skips an advisory whose branch already exists', async () => {
    // claim: idempotent
    const fx = makeFixture('safe');
    const config = await fx.config();
    const first = await runRemediate(config, { runId: 'r1' }, fx.deps);
    expect(first.exitCode).toBe(RemediateExit.Preserved);
    const again = await runRemediate(config, { runId: 'r2' }, fx.deps);
    expect(again.exitCode).toBe(0);
    expect(again.messages.join('\n')).toMatch(/already exists; skipped \(idempotent re-run\)/);
    expect(fx.ghCalls.filter((c) => c.args[1] === 'create')).toHaveLength(0);
    // without --pr the branch stays local only
    expect(remoteBranches(fx.remote).filter((b) => b.startsWith('specguard/'))).toEqual([]);
  }, T);

  // [claims: capabilities/security-and-remediation#pr-modes-no-merge, capabilities/security-and-remediation#remediate-exit-codes]
  it('CHANGED: a bump that changes behavior fails a baseline-passing test, opens a draft, exits 9', async () => {
    const fx = makeFixture('breaking');
    const config = await fx.config();
    const res = await runRemediate(config, { pr: true, runId: 'run-breaking' }, fx.deps);
    expect(res.exitCode).toBe(RemediateExit.Changed);
    const item = res.report!.results[0];
    expect(item.verdict).toBe('CHANGED');
    expect(item.verdictDetail!.diff.regressedTests.map((r) => r.id)).toEqual(
      expect.arrayContaining(['test/app.test.mjs::app keeps case @claim:app/clean#keeps-case']),
    );
    expect(item.verdictDetail!.diff.claimDrops.map((c) => c.claim)).toContain('app/clean#keeps-case');
    const create = fx.ghCalls.find((c) => c.args[1] === 'create')!;
    expect(create.args).toContain('--draft');
    expect(create.body).toContain('Behavior changed');
    expect(create.body).toContain('keeps case');
    expect(item.pr?.draft).toBe(true);
  }, T);

  // [claims: capabilities/security-and-remediation#pr-modes-no-merge, capabilities/security-and-remediation#remediate-exit-codes]
  it('INCONCLUSIVE: a flaky test in the selected set is excluded and reported, draft PR, exit 10', async () => {
    const fx = makeFixture('flaky');
    const config = await fx.config();
    const res = await runRemediate(config, { pr: true, runId: 'run-flaky' }, fx.deps);
    expect(res.messages.join('\n')).not.toMatch(/\[error\]/);
    const item = res.report!.results[0];
    expect(item.verdict).toBe('INCONCLUSIVE');
    expect(res.exitCode).toBe(RemediateExit.Inconclusive);
    expect(item.verdictDetail!.diff.flaky).toEqual(['test/flaky.test.mjs::flaky alternates']);
    expect(fx.ghCalls.find((c) => c.args[1] === 'create')!.args).toContain('--draft');
  }, T);

  // [claims: capabilities/security-and-remediation#pr-modes-no-merge]
  it('--dry-run runs the whole loop and leaves no branch, no push, no PR and no files', async () => {
    // claim: dry-run
    const fx = makeFixture('safe');
    const config = await fx.config();
    const res = await runRemediate(config, { dryRun: true, pr: true, runId: 'dry' }, fx.deps);
    expect(res.exitCode).toBe(RemediateExit.Preserved);
    expect(res.report!.results[0].verdict).toBe('PRESERVED');
    expect(fx.git('branch', '--list')).toBe('* main');
    expect(remoteBranches(fx.remote)).toEqual(['main']);
    expect(fx.ghCalls.filter((c) => c.args[1] === 'create')).toHaveLength(0);
    expect(fx.git('status', '--porcelain', '--ignored')).toBe('');
    expect(existsSync(path.join(fx.dir, '.specguard/remediation'))).toBe(false);
    expect(fx.git('worktree', 'list').split('\n')).toHaveLength(1);
  }, T);

  // [claims: capabilities/security-and-remediation#finding-links]
  it('names the supplied finding on the commit and at the end of the pull request body', async () => {
    const fx = makeFixture('safe');
    const config = await fx.config();
    const id = 'sg:example-org/example-app:3f9a1c0e7b2d';
    const ownKey = findingLinkKey({ kind: 'advisory', repo: '', ecosystem: 'npm', packageName: 'vulnlib', advisoryId: 'GHSA-test-vuln-0001' });
    const otherKey = findingLinkKey({ kind: 'advisory', repo: '', ecosystem: 'npm', packageName: 'otherlib', advisoryId: 'GHSA-not-this-item' });
    const res = await runRemediate(config, { pr: true, runId: 'run-links', findingIdsByItem: { [ownKey]: [id, id], [otherKey]: ['sg:example-org/example-app:bbbbbb222222'] } }, fx.deps);
    expect(res.messages.join('\n')).not.toMatch(/\[error\]/);
    expect(res.exitCode).toBe(RemediateExit.Preserved);
    const item = res.report!.results[0];
    const plain = 'fix(deps): bump vulnlib 1.0.0 -> 1.0.1 (GHSA-test-vuln-0001)\n\nSpecGuard remediate run run-links. Verdict: PRESERVED.\nA person reviews and merges unless the auto-merge policy allowed it (see the pull request comment).';
    expect(fx.git('log', '-1', '--format=%B', item.branch)).toBe(`${plain}\n\nResolves-Finding: ${id}`);
    const create = fx.ghCalls.find((c) => c.args[1] === 'create')!;
    const block = `<!-- finding-links\n["${id}"]\n-->\n`;
    expect(create.body.endsWith(block)).toBe(true);
    expect(create.body).not.toContain('bbbbbb222222');
    expect(create.body.slice(0, -block.length)).not.toContain('finding-links');
    expect(create.body.slice(0, -block.length)).not.toContain('Resolves-Finding:');
  }, T);

  // [claims: capabilities/security-and-remediation#finding-links]
  it('names only the finding this commit resolves, and a failed or skipped item is named on none', async () => {
    const fx = makeFixture('safe');
    const vendor = (name: string, version: string) => {
      const src = path.join(fx.dir, 'vendor', `vulnlib@${version === '1.0.1' ? '1.0.1' : '1.0.0'}`);
      const dest = path.join(fx.dir, 'vendor', `${name}@${version}`);
      cpSync(src, dest, { recursive: true });
      writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
    };
    for (const name of ['otherlib', 'extralib']) {
      vendor(name, '1.0.0');
      vendor(name, '1.0.1');
    }
    vendor('brokelib', '1.0.0');
    const pkgPath = path.join(fx.dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> };
    pkg.dependencies = { vulnlib: '^1.0.0', otherlib: '^1.0.0', extralib: '^1.0.0', brokelib: '^1.0.0' };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    const locked = (version: string) => ({ version });
    writeFileSync(
      path.join(fx.dir, 'package-lock.json'),
      JSON.stringify({
        name: 'fixture-app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture-app' },
          'node_modules/vulnlib': locked('1.0.0'),
          'node_modules/otherlib': locked('1.0.0'),
          'node_modules/extralib': locked('1.0.0'),
          'node_modules/brokelib': locked('1.0.0'),
        },
      }, null, 2) + '\n',
    );
    writeFileSync(path.join(fx.dir, '.gitignore'), readFileSync(path.join(fx.dir, '.gitignore'), 'utf8') + '.specguard/security/\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'two more packages');
    fx.git('push', '-q', 'origin', 'main');

    const A = 'aaaaaa111111';
    const B = 'bbbbbb222222';
    const C = 'cccccc333333';
    const D = 'dddddd444444';
    const own = (fp: string) => `sg:example-org/example-app:${fp}`;
    const item = (advisory: string, fingerprint: string, packageName: string): PlanItem => ({
      id: advisory,
      title: advisory,
      severity: 'high',
      type: 'dependency',
      change: 'dependency',
      summary: 'bump',
      findings: [{ id: advisory, detector: 'advisory', message: 'm', ecosystem: 'npm', package: packageName }],
      claims: [],
      files: ['package.json'],
      verify: { scope: 'listed', claims: [] },
      status: 'open',
      statusHistory: [],
      fingerprint,
    });
    const plan: RemediationPlan = {
      version: 1,
      id: 'scan-links',
      createdAt: '2026-11-25T00:00:00Z',
      tool: { name: 'specguard' },
      items: [
        item('GHSA-test-vuln-0001', A, 'vulnlib'),
        item('GHSA-test-vuln-0002', B, 'otherlib'),
        item('GHSA-test-broke-0004', C, 'brokelib'),
        item('GHSA-test-nofix-0003', D, 'nofix'),
      ],
    };
    const config = await loadConfig(fx.dir);
    await writePlan(config, plan);

    const versionOf = (cwd: string, name: string): string => {
      const lock = JSON.parse(readFileSync(path.join(cwd, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { version?: string }> };
      return lock.packages?.[`node_modules/${name}`]?.version ?? '1.0.0';
    };
    const via = (name: string, id: string, source: number, range: string) => ({
      source, name, dependency: name, title: `issue in ${name}`, url: `https://github.com/advisories/${id}`, severity: 'high', range,
    });
    const inner = fx.deps.run!;
    const run: NonNullable<typeof fx.deps.run> = async (cmd, args, o) => {
      if (cmd === 'npm' && args[0] === 'audit') {
        const vulnerabilities: Record<string, unknown> = {};
        const add = (name: string, id: string, source: number, range: string, fix: string | undefined) => {
          vulnerabilities[name] = {
            name, severity: 'high', isDirect: true, via: [via(name, id, source, range)], effects: [], range,
            nodes: [`node_modules/${name}`],
            fixAvailable: fix ? { name, version: fix, isSemVerMajor: false } : false,
          };
        };
        if (compareVer(versionOf(o.cwd, 'vulnlib'), '1.0.1') < 0) add('vulnlib', 'GHSA-test-vuln-0001', 424242, '<1.0.1', '1.0.1');
        if (compareVer(versionOf(o.cwd, 'otherlib'), '1.0.1') < 0) add('otherlib', 'GHSA-test-vuln-0002', 424243, '<1.0.1', '1.0.1');
        if (compareVer(versionOf(o.cwd, 'extralib'), '1.0.1') < 0) add('extralib', 'GHSA-test-extra-0005', 424244, '<1.0.1', '1.0.1');
        if (compareVer(versionOf(o.cwd, 'brokelib'), '1.0.1') < 0) add('brokelib', 'GHSA-test-broke-0004', 424245, '<1.0.1', '1.0.1');
        add('nofix', 'GHSA-test-nofix-0003', 424246, '', undefined);
        const found = Object.keys(vulnerabilities).length > 0;
        return { stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities }), stderr: '', status: found ? 1 : 0 };
      }
      if (cmd === 'npm' && args[0] === 'install') {
        const manifest = JSON.parse(readFileSync(path.join(o.cwd, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
        const packages: Record<string, { version: string }> = {};
        for (const name of ['vulnlib', 'otherlib', 'extralib', 'brokelib']) {
          const ver = String(manifest.dependencies[name] ?? '').replace(/^[\^~]/, '');
          const src = path.join(o.cwd, 'vendor', `${name}@${ver}`);
          if (!existsSync(src)) return { stdout: '', stderr: `no such version ${name}@${ver}`, status: 1 };
          rmSync(path.join(o.cwd, 'node_modules', name), { recursive: true, force: true });
          mkdirSync(path.join(o.cwd, 'node_modules'), { recursive: true });
          cpSync(src, path.join(o.cwd, 'node_modules', name), { recursive: true });
          packages[`node_modules/${name}`] = { version: ver };
        }
        writeFileSync(path.join(o.cwd, 'package-lock.json'), JSON.stringify({ name: 'fixture-app', lockfileVersion: 3, packages: { '': { name: 'fixture-app' }, ...packages } }, null, 2) + '\n');
        return { stdout: 'installed', stderr: '', status: 0 };
      }
      return inner(cmd, args, o);
    };
    const git: Exec = (args, cwd) => {
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return { stdout: 'ssh://git@host:22/Example-Org/Example-App.git\n', stderr: '', status: 0 };
      }
      return fx.deps.git!(args, cwd);
    };
    const res = await runSecurityFix(config, { pr: true, noLlm: true }, { ...fx.deps, run, git });
    const shipped = ['ghsa-test-vuln-0001', 'ghsa-test-vuln-0002', 'ghsa-test-extra-0005'];
    const creates = fx.ghCalls.filter((c) => c.args[1] === 'create');
    expect(creates).toHaveLength(3);
    const bodyFor = (slug: string): string => {
      const call = creates.find((c) => c.args.includes(`specguard/remediate/${slug}`));
      expect(call?.body, slug).toBeTruthy();
      return call!.body!;
    };
    const expectOwn = (slug: string, fp: string, others: string[]) => {
      const message = commitMessage(fx.dir, `specguard/remediate/${slug}`);
      const body = bodyFor(slug);
      const id = own(fp);
      expect(message).toContain(`Resolves-Finding: ${id}`);
      expect(body.endsWith(`<!-- finding-links\n["${id}"]\n-->\n`)).toBe(true);
      for (const other of others) {
        expect(message).not.toContain(other);
        expect(body).not.toContain(other);
      }
    };
    expectOwn('ghsa-test-vuln-0001', A, [B, C, D]);
    expectOwn('ghsa-test-vuln-0002', B, [A, C, D]);
    const extraMessage = commitMessage(fx.dir, 'specguard/remediate/ghsa-test-extra-0005');
    const extraBody = bodyFor('ghsa-test-extra-0005');
    expect(extraMessage).not.toContain('Resolves-Finding:');
    expect(extraBody).not.toContain('finding-links');
    expect(extraBody).not.toContain('Resolves-Finding:');
    for (const fp of [A, B, C, D]) {
      expect(extraMessage).not.toContain(fp);
      expect(extraBody).not.toContain(fp);
    }
    expect(fx.git('branch', '--list', 'specguard/remediate/ghsa-test-broke-0004')).toBe('');
    expect(fx.git('branch', '--list', 'specguard/remediate/ghsa-test-nofix-0003')).toBe('');
    const shippedText = shipped.map((slug) => `${commitMessage(fx.dir, `specguard/remediate/${slug}`)}\n${bodyFor(slug)}`).join('\n');
    expect(shippedText).not.toContain(C);
    expect(shippedText).not.toContain(D);
    expect(res.messages.join('\n')).not.toContain(C);
    expect(res.messages.join('\n')).not.toContain(D);
    expect(shipped).toHaveLength(3);
  }, 300_000);

  // [claims: capabilities/security-and-remediation#worktree-isolation]
  it('refuses a dirty working tree and a fresh lock; replaces a stale lock', async () => {
    // claim: refuse-dirty-lock
    const fx = makeFixture('safe');
    const config = await fx.config();
    writeFileSync(path.join(fx.dir, 'notes.txt'), 'wip');
    const dirty = await runRemediate(config, { runId: 'd' }, fx.deps);
    expect(dirty.exitCode).toBe(RemediateExit.SetupError);
    expect(dirty.messages.join('\n')).toMatch(/not clean/);
    rmFile(path.join(fx.dir, 'notes.txt'));

    mkdirSync(path.join(fx.dir, '.specguard'), { recursive: true });
    writeFileSync(path.join(fx.dir, '.specguard/remediate.lock'), JSON.stringify({ runId: 'other', pid: 1, startedAt: '2026-10-06T11:30:00Z' }));
    const locked = await runRemediate(config, { runId: 'l' }, fx.deps);
    expect(locked.exitCode).toBe(RemediateExit.SetupError);
    expect(locked.messages.join('\n')).toMatch(/lock is fresh/);

    writeFileSync(path.join(fx.dir, '.specguard/remediate.lock'), JSON.stringify({ runId: 'old', pid: 1, startedAt: '2026-10-01T00:00:00Z' }));
    const ok = await runRemediate(config, { runId: 's' }, fx.deps);
    expect(ok.exitCode).toBe(RemediateExit.Preserved);
  }, T);

  // [claims: capabilities/security-and-remediation#scan-only-and-secrets]
  it('--scan-only reports and exits 5 without changing anything', async () => {
    // claim: scan-only
    const fx = makeFixture('safe');
    const res = await runRemediate(await fx.config(), { scanOnly: true }, fx.deps);
    expect(res.exitCode).toBe(5);
    expect(res.report!.detection.advisories.map((a) => a.id)).toEqual(['GHSA-test-vuln-0001']);
    expect(fx.git('branch', '--list')).toBe('* main');
    expect(fx.git('status', '--porcelain', '--ignored')).toBe('');
  }, T);

  // [claims: capabilities/security-and-remediation#green-baseline-required, capabilities/security-and-remediation#remediate-exit-codes]
  it('an unparseable baseline counts as a failure: exit 11, nothing applied', async () => {
    // claim: baseline-not-green
    const fx = makeFixture('safe', { testCommand: 'true' });
    const res = await runRemediate(await fx.config(), { runId: 'bad' }, fx.deps);
    expect(res.exitCode).toBe(RemediateExit.SetupError);
    expect(res.messages.join('\n')).toMatch(/could not be parsed/);
    expect(fx.git('branch', '--list')).toBe('* main');
    expect(fx.git('worktree', 'list').split('\n')).toHaveLength(1);
  }, T);

  // [claims: capabilities/security-and-remediation#finding-links]
  it('names only the code hit this commit fixes, and a skipped hit in the same file is named on none', async () => {
    const fx = makeFixture('safe');
    writeFileSync(path.join(fx.dir, '.gitignore'), readFileSync(path.join(fx.dir, '.gitignore'), 'utf8') + '.specguard/security/\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'ignore plans');
    fx.git('push', '-q', 'origin', 'main');
    const A = 'aaaaaa111111';
    const B = 'bbbbbb222222';
    const C = 'cccccc333333';
    const own = (fp: string) => `sg:example-org/example-app:${fp}`;
    const codeItem = (line: number, fingerprint: string): PlanItem => ({
      id: `line-${line}`,
      title: 'js.rule in src/app.mjs',
      severity: 'high',
      type: 'code',
      change: 'code',
      summary: 'fix the finding',
      findings: [{ id: `js.rule@src/app.mjs:${line}`, detector: 'semgrep', ruleId: 'js.rule', message: 'm', file: 'src/app.mjs', line }],
      claims: [],
      files: ['src/app.mjs'],
      verify: { scope: 'listed', claims: [] },
      status: 'open',
      statusHistory: [],
      fingerprint,
    });
    const config = await loadConfig(fx.dir);
    config.remediate = { ...config.remediate, semgrep: true };
    await writePlan(config, {
      version: 1,
      id: 'scan-code',
      createdAt: '2026-11-25T00:00:00Z',
      tool: { name: 'specguard' },
      items: [codeItem(10, A), codeItem(20, B), codeItem(30, C)],
    });
    const inner = fx.deps.run!;
    const run: NonNullable<typeof fx.deps.run> = async (cmd, args, o) => {
      if (cmd === 'npm' && args[0] === 'audit') return { stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }), stderr: '', status: 0 };
      return inner(cmd, args, o);
    };
    const git: Exec = (args, cwd) => {
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') return { stdout: 'ssh://git@host:22/Example-Org/Example-App.git\n', stderr: '', status: 0 };
      return fx.deps.git!(args, cwd);
    };
    const issue = (line: number) => ({ kind: 'sast' as const, ruleId: 'js.rule', path: 'src/app.mjs', line, message: 'm', severity: 'high' as const });
    const branchOf = (line: number) => sastBranch('specguard/remediate/', issue(line));
    const res = await runSecurityFix(config, { pr: true, noLlm: true }, {
      ...fx.deps,
      run,
      git,
      sast: async () => ({
        ok: true,
        findings: [10, 20, 30].map((line) => ({ ruleId: 'js.rule', path: 'src/app.mjs', line, message: 'm', severity: 'ERROR' })),
      }),
      codeFix: async (found, content) => (found.line === 30 ? null : `${content.endsWith('\n') ? content : `${content}\n`}// fixed at ${found.line}\n`),
    });
    const creates = fx.ghCalls.filter((c) => c.args[1] === 'create');
    expect(creates).toHaveLength(2);
    const expectOwn = (line: number, fp: string, others: string[]) => {
      const branch = branchOf(line);
      const message = commitMessage(fx.dir, branch);
      const body = creates.find((c) => c.args.includes(branch))?.body ?? '';
      expect(body).not.toBe('');
      const id = own(fp);
      expect(message).toContain(`Resolves-Finding: ${id}`);
      expect(body.endsWith(`<!-- finding-links\n["${id}"]\n-->\n`)).toBe(true);
      for (const other of others) {
        expect(message).not.toContain(other);
        expect(body).not.toContain(other);
      }
    };
    expectOwn(10, A, [B, C]);
    expectOwn(20, B, [A, C]);
    expect(fx.git('branch', '--list', branchOf(30))).toBe('');
    const shipped = `${commitMessage(fx.dir, branchOf(10))}\n${commitMessage(fx.dir, branchOf(20))}\n${creates.map((c) => c.body).join('\n')}`;
    expect(shipped).not.toContain(C);
    expect(res.messages.join('\n')).not.toContain(C);
  }, 300_000);

  // [claims: capabilities/security-and-remediation#finding-links]
  it('names only its own finding when two packages share an advisory id, and the one that does not ship is named on none', async () => {
    const fx = makeFixture('safe');
    const vendor = (name: string, version: string) => {
      const src = path.join(fx.dir, 'vendor', `vulnlib@${version}`);
      const dest = path.join(fx.dir, 'vendor', `${name}@${version}`);
      cpSync(src, dest, { recursive: true });
      writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
    };
    for (const name of ['alphalib', 'betalib']) {
      vendor(name, '1.0.0');
      vendor(name, '1.0.1');
    }
    const pkgPath = path.join(fx.dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> };
    pkg.dependencies = { vulnlib: '^1.0.0', alphalib: '^1.0.0', betalib: '^1.0.0' };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    writeFileSync(
      path.join(fx.dir, 'package-lock.json'),
      JSON.stringify({
        name: 'fixture-app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture-app' },
          'node_modules/vulnlib': { version: '1.0.0' },
          'node_modules/alphalib': { version: '1.0.0' },
          'node_modules/betalib': { version: '1.0.0' },
        },
      }, null, 2) + '\n',
    );
    writeFileSync(path.join(fx.dir, '.gitignore'), readFileSync(path.join(fx.dir, '.gitignore'), 'utf8') + '.specguard/security/\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'two packages, one advisory id');
    fx.git('push', '-q', 'origin', 'main');
    const A = 'aaaaaa111111';
    const B = 'bbbbbb222222';
    const own = (fp: string) => `sg:example-org/example-app:${fp}`;
    const item = (packageName: string, fingerprint: string): PlanItem => ({
      id: packageName,
      title: packageName,
      severity: 'high',
      type: 'dependency',
      change: 'dependency',
      summary: 'bump',
      findings: [{ id: 'GHSA-shared-0001', detector: 'advisory', message: 'm', ecosystem: 'npm', package: packageName }],
      claims: [],
      files: ['package.json'],
      verify: { scope: 'listed', claims: [] },
      status: 'open',
      statusHistory: [],
      fingerprint,
    });
    const config = await loadConfig(fx.dir);
    await writePlan(config, {
      version: 1,
      id: 'scan-shared',
      createdAt: '2026-11-25T00:00:00Z',
      tool: { name: 'specguard' },
      items: [item('alphalib', A), item('betalib', B)],
    });
    const versionOf = (cwd: string, name: string): string => {
      const lock = JSON.parse(readFileSync(path.join(cwd, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { version?: string }> };
      return lock.packages?.[`node_modules/${name}`]?.version ?? '1.0.0';
    };
    const inner = fx.deps.run!;
    const run: NonNullable<typeof fx.deps.run> = async (cmd, args, o) => {
      if (cmd === 'npm' && args[0] === 'audit') {
        const vulnerabilities: Record<string, unknown> = {};
        for (const name of ['alphalib', 'betalib']) {
          if (compareVer(versionOf(o.cwd, name), '1.0.1') >= 0) continue;
          vulnerabilities[name] = {
            name,
            severity: 'high',
            isDirect: true,
            via: [{ source: 424242, name, dependency: name, title: 'shared', url: 'https://github.com/advisories/GHSA-shared-0001', severity: 'high', range: '<1.0.1' }],
            effects: [],
            range: '<1.0.1',
            nodes: [`node_modules/${name}`],
            fixAvailable: { name, version: '1.0.1', isSemVerMajor: false },
          };
        }
        const found = Object.keys(vulnerabilities).length > 0;
        return { stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities }), stderr: '', status: found ? 1 : 0 };
      }
      if (cmd === 'npm' && args[0] === 'install') {
        const manifest = JSON.parse(readFileSync(path.join(o.cwd, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
        const packages: Record<string, { version: string }> = {};
        for (const name of ['vulnlib', 'alphalib', 'betalib']) {
          const ver = String(manifest.dependencies[name] ?? '').replace(/^[\^~]/, '');
          const src = path.join(o.cwd, 'vendor', `${name}@${ver}`);
          if (!existsSync(src)) return { stdout: '', stderr: `no such version ${name}@${ver}`, status: 1 };
          rmSync(path.join(o.cwd, 'node_modules', name), { recursive: true, force: true });
          mkdirSync(path.join(o.cwd, 'node_modules'), { recursive: true });
          cpSync(src, path.join(o.cwd, 'node_modules', name), { recursive: true });
          packages[`node_modules/${name}`] = { version: ver };
        }
        writeFileSync(path.join(o.cwd, 'package-lock.json'), JSON.stringify({ name: 'fixture-app', lockfileVersion: 3, packages: { '': { name: 'fixture-app' }, ...packages } }, null, 2) + '\n');
        return { stdout: 'installed', stderr: '', status: 0 };
      }
      return inner(cmd, args, o);
    };
    const git: Exec = (args, cwd) => {
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') return { stdout: 'https://host/Example-Org/Example-App.git\n', stderr: '', status: 0 };
      return fx.deps.git!(args, cwd);
    };
    await runSecurityFix(config, { pr: true, noLlm: true }, { ...fx.deps, run, git });
    const creates = fx.ghCalls.filter((c) => c.args[1] === 'create');
    expect(creates).toHaveLength(1);
    const branch = 'specguard/remediate/ghsa-shared-0001';
    const message = commitMessage(fx.dir, branch);
    const body = creates[0].body ?? '';
    expect(message).toContain('alphalib');
    expect(message).toContain(`Resolves-Finding: ${own(A)}`);
    expect(message).not.toContain(B);
    expect(body.endsWith(`<!-- finding-links\n["${own(A)}"]\n-->\n`)).toBe(true);
    expect(body).not.toContain(B);
  }, 300_000);
});

function rmFile(p: string): void {
  spawnSync('rm', ['-f', p]);
}
