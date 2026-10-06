/**
 * `specguard remediate`: patch a vulnerable dependency or code issue in a temporary worktree,
 * prove behavior is preserved with the project's own tests, and only then propose the change.
 * Humans always merge: there is no auto-merge.
 *
 * Spec: specs/pipelines/remediate.md
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Advisory, Severity } from '../../core/advisory.js';
import { SEVERITIES } from '../../core/advisory.js';
import { detectDependencyAdvisories } from '../../core/ecosystems/index.js';
import { defaultRunner } from '../../core/ecosystems/types.js';
import { ExitCode, RemediateExit } from '../../core/exit-codes.js';
import { emptyResult, type PipelineResult, type RemediateConfig, type SpecGuardConfig } from '../../core/types.js';
import { sast } from '../security.js';
import { applyCodeFix, applyDependency, collectChanges, DEFAULT_LIMITS, enforce, scopeFor, snapshotTree } from './apply.js';
import { runBaseline, type BaselineResult } from './baseline.js';
import { llmCodeFixer } from './code-fix.js';
import { detect } from './detect.js';
import {
  acquireLock,
  createWorktree,
  dirtyEntries,
  gitRoot,
  headCommit,
  realGh,
  realGit,
  releaseLock,
  removeWorktree,
  RemediateSetupError,
  readLock,
  LOCK_TTL_MS,
  type Worktree,
} from './git.js';
import { existingWork, planDependencies, sastBranch } from './plan.js';
import { renderPrBody } from './report.js';
import { importingFiles, loadRegistryAt, selectTests, specsForFiles, type Selection } from './select-tests.js';
import { ship } from './ship.js';
import { installProject, projectEcosystems } from './steps.js';
import { resolveUserLedger } from './ledger.js';
import { verifyPatched } from './verify.js';
import type {
  DetectionReport,
  ItemReport,
  PlanItem,
  RemediateDeps,
  RemediateOpts,
  RemediationReport,
  SastIssue,
} from './types.js';

export type { RemediateDeps, RemediateOpts, RemediationReport } from './types.js';

export interface RemediateResult extends PipelineResult {
  report?: RemediationReport;
}

const defaultHttp: RemediateDeps['http'] = async (url, headers = {}) => {
  const h: Record<string, string> = { 'user-agent': 'specguard-remediate', ...headers };
  if (url.startsWith('https://api.github.com/') && process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers: h, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, text: await res.text() };
};

export function defaultDeps(): RemediateDeps {
  return { run: defaultRunner, git: realGit, gh: realGh, http: defaultHttp, now: () => new Date() };
}

function parseSeverity(s: string | undefined): Severity | undefined {
  return s && (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : undefined;
}

function pseudoAdvisory(i: SastIssue): Advisory {
  return {
    id: `semgrep:${i.ruleId}@${i.path}`,
    aliases: [],
    ecosystem: 'sast',
    package: i.path,
    installedVersion: '',
    vulnerableRange: '',
    fixedVersions: [],
    severity: i.severity,
    direct: true,
    dependencyPath: [],
    source: 'semgrep',
    title: i.message,
  };
}

export async function runRemediate(config: SpecGuardConfig, opts: RemediateOpts = {}, depsIn: Partial<RemediateDeps> = {}): Promise<RemediateResult> {
  const result: RemediateResult = emptyResult('remediate');
  const deps: RemediateDeps = { ...defaultDeps(), ...depsIn };
  const cfg: RemediateConfig = config.remediate ?? {};
  const root = config.rootDir ?? process.cwd();
  const log = (line: string) => {
    result.messages.push(line);
    opts.onLog?.(line);
  };
  const threshold = opts.minSeverity ?? parseSeverity(cfg.minSeverity) ?? 'high';
  const runId = opts.runId ?? `rem-${deps.now().toISOString().replace(/[:.]/g, '-')}`;
  const allowMajor = opts.allowMajor ?? cfg.allowMajor ?? false;
  const mode = opts.scanOnly ? 'scan-only' : opts.dryRun ? 'dry-run' : 'full';

  // ---- detection (read-only, user's tree) --------------------------------------------------------
  let detection: DetectionReport;
  try {
    detection = await detect(config, root, deps, {
      threshold,
      advisory: opts.advisory,
      useOsv: cfg.osv,
      useSemgrep: cfg.semgrep,
      useGitleaks: cfg.gitleaks,
      app: opts.app,
    });
  } catch (err) {
    log(`detection failed: ${err instanceof Error ? err.message : String(err)}`);
    result.exitCode = RemediateExit.SetupError;
    return result;
  }
  for (const w of detection.warnings) log(`[warn] ${w}`);
  for (const a of detection.advisories) log(`[advisory] ${a.severity.toUpperCase()} ${a.id} ${a.package}@${a.installedVersion || '?'} -> ${a.fixedVersions.join(', ') || 'no fix published'}${a.direct ? '' : ' (transitive)'}`);
  for (const s of detection.sast) log(`[sast] ${s.severity.toUpperCase()} ${s.ruleId} ${s.path}${s.line ? `:${s.line}` : ''} ${s.message}`);
  for (const s of detection.secrets) log(`[secret] ${s.ruleId} ${s.path}${s.line ? `:${s.line}` : ''} ${s.message}`);
  for (const s of detection.suppressed) log(`[ignored] ${s.id}: ${s.reason}${s.expires ? ` (until ${s.expires})` : ''}`);
  log(`remediate: ${detection.advisories.length} advisory(ies), ${detection.sast.length} code finding(s), ${detection.secrets.length} secret(s) at or above ${threshold}`);

  const report: RemediationReport = { runId, startedAt: deps.now().toISOString(), mode, detection, plan: [], results: [] };
  result.report = report;
  const findings = detection.advisories.length + detection.sast.length + detection.secrets.length;

  if (opts.scanOnly) {
    result.exitCode = findings > 0 ? ExitCode.SecurityIssues : ExitCode.Success;
    return result;
  }
  if (detection.advisories.length + detection.sast.length === 0) {
    log(detection.secrets.length ? 'nothing to patch automatically: secrets are reported only and need rotation' : 'nothing to remediate');
    result.exitCode = detection.secrets.length ? ExitCode.SecurityIssues : ExitCode.Success;
    return result;
  }

  // ---- safety rails ---------------------------------------------------------------------------
  let gitTop: string;
  try {
    gitTop = gitRoot(deps.git, root);
    const dirty = dirtyEntries(deps.git, gitTop);
    if (dirty.length) throw new RemediateSetupError(`the working tree is not clean (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}); commit or stash first. Remediation never touches your working tree.`);
    const lock = readLock(root);
    if (opts.dryRun) {
      if (lock && !opts.force && deps.now().getTime() - Date.parse(lock.startedAt) < LOCK_TTL_MS) throw new RemediateSetupError(`.specguard/remediate.lock is fresh (run ${lock.runId}); another remediation is running.`);
    } else {
      acquireLock(root, runId, deps.now(), opts.force);
    }
  } catch (err) {
    log(`[error] ${err instanceof Error ? err.message : String(err)}`);
    result.exitCode = RemediateExit.SetupError;
    return result;
  }

  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const evidenceRoot = opts.dryRun ? mkdtempSync(path.join(tmpRoot, 'sg-remediation-')) : path.join(root, '.specguard', 'remediation');
  const evidenceDir = path.join(evidenceRoot, opts.dryRun ? '' : runId);
  mkdirSync(evidenceDir, { recursive: true });
  const relRoot = path.relative(gitTop, root);
  const prefix = cfg.branchPrefix ?? 'specguard/remediate/';
  const worktrees: Worktree[] = [];

  try {
    // ---- plan ------------------------------------------------------------------------------------
    const llmOn = !(opts.noLlm || deps.llm === false);
    const maxAdv = cfg.maxAdvisories ?? 5;
    const plan: PlanItem[] = await planDependencies(config, detection, deps, deps.run, { allowMajor, branchPrefix: prefix, maxAdvisories: maxAdv, threshold, checkPr: Boolean(opts.pr), llm: llmOn, repoRoot: gitTop }, (m) => log(`[warn] ${m}`));
    for (const issue of detection.sast.slice(0, Math.max(0, maxAdv - plan.length))) {
      const branch = sastBranch(prefix, issue);
      const exists = existingWork(deps, gitTop, branch, Boolean(opts.pr));
      plan.push({
        advisories: [pseudoAdvisory(issue)],
        candidate: { advisoryIds: [pseudoAdvisory(issue).id], ecosystem: 'sast', package: issue.path, fromVersion: '', toVersion: '', bump: 'unknown', mode: 'direct' },
        alternatives: [],
        branch,
        changeType: 'code',
        risk: { score: 20, level: 'low', factors: ['single-file code fix'] },
        issue,
        skip: exists ? `${exists}; skipped (idempotent re-run)` : !llmOn && !deps.codeFix ? 'code fixes need the LLM layer (disabled for this run)' : undefined,
      });
    }
    report.plan = plan.map((p) => ({ branch: p.branch, changeType: p.changeType, risk: p.risk, breaking: p.breaking, skip: p.skip, advisoryIds: p.advisories.map((a) => a.id), candidate: p.candidate }));
    for (const p of plan) log(p.skip ? `[skip] ${p.branch}: ${p.skip}` : `[plan] ${p.branch}: ${p.changeType === 'dependency' ? `${p.candidate.package} ${p.candidate.fromVersion} -> ${p.candidate.toVersion} (${p.candidate.bump})` : `${p.issue?.ruleId} in ${p.issue?.path}`}, risk ${p.risk.level}`);
    const runnable = plan.filter((p) => !p.skip);
    if (runnable.length === 0) {
      const idempotent = plan.length > 0 && plan.every((p) => /idempotent/.test(p.skip ?? ''));
      log(idempotent ? 'every advisory already has a remediation branch or PR' : 'nothing could be planned automatically');
      result.exitCode = idempotent ? ExitCode.Success : ExitCode.SecurityIssues;
      return result;
    }

    // ---- baseline (once, in its own worktree at HEAD) ---------------------------------------------------
    const head = headCommit(deps.git, gitTop);
    report.baseCommit = head;
    const baseWt = createWorktree(deps.git, gitTop, `specguard-remediate-baseline-${runId}`.replace(/[^A-Za-z0-9._/-]/g, '-'), tmpRoot);
    worktrees.push(baseWt);
    const baseRoot = path.join(baseWt.dir, relRoot);
    const userLedger = await resolveUserLedger(root, opts.ledger);
    log(`baseline: installing, building and running the tests twice in a temporary worktree`);
    const ecosBase = projectEcosystems(config, baseRoot, deps.run, opts.app);
    const baseline: BaselineResult = await runBaseline({ config, root: baseRoot, ecos: ecosBase, run: deps.run, cfg, userLedger, evidenceDir, runId, app: opts.app });
    log(`baseline: ${baseline.summary.total} test(s), ${baseline.quarantined.length} flaky, env ${baseline.env.hash.slice(0, 12)}`);
    if (!baseline.green) {
      for (const r of baseline.reasons) log(`[baseline] ${r}`);
      log('baseline is not green: no patch was applied');
      result.exitCode = RemediateExit.SetupError;
      result.failed = 1;
      return result;
    }

    // ---- per item -------------------------------------------------------------------------------------
    const advisoriesBefore = [...detection.advisories, ...detection.belowThreshold, ...detection.sast.map(pseudoAdvisory)];
    const registry = loadRegistryAt(baseRoot, root);
    for (const item of runnable) {
      const itemReport = await processItem({ item, config, cfg, deps, opts, gitTop, relRoot, tmpRoot, baseline, advisoriesBefore, registry, evidenceDir, runId, threshold, worktrees, log });
      report.results.push(itemReport);
      result.items.push({ key: item.branch, status: itemReport.error ? 'failed' : itemReport.skipped ? 'skipped' : 'created', message: itemReport.error ?? itemReport.verdict });
      if (itemReport.error) result.failed += 1;
      else if (itemReport.skipped) result.skipped += 1;
      else result.created += 1;
    }

    // ---- exit code: worst item wins ------------------------------------------------------------------
    const done = report.results;
    result.exitCode = done.some((r) => r.error)
      ? RemediateExit.SetupError
      : done.some((r) => r.verdict === 'CHANGED')
        ? RemediateExit.Changed
        : done.some((r) => r.verdict === 'INCONCLUSIVE')
          ? RemediateExit.Inconclusive
          : done.length > 0 && done.every((r) => r.verdict === 'PRESERVED')
            ? RemediateExit.Preserved
            : ExitCode.SecurityIssues;
    return result;
  } catch (err) {
    log(`[error] ${err instanceof Error ? err.message : String(err)}`);
    result.exitCode = RemediateExit.SetupError;
    return result;
  } finally {
    for (const wt of worktrees.reverse()) removeWorktree(deps.git, wt, wt.branch.startsWith('specguard-remediate-baseline-') || Boolean(opts.dryRun));
    try {
      const out = path.join(evidenceRoot, opts.dryRun ? 'report.json' : `${runId}.json`);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
      log(`report: ${out}`);
    } catch {
      /* the report is best-effort */
    }
    if (!opts.dryRun) releaseLock(root, runId);
  }
}

interface ItemCtx {
  item: PlanItem;
  config: SpecGuardConfig;
  cfg: RemediateConfig;
  deps: RemediateDeps;
  opts: RemediateOpts;
  gitTop: string;
  relRoot: string;
  tmpRoot: string;
  baseline: BaselineResult;
  advisoriesBefore: Advisory[];
  registry: ReturnType<typeof loadRegistryAt>;
  evidenceDir: string;
  runId: string;
  threshold: Severity;
  worktrees: Worktree[];
  log: (l: string) => void;
}

async function processItem(c: ItemCtx): Promise<ItemReport> {
  const { item, deps, cfg, opts } = c;
  const slug = item.branch.slice(item.branch.lastIndexOf('/') + 1);
  const itemDir = path.join(c.evidenceDir, slug);
  mkdirSync(itemDir, { recursive: true });
  const rep: ItemReport = {
    branch: item.branch,
    advisoryIds: item.advisories.map((a) => a.id),
    changedFiles: [],
    selectedTests: { claimTagged: 0, importing: 0, total: 0, files: [] },
    evidence: { dir: itemDir, baselineLedger: c.baseline.snapshotPath },
  };
  let wt: Worktree | undefined;
  let keepBranch = false;
  try {
    wt = createWorktree(deps.git, c.gitTop, item.branch, c.tmpRoot);
    c.worktrees.push(wt);
    const root = path.join(wt.dir, c.relRoot);
    const ecos = projectEcosystems(c.config, root, deps.run, opts.app);
    const scope = scopeFor(item.changeType, ecos, wt.dir, item.issue ? [item.issue] : []);
    const limits = { maxFiles: cfg.maxFilesChanged ?? DEFAULT_LIMITS.maxFiles, maxLines: cfg.maxLinesChanged ?? DEFAULT_LIMITS.maxLines };
    const before = snapshotTree(deps.git, wt.dir);
    const check = () => enforce(collectChanges(deps.git, wt!.dir, before, scope), limits);

    // apply
    c.log(`[apply] ${item.branch}`);
    if (item.changeType === 'dependency') {
      await applyDependency(item, ecos, root, (eco, dir) => installProject(eco, dir, deps.run, cfg).then((r) => ({ ok: r.ok, output: r.output })));
    } else if (item.issue) {
      const fixer = deps.codeFix ?? llmCodeFixer(c.config);
      const changed = await applyCodeFix(item.issue, wt.dir, fixer);
      if (!changed) {
        rep.skipped = 'no safe automatic fix was produced for this finding';
        return rep;
      }
    }
    // The allowlist and the limits are enforced before the long steps.
    let cs = collectChanges(deps.git, wt.dir, before, scope);
    enforce(cs, limits);
    rep.changedFiles = cs.files;

    // selection
    const projectDir = path.resolve(root, item.advisories[0]?.repo ?? '.');
    const imports = item.changeType === 'dependency' ? await importingFiles(wt.dir, projectDir, item.candidate) : [];
    const touched = item.changeType === 'dependency' ? imports : [item.issue!.path];
    const specKeys = specsForFiles(c.registry, touched);
    const selection: Selection = selectTests(c.baseline.tests, imports, specKeys);
    rep.selectedTests = { claimTagged: selection.claimTagged, importing: selection.importing, total: selection.ids.length, files: selection.files };

    const redetect = async (): Promise<Advisory[]> => {
      if (item.changeType === 'code') {
        const after = await (deps.sast ?? ((d: string) => sast.run(d)))(projectDir);
        return after.findings.map((f) => pseudoAdvisory({ kind: 'sast', ruleId: f.ruleId, path: path.relative(wt!.dir, path.resolve(projectDir, f.path.replace(/^\/src\//, ''))).split(path.sep).join('/'), message: f.message, severity: ((): Severity => (f.severity?.toUpperCase() === 'ERROR' ? 'high' : f.severity?.toUpperCase() === 'WARNING' ? 'moderate' : 'low'))() }));
      }
      const det = await detectDependencyAdvisories(projectDir, { run: deps.run, useOsv: cfg.osv });
      return det.advisories;
    };

    const out = await verifyPatched({
      config: c.config,
      root,
      ecos,
      run: deps.run,
      cfg,
      baseline: c.baseline,
      changeType: item.changeType,
      targetAdvisoryIds: item.advisories.flatMap((a) => [a.id, ...a.aliases]),
      advisoriesBefore: c.advisoriesBefore,
      redetect,
      selection,
      threshold: c.threshold,
      evidenceDir: itemDir,
      runId: c.runId,
      afterBuild: check,
    });
    // Tests must not have rewritten anything: re-check the allowlist after the run.
    cs = collectChanges(deps.git, wt.dir, before, scope);
    enforce(cs, limits);

    rep.verdict = out.verdict.verdict;
    rep.verdictDetail = out.verdict;
    rep.baseline = c.baseline.summary;
    rep.patched = out.patchedSummary;
    rep.build = { ok: out.build.ok, skipped: out.build.skipped };
    rep.typecheck = { ok: out.typecheck.ok, skipped: out.typecheck.skipped };
    rep.evidence.patchedLedger = out.patchedLedgerPath;
    if (item.changeType === 'code') {
      const sastAfter = out.advisoriesAfter.map((a) => a.id);
      rep.sastDelta = { before: c.advisoriesBefore.filter((a) => a.ecosystem === 'sast').length, after: sastAfter.length, new: sastAfter.filter((id) => !c.advisoriesBefore.some((b) => b.id === id)) };
    }
    c.log(`[verdict] ${item.branch}: ${rep.verdict}${out.verdict.reasons.length ? ` (${out.verdict.reasons.map((r) => r.kind).join(', ')})` : ''}`);

    const body = renderPrBody({ runId: c.runId, item, result: rep, verdict: out.verdict, evidenceRel: path.relative(c.gitTop, itemDir).split(path.sep).join('/') });
    const bodyPath = path.join(itemDir, 'pr-body.md');
    writeFileSync(bodyPath, body);
    rep.prBodyPath = bodyPath;

    if (opts.dryRun) {
      c.log(`[dry-run] ${item.branch}: not committed; branch removed`);
      return rep;
    }
    const ids = item.advisories.map((a) => a.id).join(', ');
    const subject = item.changeType === 'dependency' ? `bump ${item.candidate.package} ${item.candidate.fromVersion} -> ${item.candidate.toVersion} (${ids})` : `${item.issue?.ruleId} in ${item.issue?.path}`;
    const shipped = ship({
      git: deps.git,
      gh: deps.gh,
      wtDir: wt.dir,
      repoRoot: c.gitTop,
      branch: item.branch,
      scope,
      commitMessage: `fix(${item.changeType === 'dependency' ? 'deps' : 'security'}): ${subject}\n\nSpecGuard remediate run ${c.runId}. Verdict: ${rep.verdict}.\nA human must review and merge; nothing was merged automatically.`,
      title: `[SpecGuard${rep.verdict === 'PRESERVED' ? '' : `: ${rep.verdict}`}] fix: ${subject}`.slice(0, 200),
      bodyPath,
      body,
      verdict: out.verdict.verdict,
      pr: Boolean(opts.pr),
      baseBranch: cfg.baseBranch,
    });
    keepBranch = true;
    rep.commit = shipped.commit;
    rep.pr = { url: shipped.prUrl, draft: shipped.draft, pushed: shipped.pushed, recorded: Boolean(opts.pr) };
    c.log(shipped.pushed ? `[pr] ${item.branch}: ${shipped.draft ? 'draft ' : ''}PR ${shipped.prUrl ?? 'created'}` : `[branch] ${item.branch}: committed ${shipped.commit.slice(0, 8)} (not pushed)`);
    return rep;
  } catch (err) {
    rep.error = err instanceof Error ? err.message : String(err);
    c.log(`[error] ${item.branch}: ${rep.error}; rolled back`);
    return rep;
  } finally {
    if (wt) {
      removeWorktree(deps.git, wt, !keepBranch);
      const i = c.worktrees.indexOf(wt);
      if (i >= 0) c.worktrees.splice(i, 1);
    }
  }
}
