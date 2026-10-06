import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import type { Advisory, Candidate } from '../../src/core/advisory.js';
import { getEcosystem } from '../../src/core/ecosystems/index.js';
import { configureLlm, resetLlmRuntime } from '../../src/core/llm.js';
import { replayKey, saveReplay } from '../../src/core/llm-replay.js';
import type { SpecGuardConfig } from '../../src/core/types.js';
import { applyCodeFix, collectChanges, enforce, snapshotTree } from '../../src/pipelines/remediate/apply.js';
import { flakyIds } from '../../src/pipelines/remediate/baseline.js';
import { analyzeBreaking, BREAKING_SYSTEM, breakingPrompt, fetchChangelog, heuristicBreaking } from '../../src/pipelines/remediate/changelog.js';
import { detect } from '../../src/pipelines/remediate/detect.js';
import { realGit } from '../../src/pipelines/remediate/git.js';
import { chooseCandidate, existingWork, scoreRisk } from '../../src/pipelines/remediate/plan.js';
import { importPattern, selectTests, specsForFiles } from '../../src/pipelines/remediate/select-tests.js';
import { ship } from '../../src/pipelines/remediate/ship.js';
import type { RemediateDeps, SastIssue } from '../../src/pipelines/remediate/types.js';
import type { TestCaseResult } from '../../src/core/test-results.js';

const adv = (over: Partial<Advisory> = {}): Advisory => ({
  id: 'GHSA-1', aliases: [], ecosystem: 'npm', package: 'lodash', installedVersion: '4.17.20', vulnerableRange: '<4.17.21',
  fixedVersions: ['4.17.21'], severity: 'high', direct: true, dependencyPath: [], source: 't', ...over,
});
const npm = getEcosystem('npm');
const cfg = { apps: [{ name: 'a', repo: '.', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 't' }], llm: { provider: 'none', model: 'none', apiKeyEnv: 'N' } } as unknown as SpecGuardConfig;
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'sg-ru-'));

function repo(): { dir: string; git: (...a: string[]) => string } {
  const dir = tmp();
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' }).stdout.trim();
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'n');
  writeFileSync(path.join(dir, 'package.json'), '{}\n');
  writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(dir, 'src/b.ts'), 'export const b = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'i');
  return { dir, git };
}

describe('planning', () => {
  it('picks the smallest fix, patch over minor, and refuses a major without --allow-major', () => {
    // claim: plan-smallest
    const a = adv({ installedVersion: '2.2.0', fixedVersions: ['3.0.1', '2.3.0', '2.2.5'] });
    expect(chooseCandidate([a], (x) => npm.resolveFix(x), false).candidate?.toVersion).toBe('2.2.5');
    const majorOnly = adv({ installedVersion: '1.0.0', fixedVersions: ['2.0.0'] });
    const r = chooseCandidate([majorOnly], (x) => npm.resolveFix(x), false);
    expect(r.candidate).toBeUndefined();
    expect(r.skip).toMatch(/--allow-major/);
    expect(chooseCandidate([majorOnly], (x) => npm.resolveFix(x), true).candidate?.toVersion).toBe('2.0.0');
    expect(chooseCandidate([adv({ fixedVersions: [] })], (x) => npm.resolveFix(x), true).skip).toMatch(/no fixed version/);
  });

  it('one candidate must fix every advisory of the package', () => {
    const a = adv({ id: 'A', installedVersion: '1.0.0', fixedVersions: ['1.0.5'] });
    const b = adv({ id: 'B', installedVersion: '1.0.0', fixedVersions: ['1.2.0'] });
    const r = chooseCandidate([a, b], (x) => npm.resolveFix(x), false);
    expect(r.candidate?.toVersion).toBe('1.2.0');
    expect(r.candidate?.advisoryIds).toEqual(['A', 'B']);
  });

  it('scores risk by bump, transitivity, breaking notes and missing changelog', () => {
    const c: Candidate = { advisoryIds: [], ecosystem: 'npm', package: 'x', fromVersion: '1.0.0', toVersion: '1.0.1', bump: 'patch', mode: 'direct' };
    expect(scoreRisk(c, undefined, true, false)).toMatchObject({ score: 10, level: 'low' });
    expect(scoreRisk({ ...c, bump: 'major' }, { breaking: true, source: 'llm', summary: '', items: [], confidence: 'high' }, false, true)).toMatchObject({ score: 100, level: 'high' });
  });

  it('detects an existing branch or PR (idempotency)', () => {
    // claim: idempotent
    const { dir, git } = repo();
    const deps = { git: realGit, gh: () => ({ stdout: '[{"url":"https://x/pr/1"}]', stderr: '', status: 0 }) };
    expect(existingWork(deps, dir, 'specguard/remediate/x', false)).toBeUndefined();
    git('branch', 'specguard/remediate/x');
    expect(existingWork(deps, dir, 'specguard/remediate/x', false)).toMatch(/already exists/);
    expect(existingWork(deps, dir, 'specguard/remediate/y', true)).toMatch(/PR already exists.*pr\/1/);
  });
});

describe('changelog and LLM analysis', () => {
  const c: Candidate = { advisoryIds: [], ecosystem: 'npm', package: 'vulnlib', fromVersion: '1.0.0', toVersion: '1.0.2', bump: 'patch', mode: 'direct' };

  it('fetches release notes between versions through the injected http', async () => {
    const http: RemediateDeps['http'] = async (url) => {
      if (url.startsWith('https://registry.npmjs.org/')) return { status: 200, text: JSON.stringify({ repository: { url: 'git+https://github.com/acme/vulnlib.git' } }) };
      if (url.includes('/repos/acme/vulnlib/releases')) return { status: 200, text: JSON.stringify([{ tag_name: 'v1.0.3', body: 'later' }, { tag_name: 'v1.0.2', body: 'BREAKING: removed foo' }, { tag_name: 'v1.0.1', body: 'fix' }, { tag_name: 'v1.0.0', body: 'old' }]) };
      return { status: 404, text: '' };
    };
    const log = await fetchChangelog(c, http);
    expect(log?.text).toContain('v1.0.2');
    expect(log?.text).toContain('v1.0.1');
    expect(log?.text).not.toContain('later');
    expect(log?.text).not.toContain('old');
    expect(await fetchChangelog(c, async () => { throw new Error('offline'); })).toBeUndefined();
  });

  it('uses the replay provider for the breaking-change analysis, and falls back to keywords', async () => {
    // claim: plan-changelog
    const dir = tmp();
    const notes = '## v1.0.2\nBREAKING: removed foo()';
    saveReplay(path.join(dir, 'rec'), {
      kind: 'object', hash: replayKey('object', BREAKING_SYSTEM, breakingPrompt(c, notes)), promptPreview: 'p', provider: 'replay', model: 'x', recordedAt: 'now',
      response: { breaking: true, summary: 'foo() was removed', items: ['foo removed'], confidence: 'high' },
    });
    resetLlmRuntime();
    const llm = { provider: 'replay', model: 'x', apiKeyEnv: 'N', replay: { dir: 'rec' } };
    configureLlm({ rootDir: dir, llm });
    const warnings: string[] = [];
    const out = await analyzeBreaking({ ...cfg, llm } as SpecGuardConfig, c, notes, true, (m) => warnings.push(m));
    expect(out).toMatchObject({ breaking: true, source: 'llm', confidence: 'high', items: ['foo removed'] });
    // unseen request: replay miss does not block, heuristic answers
    const fallback = await analyzeBreaking({ ...cfg, llm } as SpecGuardConfig, c, `${notes}\nmore`, true, (m) => warnings.push(m));
    expect(fallback.source).toBe('heuristic');
    expect(fallback.breaking).toBe(true);
    expect(warnings.join()).toMatch(/skipped/);
    resetLlmRuntime();
    expect(heuristicBreaking(c, undefined)).toMatchObject({ confidence: 'low', breaking: false });
  });
});

describe('detection', () => {
  it('applies the ignore file, the threshold, and reports secrets without their value', async () => {
    // claim: sast-secrets
    const dir = tmp();
    mkdirSync(path.join(dir, '.specguard'));
    writeFileSync(path.join(dir, '.specguard/vuln-ignore.json'), JSON.stringify({ ignore: [{ id: 'GHSA-ignored', reason: 'r', expires: '2027-01-01' }] }));
    writeFileSync(path.join(dir, 'package.json'), '{}');
    writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const audit = JSON.stringify({ vulnerabilities: {
      a: { name: 'a', severity: 'high', isDirect: true, via: [{ source: 1, name: 'a', title: 't', url: 'https://github.com/advisories/GHSA-keep', severity: 'high', range: '<2.0.0' }], effects: [], range: '<2.0.0' },
      b: { name: 'b', severity: 'high', isDirect: true, via: [{ source: 2, name: 'b', title: 't', url: 'https://github.com/advisories/GHSA-ignored', severity: 'high', range: '<2.0.0' }], effects: [], range: '<2.0.0' },
      c: { name: 'c', severity: 'low', isDirect: true, via: [{ source: 3, name: 'c', title: 't', url: 'https://github.com/advisories/GHSA-low', severity: 'low', range: '<2.0.0' }], effects: [], range: '<2.0.0' },
    } });
    const run: RemediateDeps['run'] = async (cmd, args) => {
      if (cmd === 'npm' && args[0] === 'audit') return { stdout: audit, stderr: '', status: 1 };
      if (cmd === 'gitleaks') {
        const rp = args[args.indexOf('--report-path') + 1];
        writeFileSync(rp, JSON.stringify([{ RuleID: 'aws-key', Description: 'AWS key', File: 'src/x.ts', StartLine: 3, Secret: 'AKIAREALSECRET', Match: 'AKIAREALSECRET' }]));
        return { stdout: '', stderr: '', status: 0 };
      }
      return { stdout: '', stderr: '', status: null, error: 'ENOENT' };
    };
    const sastIssue = { ruleId: 'xss', path: '/src/src/y.ts', line: 4, message: 'xss', severity: 'ERROR' };
    const deps = { run, now: () => new Date('2026-10-06'), sast: async () => ({ ok: true, findings: [sastIssue, { ...sastIssue, ruleId: 'minor', severity: 'INFO' }] }) } as unknown as RemediateDeps;
    const det = await detect({ ...cfg, rootDir: dir } as SpecGuardConfig, dir, deps, { threshold: 'high' });
    expect(det.advisories.map((a) => a.id)).toEqual(['GHSA-keep']);
    expect(det.suppressed.map((s) => s.id)).toEqual(['GHSA-ignored']);
    expect(det.belowThreshold.map((a) => a.id)).toEqual(['GHSA-low']);
    expect(det.sast.map((s) => `${s.ruleId}@${s.path}`)).toEqual(['xss@src/y.ts']);
    expect(det.secrets).toHaveLength(1);
    expect(JSON.stringify(det)).not.toContain('AKIAREALSECRET');
    expect(det.secrets[0].message).toMatch(/needs rotation/);
  });
});

describe('write allowlist and limits', () => {
  const scope = { type: 'dependency' as const, files: ['package.json', 'package-lock.json'] };

  it('accepts manifest and lockfile edits only', () => {
    // claim: write-allowlist
    const { dir } = repo();
    const before = snapshotTree(realGit, dir);
    writeFileSync(path.join(dir, 'package.json'), '{"a":1}\n');
    writeFileSync(path.join(dir, 'package-lock.json'), '{"a":1}\n');
    const ok = collectChanges(realGit, dir, before, scope);
    expect(ok.violations).toEqual([]);
    expect(ok.allowed.sort()).toEqual(['package-lock.json', 'package.json']);
    expect(() => enforce(ok, { maxFiles: 20, maxLines: 2000 })).not.toThrow();

    writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 2;\n');
    const bad = collectChanges(realGit, dir, before, scope);
    expect(bad.violations).toEqual(['src/a.ts']);
    expect(() => enforce(bad, { maxFiles: 20, maxLines: 2000 })).toThrow(/outside its write allowlist.*src\/a\.ts/);
  });

  it('enforces file and line limits; untracked directories are noise; test leftovers are tolerated when tracked-only', () => {
    const { dir } = repo();
    const before = snapshotTree(realGit, dir);
    writeFileSync(path.join(dir, 'package.json'), '{"a":1,\n"b":2,\n"c":3}\n');
    mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules/x/i.js'), '1');
    const cs = collectChanges(realGit, dir, before, scope);
    expect(cs.violations).toEqual([]);
    expect(() => enforce(cs, { maxFiles: 20, maxLines: 2 })).toThrow(/lines/);
    expect(() => enforce(cs, { maxFiles: 0, maxLines: 2000 })).toThrow(/files/);
    writeFileSync(path.join(dir, 'coverage.txt'), 'x');
    expect(collectChanges(realGit, dir, before, scope).violations).toEqual(['coverage.txt']);
    expect(collectChanges(realGit, dir, before, scope, true).violations).toEqual([]);
    writeFileSync(path.join(dir, 'src/b.ts'), 'changed\n'); // a tracked file rewritten by the "tests"
    expect(collectChanges(realGit, dir, before, scope, true).violations).toEqual(['src/b.ts']);
  });

  it('a code fix may only change the named file and cannot escape the repo', async () => {
    const { dir, git } = repo();
    const issue: SastIssue = { kind: 'sast', ruleId: 'r', path: 'src/a.ts', message: 'm', severity: 'high' };
    expect(await applyCodeFix(issue, dir, async (_i, c) => c.replace('1', '2'))).toBe(true);
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toContain('= 2');
    expect(await applyCodeFix(issue, dir, async () => null)).toBe(false);
    await expect(applyCodeFix({ ...issue, path: '../x.ts' }, dir, async () => 'x')).rejects.toThrow(/escapes/);
    expect(git('status', '--porcelain')).toBe('M src/a.ts');
  });
});

describe('baseline, selection, ship', () => {
  const t = (title: string, status: TestCaseResult['status'], file = 'a.test.ts', claims: string[] = []): TestCaseResult => ({ file, title, fullTitle: title, status, durationMs: 1, tags: [], claims, externalIds: [] });

  it('quarantines ids whose status differs between the two baseline runs', () => {
    // claim: baseline-flaky
    expect(flakyIds([t('a', 'pass'), t('b', 'pass'), t('c', 'pass')], [t('a', 'pass'), t('b', 'fail'), t('d', 'pass')])).toEqual(['a.test.ts::b', 'a.test.ts::c', 'a.test.ts::d']);
  });

  it('selects claim-tagged tests of affected specs plus tests in importing files', () => {
    const reg = { 'app/spec': { specKey: 'spec', specHash: 'h', files: { 'src/app.ts': { hash: 'x', lastChecked: '', lastVerdict: 'no-drift' as const } } } };
    const specs = specsForFiles(reg, ['src/app.ts']);
    expect([...specs]).toEqual(['spec']);
    const sel = selectTests([t('one', 'pass', 'x.test.ts', ['spec#c1']), t('two', 'pass', 'imp.test.ts'), t('three', 'pass', 'other.test.ts', ['zzz#c'])], ['imp.test.ts'], specs);
    expect(sel).toMatchObject({ claimTagged: 1, importing: 1, files: ['imp.test.ts', 'x.test.ts'] });
    expect(sel.ids).toHaveLength(2);
  });

  it('matches imports per ecosystem', () => {
    expect(importPattern({ ecosystem: 'npm', package: 'lodash' }).test("import _ from 'lodash/fp'")).toBe(true);
    expect(importPattern({ ecosystem: 'npm', package: 'lodash' }).test("import x from 'lodash-es'")).toBe(false);
    expect(importPattern({ ecosystem: 'PyPI', package: 'django' }).test('from django.db import models')).toBe(true);
    expect(importPattern({ ecosystem: 'Go', package: 'golang.org/x/net' }).test('import "golang.org/x/net/http2"')).toBe(true);
    expect(importPattern({ ecosystem: 'crates.io', package: 'serde-json' }).test('use serde_json::Value;')).toBe(true);
  });

  it('ship stages only the scope, commits, and uses --draft for non-PRESERVED verdicts; no merge call exists', () => {
    // claim: scoped-commit
    const { dir, git } = repo();
    git('checkout', '-q', '-b', 'specguard/remediate/t');
    writeFileSync(path.join(dir, 'package.json'), '{"x":1}\n');
    writeFileSync(path.join(dir, 'src/b.ts'), 'stray\n');
    const calls: string[][] = [];
    const gh = (args: string[]) => { calls.push(args); return { stdout: 'https://x/pr/9\n', stderr: '', status: 0 }; };
    const remote = tmp();
    spawnSync('git', ['init', '-q', '--bare', remote]);
    git('remote', 'add', 'origin', remote);
    const res = ship({ git: realGit, gh, wtDir: dir, repoRoot: dir, branch: 'specguard/remediate/t', scope: { type: 'dependency', files: ['package.json'] }, commitMessage: 'fix: x', title: 't', bodyPath: path.join(tmp(), 'b.md'), body: 'body', verdict: 'CHANGED', pr: true });
    expect(res.staged).toEqual(['package.json']);
    expect(res.skippedPaths).toEqual(['src/b.ts']);
    expect(git('show', '--name-only', '--format=', 'HEAD')).toBe('package.json');
    expect(calls[0]).toContain('--draft');
    expect(calls.flat()).not.toContain('merge');
    expect(res.prUrl).toBe('https://x/pr/9');
    expect(spawnSync('git', ['branch', '--list'], { cwd: remote, encoding: 'utf8' }).stdout).toContain('specguard/remediate/t');
  });
});
