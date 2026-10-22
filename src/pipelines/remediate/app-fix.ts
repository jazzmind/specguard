/**
 * `remediate --from failing`: repair the application when a requirement's proof is failing.
 *
 * The dependency and Semgrep paths of `remediate` keep behaviour the same. This one changes it on purpose: a
 * claim fails (a test, or the browser check), the owning capability's source files are patched, and the change
 * counts only if the targeted claims are proven afterwards and nothing that passed before stopped passing. The
 * patch may touch only the capability's own source files, never a test, a spec or a manifest, and is always a pull
 * request for a person: it is never auto-merged.
 *
 * Spec: specs/capabilities/security-and-remediation.md
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { RemediateExit } from '../../core/exit-codes.js';
import { llmGenerateObject } from '../../core/llm.js';
import { testId, type VerdictResult } from '../../core/behavior-verdict.js';
import type { TestCaseResult } from '../../core/test-results.js';
import type { PipelineResult, RemediateConfig, SpecGuardConfig } from '../../core/types.js';
import { emptyResult } from '../../core/types.js';
import { loadTrace } from '../check.js';
import { collectChanges, DEFAULT_LIMITS, enforce, snapshotTree } from './apply.js';
import { runBaseline, type BaselineResult } from './baseline.js';
import { defaultDeps } from './index.js';
import {
  acquireLock,
  createWorktree,
  dirtyEntries,
  gitRoot,
  RemediateSetupError,
  releaseLock,
  removeWorktree,
  type Worktree,
} from './git.js';
import { existingWork } from './plan.js';
import { resolveUserLedger } from './ledger.js';
import { ship } from './ship.js';
import { projectEcosystems } from './steps.js';
import type { RemediateDeps } from './types.js';
import { verifyPatched } from './verify.js';

export interface AppFixOpts {
  /** Repair only this claim (`capabilities/auth#login`) or this capability (`capabilities/auth`). */
  claim?: string;
  /** Most capabilities repaired in one run. Default 3. */
  max?: number;
  /** Push the branch and open a pull request (a draft unless the verdict is clean). */
  pr?: boolean;
  /** Do everything but leave no branch, push or pull request. */
  dryRun?: boolean;
  /** Ledger the baseline starts from. */
  ledger?: string;
  app?: string;
  force?: boolean;
  runId?: string;
  onLog?: (line: string) => void;
}

/** A capability with failing claims, and the source files a repair may change. */
export interface AppFixTarget {
  capability: string;
  specKey: string;
  title: string;
  value: string;
  claims: Array<{ ref: string; id: string; text: string }>;
  /** Owned source files: not tests, specs, docs, history, manifests or `.specguard`. Repo-relative POSIX. */
  files: string[];
  /** Layers in which the claims fail, from the ledger. */
  layers: string[];
}

export interface AppFixContext {
  capability: string;
  title: string;
  value: string;
  claims: Array<{ ref: string; text: string }>;
  failures: Array<{ test: string; claim?: string; message?: string }>;
  /** What the browser check said, when it was the browser that failed. */
  notes: string[];
  files: Array<{ path: string; content: string }>;
}

/** Produce replacement content for some of the capability's files, or null when no safe repair exists. */
export type AppFixer = (ctx: AppFixContext) => Promise<Array<{ path: string; content: string }> | null>;

const FixSchema = z.object({
  fixable: z.boolean(),
  files: z.array(z.object({ path: z.string(), content: z.string() })).default([]),
  explanation: z.string().default(''),
});

export function llmAppFixer(config: SpecGuardConfig): AppFixer {
  return async (ctx) => {
    const out = await llmGenerateObject({
      provider: config.llm.provider,
      model: config.llm.model,
      apiKeyEnv: config.llm.apiKeyEnv,
      pipeline: 'remediate',
      temperature: 0,
      maxTokens: 16000,
      system:
        'You repair an application so a failing requirement holds, with the smallest change. You may change only the files you are shown. ' +
        'Never edit tests, specs, configuration or dependencies, and keep every other behaviour identical. Return the complete new content of each file you change, or set fixable=false when no safe repair exists.',
      prompt: [
        `Capability: ${ctx.title} (${ctx.capability})`,
        ctx.value ? `Value it delivers: ${ctx.value}` : '',
        '',
        'Requirements that fail:',
        ...ctx.claims.map((c) => `- ${c.ref}: ${c.text}`),
        '',
        ctx.failures.length > 0 ? 'Failing tests:' : '',
        ...ctx.failures.map((f) => `- ${f.test}${f.claim ? ` (proves ${f.claim})` : ''}${f.message ? `\n    ${f.message.slice(0, 600)}` : ''}`),
        ...(ctx.notes.length > 0 ? ['', 'Browser check findings:', ...ctx.notes.map((n) => `- ${n}`)] : []),
        '',
        'Files you may change:',
        ...ctx.files.map((f) => `\n=== ${f.path} ===\n${f.content}`),
      ]
        .filter((l) => l !== '')
        .join('\n'),
      schema: FixSchema,
    });
    const files = out.files ?? [];
    return out.fixable && files.length > 0 ? files : null;
  };
}

const NOT_SOURCE = /(^|\/)(specs?|docs?|tests?|__tests__|e2e|\.specguard|node_modules|dist|build|coverage)\//;
const NOT_CODE = /\.(md|mdx|txt|json|ya?ml|toml|lock|snap)$/i;

/** Capabilities with at least one failing claim, with the files a repair may touch. Reads the user's tree. */
export async function findAppFixTargets(config: SpecGuardConfig, only?: string): Promise<{ targets: AppFixTarget[]; skipped: string[] }> {
  const root = config.rootDir ?? process.cwd();
  const { model } = await loadTrace(config);
  const targets: AppFixTarget[] = [];
  const skipped: string[] = [];
  for (const n of model.nodes) {
    if (n.kind !== 'capability' && n.kind !== 'component') continue;
    const failing = n.claims.filter((c) => c.proof === 'failed' || c.proof === 'error');
    const wanted = only ? failing.filter((c) => c.ref === only || n.id === only || n.specKey === only || `${n.id}#${c.id}` === only) : failing;
    if (wanted.length === 0) continue;
    const tests = new Set(n.tests);
    const files = n.ownedFiles.filter((f) => !tests.has(f) && !NOT_SOURCE.test(f) && !NOT_CODE.test(f) && existsSync(path.join(root, f)) && statSync(path.join(root, f)).size <= 60_000);
    if (files.length === 0) {
      skipped.push(`${n.id}: no owned source files to repair`);
      continue;
    }
    targets.push({
      capability: n.id,
      specKey: n.specKey,
      title: n.title,
      value: n.value,
      claims: wanted.map((c) => ({ ref: c.ref, id: c.id, text: c.text })),
      files,
      layers: [...new Set(wanted.flatMap((c) => Object.entries(c.layers ?? {}).filter(([, v]) => v === 'failed' || v === 'error').map(([l]) => l)))],
    });
  }
  return { targets, skipped };
}

/** What the browser check wrote about a capability's failing requirements. */
function browserNotes(root: string, specKey: string, claimIds: string[]): string[] {
  try {
    const report = JSON.parse(readFileSync(path.join(root, '.specguard', 'reports', `verify-${specKey.replace(/[\\/]/g, '-')}.json`), 'utf8')) as {
      verdicts?: Array<{ criterion: string; verdict: string; reason: string; evidence?: string }>;
    };
    return (report.verdicts ?? []).filter((v) => v.verdict === 'FAIL' && claimIds.some((id) => v.criterion === id || v.criterion.startsWith(`${id}:`) || v.criterion.startsWith(`${id} `))).map((v) => `${v.criterion}: ${v.reason}${v.evidence ? ` (${v.evidence})` : ''}`);
  } catch {
    return [];
  }
}

/** The failing tests that prove a target's claims. */
function failuresFor(tests: TestCaseResult[], target: AppFixTarget): AppFixContext['failures'] {
  const refs = new Set(target.claims.map((c) => c.ref));
  const out: AppFixContext['failures'] = [];
  for (const t of tests) {
    if (t.status !== 'fail') continue;
    const claim = t.claims.find((c) => refs.has(c));
    if (claim) out.push({ test: testId(t), claim, message: t.message });
  }
  return out;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'capability';

function renderBody(target: AppFixTarget, verdict: VerdictResult, changed: string[], failures: AppFixContext['failures'], runId: string): string {
  const v = verdict.verdict;
  return [
    `## SpecGuard repair: ${target.title}`,
    '',
    v === 'PRESERVED'
      ? `**Repaired.** ${target.claims.length} failing requirement(s) are proven again, and every test and claim that passed before still passes.`
      : v === 'CHANGED'
        ? '**Not a clean repair.** This is a draft: the differences below need a person.'
        : '**Inconclusive.** SpecGuard could not show that nothing else changed. This is a draft: see the reasons below.',
    '',
    '### Requirements that failed',
    ...target.claims.map((c) => `- \`${c.ref}\`: ${c.text}`),
    '',
    ...(failures.length > 0 ? ['### Failing tests', ...failures.slice(0, 10).map((f) => `- ${f.test}`), ''] : []),
    '### Files changed',
    ...changed.map((f) => `- \`${f}\``),
    '',
    ...(verdict.reasons.length > 0 ? ['### Reasons', ...verdict.reasons.map((r) => `- **${r.kind}**: ${r.detail}`), ''] : []),
    `_Opened by \`specguard remediate --from failing\` (run ${runId}). It changes application code, so a person reviews and merges it: it is never auto-merged._`,
  ].join('\n');
}

export interface AppFixResult extends PipelineResult {
  fixed: string[];
}

export async function runAppFix(config: SpecGuardConfig, opts: AppFixOpts = {}, depsIn: Partial<RemediateDeps> & { appFix?: AppFixer } = {}): Promise<AppFixResult> {
  const result: AppFixResult = { ...emptyResult('remediate'), fixed: [] };
  const deps: RemediateDeps = { ...defaultDeps(), ...depsIn };
  const cfg: RemediateConfig = config.remediate ?? {};
  const root = config.rootDir ?? process.cwd();
  const log = (line: string): void => {
    result.messages.push(line);
    opts.onLog?.(line);
  };
  const runId = opts.runId ?? `fix-${deps.now().toISOString().replace(/[:.]/g, '-')}`;

  const { targets, skipped } = await findAppFixTargets(config, opts.claim);
  for (const s of skipped) log(`[skip] ${s}`);
  if (targets.length === 0) {
    log(opts.claim ? `no failing claim matches ${opts.claim}` : 'no failing claims to repair');
    result.exitCode = 0;
    return result;
  }
  const chosen = targets.slice(0, opts.max ?? 3);
  for (const t of targets) log(`[target] ${t.capability}: ${t.claims.map((c) => c.id).join(', ')} (${t.files.length} file(s)${t.layers.length ? `; failing in ${t.layers.join(', ')}` : ''})${chosen.includes(t) ? '' : ' (over --max, not attempted)'}`);

  // ---- safety rails: a clean tree, one run at a time, nothing in the user's tree ------------------------
  let gitTop: string;
  try {
    gitTop = gitRoot(deps.git, root);
    const dirty = dirtyEntries(deps.git, gitTop);
    if (dirty.length) throw new RemediateSetupError(`the working tree is not clean (${dirty.slice(0, 5).join(', ')}); commit or stash first. Repair never touches your working tree.`);
    if (!opts.dryRun) acquireLock(root, runId, deps.now(), opts.force);
  } catch (err) {
    log(`[error] ${err instanceof Error ? err.message : String(err)}`);
    result.exitCode = RemediateExit.SetupError;
    return result;
  }
  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const evidenceRoot = opts.dryRun ? mkdtempSync(path.join(tmpRoot, 'sg-repair-')) : path.join(root, '.specguard', 'remediation');
  const evidenceDir = path.join(evidenceRoot, opts.dryRun ? '' : runId);
  mkdirSync(evidenceDir, { recursive: true });
  const relRoot = path.relative(realpathSync(gitTop), realpathSync(root));
  const prefix = cfg.branchPrefix ?? 'specguard/remediate/';
  const worktrees: Worktree[] = [];
  const fixer = depsIn.appFix ?? llmAppFixer(config);

  try {
    // ---- baseline once, in its own worktree ----------------------------------------------------------
    const baseWt = createWorktree(deps.git, gitTop, `specguard-remediate-baseline-${runId}`.replace(/[^A-Za-z0-9._/-]/g, '-'), tmpRoot);
    worktrees.push(baseWt);
    const baseRoot = path.join(baseWt.dir, relRoot);
    log('baseline: installing, building and running the tests twice in a temporary worktree');
    const baseline: BaselineResult = await runBaseline({
      config, root: baseRoot, ecos: projectEcosystems(config, baseRoot, deps.run, opts.app), run: deps.run, cfg,
      userLedger: await resolveUserLedger(root, opts.ledger), evidenceDir, runId, app: opts.app,
    });
    log(`baseline: ${baseline.summary.total} test(s), ${baseline.failing.length} failing, ${baseline.quarantined.length} flaky`);
    // Failing tests are expected here. Anything that stops the comparison from meaning something is not.
    if (!baseline.build.ok || !baseline.typecheck.ok || !baseline.parsed || baseline.tests.length === 0) {
      for (const r of baseline.reasons.filter((x) => !/test\(s\) fail on the unpatched baseline/.test(x))) log(`[baseline] ${r}`);
      log('the baseline could not be built or its tests could not be read: no repair was attempted');
      result.exitCode = RemediateExit.SetupError;
      result.failed = 1;
      return result;
    }

    for (const target of chosen) {
      const branch = `${prefix}app-fix-${slug(target.capability)}`;
      const exists = existingWork(deps, gitTop, branch, Boolean(opts.pr));
      if (exists) {
        log(`[skip] ${target.capability}: ${exists}; skipped (idempotent re-run)`);
        result.skipped += 1;
        continue;
      }
      const verdict = await repairOne({ target, branch, config, cfg, deps, opts, gitTop, relRoot, tmpRoot, baseline, evidenceDir, runId, worktrees, fixer, log });
      if (verdict === 'error') result.failed += 1;
      else if (verdict === 'skipped') result.skipped += 1;
      else {
        result.created += 1;
        result.items.push({ key: target.capability, status: 'created', message: verdict });
        if (verdict === 'PRESERVED') result.fixed.push(target.capability);
      }
      result.items.push({ key: `${target.capability}:${branch}`, status: verdict === 'error' ? 'failed' : verdict === 'skipped' ? 'skipped' : 'created', message: verdict });
    }
    const verdicts = result.items.filter((i) => i.key.includes(':')).map((i) => i.message);
    result.exitCode = verdicts.includes('error')
      ? RemediateExit.SetupError
      : verdicts.includes('CHANGED')
        ? RemediateExit.Changed
        : verdicts.includes('INCONCLUSIVE')
          ? RemediateExit.Inconclusive
          : verdicts.length > 0 && verdicts.every((v) => v === 'PRESERVED')
            ? RemediateExit.Preserved
            : RemediateExit.Inconclusive;
    return result;
  } catch (err) {
    log(`[error] ${err instanceof Error ? err.message : String(err)}`);
    result.exitCode = RemediateExit.SetupError;
    return result;
  } finally {
    for (const wt of worktrees.reverse()) removeWorktree(deps.git, wt, wt.branch.startsWith('specguard-remediate-baseline-') || Boolean(opts.dryRun));
    if (!opts.dryRun) releaseLock(root, runId);
  }
}

interface RepairCtx {
  target: AppFixTarget;
  branch: string;
  config: SpecGuardConfig;
  cfg: RemediateConfig;
  deps: RemediateDeps;
  opts: AppFixOpts;
  gitTop: string;
  relRoot: string;
  tmpRoot: string;
  baseline: BaselineResult;
  evidenceDir: string;
  runId: string;
  worktrees: Worktree[];
  fixer: AppFixer;
  log: (line: string) => void;
}

/** One capability: patch, verify, and (unless dry-run) commit and open the pull request. */
async function repairOne(c: RepairCtx): Promise<'PRESERVED' | 'CHANGED' | 'INCONCLUSIVE' | 'skipped' | 'error'> {
  const { target, deps, cfg, opts } = c;
  const itemDir = path.join(c.evidenceDir, slug(target.capability));
  mkdirSync(itemDir, { recursive: true });
  let wt: Worktree | undefined;
  let keepBranch = false;
  try {
    wt = createWorktree(deps.git, c.gitTop, c.branch, c.tmpRoot);
    c.worktrees.push(wt);
    const root = path.join(wt.dir, c.relRoot);
    const ecos = projectEcosystems(c.config, root, deps.run, opts.app);
    const scope = { type: 'code-fix' as const, files: target.files };
    const limits = { maxFiles: cfg.maxFilesChanged ?? DEFAULT_LIMITS.maxFiles, maxLines: cfg.maxLinesChanged ?? DEFAULT_LIMITS.maxLines };
    const before = snapshotTree(deps.git, wt.dir);

    c.log(`[repair] ${target.capability}: asking for a change to ${target.files.length} file(s)`);
    const failures = failuresFor(c.baseline.tests, target);
    const proposal = await c.fixer({
      capability: target.capability,
      title: target.title,
      value: target.value,
      claims: target.claims,
      failures,
      notes: browserNotes(c.config.rootDir ?? root, target.specKey, target.claims.map((x) => x.id)),
      files: target.files.map((f) => ({ path: f, content: readFileSync(path.join(wt!.dir, f), 'utf8') })),
    });
    if (!proposal) {
      c.log(`[skip] ${target.capability}: no safe repair was produced`);
      return 'skipped';
    }
    const allowed = new Set(target.files);
    const outside = proposal.filter((p) => !allowed.has(p.path));
    if (outside.length > 0) throw new RemediateSetupError(`the repair named files it may not change: ${outside.map((p) => p.path).join(', ')}`);
    for (const p of proposal) writeFileSync(path.join(wt.dir, p.path), p.content);
    let cs = collectChanges(deps.git, wt.dir, before, scope);
    if (cs.changed.length === 0) {
      c.log(`[skip] ${target.capability}: the proposed repair changed nothing`);
      return 'skipped';
    }
    enforce(cs, limits);

    const out = await verifyPatched({
      config: c.config, root, ecos, run: deps.run, cfg, baseline: c.baseline, changeType: 'code', targetAdvisoryIds: [],
      advisoriesBefore: [], redetect: async () => [], selection: { ids: [], files: [], claimTagged: 0, importing: 0, importingFiles: [], specKeys: [] },
      threshold: 'high', evidenceDir: itemDir, runId: c.runId, afterBuild: () => enforce(collectChanges(deps.git, wt!.dir, before, scope, true), limits),
      intendedFlips: target.claims.map((x) => x.ref),
      // The point is to flip failing claims; claims nothing exercised before are not this repair's business.
      strictUnexercised: false,
    });
    cs = collectChanges(deps.git, wt.dir, before, scope, true);
    enforce(cs, limits);
    const verdict = out.verdict.verdict;
    c.log(`[verdict] ${target.capability}: ${verdict}${out.verdict.reasons.length ? ` (${out.verdict.reasons.map((r) => r.kind).join(', ')})` : ''}`);

    const body = renderBody(target, out.verdict, cs.files.map((f) => f.path), failures, c.runId);
    const bodyPath = path.join(itemDir, 'pr-body.md');
    writeFileSync(bodyPath, body);
    if (opts.dryRun) {
      c.log(`[dry-run] ${target.capability}: not committed; branch removed`);
      return verdict;
    }
    const shipped = ship({
      git: deps.git, gh: deps.gh, wtDir: wt.dir, repoRoot: c.gitTop, branch: c.branch, scope,
      commitMessage: `fix(${target.specKey.replace(/^capabilities\//, '')}): repair ${target.claims.map((x) => x.id).join(', ')}\n\nSpecGuard repair run ${c.runId}. Verdict: ${verdict}.\nThis changes application code: a person reviews and merges it.`,
      title: `[SpecGuard${verdict === 'PRESERVED' ? '' : `: ${verdict}`}] repair ${target.title}: ${target.claims.map((x) => x.id).join(', ')}`.slice(0, 200),
      bodyPath, body, verdict, pr: Boolean(opts.pr), baseBranch: cfg.baseBranch,
    });
    keepBranch = true;
    c.log(shipped.pushed ? `[pr] ${c.branch}: ${shipped.draft ? 'draft ' : ''}PR ${shipped.prUrl ?? 'created'}` : `[branch] ${c.branch}: committed ${shipped.commit.slice(0, 8)} (not pushed)`);
    return verdict;
  } catch (err) {
    c.log(`[error] ${target.capability}: ${err instanceof Error ? err.message : String(err)}; rolled back`);
    return 'error';
  } finally {
    if (wt) {
      removeWorktree(deps.git, wt, !keepBranch);
      const i = c.worktrees.indexOf(wt);
      if (i >= 0) c.worktrees.splice(i, 1);
    }
  }
}
