/**
 * Validate pipeline — PERCEIVE-PLAN-ACT-VERIFY.
 *
 * Drives a real browser against the running application and verifies that
 * acceptance criteria from each Living Specification are actually met.
 *
 * Loop per spec:
 *   1. PERCEIVE  — navigate to spec URL, collect screenshot + a11y snapshot
 *   2. PLAN      — LLM compares acceptance criteria to perceived state, plans steps
 *   3. ACT       — execute steps via Playwright; guardrails block destructive/outbound
 *   4. VERIFY    — LLM assigns verdicts (PASS / FAIL / BLOCKED / INCONCLUSIVE)
 *
 * Evidence (screenshots, HTTP status, console errors) saved to
 *   .specguard/evidence/<spec-key>/
 *
 * Validation history appended to .specguard/validation-history.json.
 *
 * Spec: specs/capabilities/agentic-verification.md
 */
import { chmodSync, readdirSync, rmSync, statSync } from 'node:fs';
import { checkAgentTarget } from '../core/validate-targets.js';
import path from 'node:path';
import { readFile as fsReadFile } from 'node:fs/promises';
import { z } from 'zod';

import type { SpecGuardConfig, AppConfig, PipelineResult, ParsedSpec } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import { loadCanonicalSpecs } from '../core/spec-key.js';
import { ingestVerdicts } from './proof.js';
import { writeFile, ensureDir } from '../core/writer.js';
import { fileExists } from '../core/reader.js';
import { llmGenerateObject } from '../core/llm.js';
import {
  launchBrowser,
  closeBrowser,
  navigateTo,
  takeScreenshot,
  getAccessibilitySnapshot,
  getPageHtml,
  inspectTarget,
  PlaywrightUnavailableError,
} from '../adapters/playwright.js';
import type { BrowserHandle } from '../adapters/playwright.js';
import { clearSessionCache } from '../adapters/auth-state-machine.js';
import { SessionPool } from '../adapters/sessions.js';
import {
  classifyAction,
  isBlocked,
  makeBlockedAction,
  type GuardrailPolicy,
} from '../adapters/guardrails.js';
import { createRedactor, loadRedactHook, type Redactor } from '../core/redact.js';
import { untrusted, withUntrustedNotice } from '../core/untrusted.js';
import { e2eTestPath, renderPlaywrightTest, type ScriptStep } from '../core/e2e-script.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidateOpts {
  /** Validate a single spec by key or path. */
  spec?: string;
  /** Validate all specs that have a url: metadata field. */
  all?: boolean;
  /** Restrict to a single app. */
  app?: string;
  /** Base URL override (prepended to spec url: if spec url is relative). */
  baseUrl?: string;
  /** Skip re-authenticating (reuse in-memory session cache). */
  reuseSession?: boolean;
  /**
   * Skip the REVIEW step (typed issue report) even if the spec has UI sections.
   * Useful for fast iteration when you only need criterion verdicts.
   */
  noReview?: boolean;
  /** The run was started by an agent: it may only target loopback and `validate.allowedHosts`. The MCP server sets this. */
  restrictHosts?: boolean;
  /** Write a Playwright test from each passing capability check, in `paths.e2eTests` (default tests/e2e). */
  emitTests?: boolean;
  /** Show the browser window (overrides `validate.headless`). */
  headed?: boolean;
  /** Let outbound actions (send, invite, pay, ...) run, for staging. Destructive actions stay blocked. */
  allowOutbound?: boolean;
}

/** Everything one validate run shares across specs. */
interface RunContext {
  /** Launches the single browser on first use. Rejects with PlaywrightUnavailableError when missing. */
  browser: () => Promise<BrowserHandle>;
  pool: () => Promise<SessionPool>;
  redactor: Redactor;
  policy: GuardrailPolicy;
  /** False when `llm.allowImages` is false: nothing visual goes to the LLM. */
  allowImages: boolean;
}

/** A single criterion verdict. */
export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'INCONCLUSIVE';

export interface CriterionVerdict {
  criterion: string;
  verdict: Verdict;
  evidence?: string;
  reason: string;
}

export interface ValidationEntry {
  specKey: string;
  url: string;
  timestamp: string;
  verdicts: CriterionVerdict[];
  overallVerdict: Verdict;
  /** v2 specs: whether the observed behaviour delivers the capability's stated value. */
  value?: ValueJudgement;
}

// ---------------------------------------------------------------------------
// LLM schemas
// ---------------------------------------------------------------------------

/** Most browser steps taken in one plan-act round. */
export const MAX_ACTIONS_PER_ROUND = 5;

const PlannedActionSchema = z.object({
  actions: z.array(
    z.object({
      description: z.string(),
      /** What to do. Omitted: a fill when there is a selector and a value, else a click. */
      kind: z.enum(['click', 'fill', 'navigate', 'assertText', 'waitFor']).optional(),
      selector: z.string().optional(),
      /** Text to type, text that must be visible (assertText), or the same-site path to open (navigate). */
      value: z.string().optional(),
      /** For assertText and waitFor: the id of the requirement the step checks. */
      claim: z.string().optional(),
    }),
  ),
});

const VerifyResponseSchema = z.object({
  verdicts: z.array(
    z.object({
      criterion: z.string(),
      verdict: z.enum(['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE']),
      reason: z.string(),
      evidence: z.string().optional(),
    }),
  ),
});

/** v2 specs: the per-requirement verdicts plus a judgement of the capability's stated value. */
const VerifyV2Schema = VerifyResponseSchema.extend({
  value: z.object({
    delivers: z.enum(['YES', 'PARTIAL', 'NO', 'INCONCLUSIVE']),
    reason: z.string(),
    gaps: z.array(z.string()),
  }),
});

export type ValueJudgement = z.infer<typeof VerifyV2Schema>['value'];

/**
 * Typed issue report produced by the REVIEW step.
 * Written to `.specguard/reports/validate-<spec-key>.json`.
 */
const IssueReportSchema = z.object({
  issues: z.array(
    z.object({
      type: z.enum(['functional', 'ux', 'accessibility', 'visual']),
      severity: z.enum(['critical', 'major', 'minor']),
      description: z.string(),
      /** CSS selector, aria role/name, or element description. */
      element: z.string().optional(),
      recommendation: z.string(),
      /** WCAG criterion, e.g. "1.4.3 Contrast Minimum". */
      wcag_criterion: z.string().optional(),
    }),
  ),
  summary: z.string(),
  passed: z.boolean(),
});

export type IssueReport = z.infer<typeof IssueReportSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

function resolveUrl(base: string | undefined, specUrl: string | undefined): string {
  // A v2 capability has no page of its own: its journeys start from the base URL.
  if (!specUrl) return base ?? '';
  if (!base) return specUrl;
  if (specUrl.startsWith('http://') || specUrl.startsWith('https://')) return specUrl;
  return base.replace(/\/$/, '') + '/' + specUrl.replace(/^\//, '');
}

/**
 * Evidence (screenshots, DOM, saved logins) can hold personal data. Write a
 * `.gitignore` inside the evidence and auth directories so they stay out of
 * version control even when the repo's own ignore file does not mention them.
 */
/** Delete evidence files older than `days`, leaving the `.gitignore` marker. Returns how many were removed. */
export function pruneEvidence(dir: string, days: number, now = Date.now()): number {
  let removed = 0;
  const cutoff = now - days * 86_400_000;
  const walk = (current: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        try {
          if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
        } catch {
          /* leave it */
        }
      } else if (entry.name !== '.gitignore') {
        try {
          if (statSync(full).mtimeMs < cutoff) {
            rmSync(full);
            removed += 1;
          }
        } catch {
          /* leave it */
        }
      }
    }
  };
  walk(dir);
  return removed;
}

async function ensureEvidenceIgnored(config: SpecGuardConfig): Promise<void> {
  for (const dir of ['.specguard/evidence', '.specguard/auth', '.specguard/reports']) {
    try {
      const abs = resolveFromRoot(config, dir);
      await ensureDir(abs);
      // Screenshots, DOM and saved logins can hold personal data and session tokens: this folder is for its owner.
      try {
        chmodSync(abs, 0o700);
      } catch {
        /* no POSIX permissions here (Windows) */
      }
      const marker = path.join(abs, '.gitignore');
      if (!(await fileExists(marker))) await writeFile(marker, '*\n!.gitignore\n');
    } catch {
      /* best-effort: the run does not depend on it */
    }
  }
}

function overallVerdict(verdicts: CriterionVerdict[]): Verdict {
  // No verdict at all is not a pass: nothing was judged.
  if (verdicts.length === 0) return 'INCONCLUSIVE';
  if (verdicts.some((v) => v.verdict === 'FAIL')) return 'FAIL';
  if (verdicts.every((v) => v.verdict === 'PASS')) return 'PASS';
  if (verdicts.some((v) => v.verdict === 'BLOCKED')) return 'BLOCKED';
  return 'INCONCLUSIVE';
}

/** True when any of the three UI-specific spec sections have content. */
function hasUiSections(spec: ParsedSpec): boolean {
  return !!(spec.visualExpectations || spec.accessibilityRequirements || spec.uxGuidelines);
}

/** Write the typed issue report to `.specguard/reports/validate-<spec-key>.json`. */
async function writeIssueReport(
  config: SpecGuardConfig,
  spec: ParsedSpec,
  report: IssueReport,
): Promise<string> {
  const safeKey = spec.specKey.replace(/\//g, '-');
  const reportPath = resolveFromRoot(config, `.specguard/reports/validate-${safeKey}.json`);
  await ensureDir(path.dirname(reportPath));
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  return reportPath;
}

/**
 * Write an agentic verdict per requirement into the proof ledger, so `check`
 * treats browser verification as proof like any other. Only PASS and FAIL
 * count: BLOCKED and INCONCLUSIVE say nothing and must not overwrite a proof
 * a test run already earned.
 */
/** One requirement's verdict from a browser check, as a ledger row. Only PASS and FAIL say anything. */
function agenticRows(spec: ParsedSpec): (verdicts: CriterionVerdict[]) => Array<{ claim: string; verdict: 'proven' | 'failed'; exercised: number; counterexamples: number; evidencePath: string; evidence: 'agentic'; layer: 'functional' }> {
  return (verdicts) => {
    const rows: Array<{ claim: string; verdict: 'proven' | 'failed'; exercised: number; counterexamples: number; evidencePath: string; evidence: 'agentic'; layer: 'functional' }> = [];
    for (const claim of spec.claims) {
      if (!claim.id) continue;
      // The id, exactly or followed by a delimiter, or the claim's own text. Never a substring: `login` must not match `login-valid-code`.
      const hit = verdicts.find((v) => {
        const c = v.criterion.trim();
        return c === claim.id || c.startsWith(`${claim.id}:`) || c.startsWith(`${claim.id} `) || c === claim.text;
      });
      if (!hit || (hit.verdict !== 'PASS' && hit.verdict !== 'FAIL')) continue;
      rows.push({
        claim: `${spec.specKey}#${claim.id}`,
        verdict: hit.verdict === 'PASS' ? 'proven' : 'failed',
        exercised: 1,
        counterexamples: hit.verdict === 'FAIL' ? 1 : 0,
        evidencePath: `.specguard/evidence/${spec.specKey}`,
        evidence: 'agentic',
        layer: 'functional',
      });
    }
    return rows;
  };
}

/**
 * Write an agentic verdict per requirement into the proof ledger, so `check`
 * treats browser verification as proof like any other. Only PASS and FAIL
 * count: BLOCKED and INCONCLUSIVE say nothing and must not overwrite a proof
 * earned some other way. The evidence goes in the `functional` layer, so it sits beside
 * test evidence instead of replacing it.
 */
async function recordAgenticProofs(
  config: SpecGuardConfig,
  spec: ParsedSpec,
  verdicts: CriterionVerdict[],
  runId: string,
): Promise<number> {
  const rows = agenticRows(spec)(verdicts);
  if (rows.length === 0) return 0;
  const res = await ingestVerdicts({ runId, verdicts: rows }, config.rootDir ?? process.cwd());
  return res.updated;
}

/**
 * Turn a passing check into a Playwright test (`verify --emit-tests`). Written only when every step ran, so the
 * test replays something that worked, and never over a file that is already there unless it was generated here.
 * Returns the path written, or a reason it was not.
 */
async function emitPlaywrightTest(
  config: SpecGuardConfig,
  spec: ParsedSpec,
  verdicts: CriterionVerdict[],
  script: JourneyScript,
  redact: (text: string) => string,
): Promise<{ path?: string; skipped?: string }> {
  if (!script.complete) return { skipped: 'a step failed or was blocked, so the run cannot be replayed' };
  if (script.steps.length === 0) return { skipped: 'the check took no browser steps' };
  const passing = agenticRows(spec)(verdicts).filter((r) => r.verdict === 'proven').map((r) => r.claim);
  if (passing.length === 0) return { skipped: 'no requirement passed' };
  const text = renderPlaywrightTest({ specKey: spec.specKey, title: spec.title || spec.specKey, startUrl: script.startUrl, steps: script.steps, passing }, redact);
  if (!text) return { skipped: 'a step holds a value the redactor would mask' };
  const rel = e2eTestPath(config.paths?.e2eTests ?? 'tests/e2e', spec.specKey);
  const abs = resolveFromRoot(config, rel);
  if (await fileExists(abs)) {
    const existing = await fsReadFile(abs, 'utf-8');
    if (!existing.includes('Generated by `specguard verify`')) return { skipped: `${rel} exists and was not generated by specguard` };
  }
  await ensureDir(path.dirname(abs));
  await writeFile(abs, text);
  return { path: rel };
}

async function appendHistory(config: SpecGuardConfig, entry: ValidationEntry): Promise<void> {
  const historyPath = resolveFromRoot(config, '.specguard/validation-history.json');
  let history: ValidationEntry[] = [];
  if (await fileExists(historyPath)) {
    try {
      const raw = await fsReadFile(historyPath, 'utf-8');
      history = JSON.parse(raw) as ValidationEntry[];
    } catch {
      history = [];
    }
  }
  history.push(entry);
  await writeFile(historyPath, JSON.stringify(history, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Collect specs to validate
// ---------------------------------------------------------------------------

/** A v2 capability or component can be verified; the system spec and journey specs cannot. */
function isVerifiable(spec: ParsedSpec): boolean {
  return spec.meta.kind === 'capability' || spec.meta.kind === 'component';
}

/** The journeys and scenarios the agent should walk, as prompt text. Empty for v1 specs. */
function journeyText(spec: ParsedSpec): string {
  if (!isVerifiable(spec)) return '';
  const scenarios = spec.scenarios
    .map((sc) => `- ${sc.name}: ${sc.steps.join(' -> ')} (expect: ${sc.expectedResults.join('; ')})`)
    .join('\n');
  return [spec.sections['Users & Journeys'] ? `User journeys:\n${spec.sections['Users & Journeys']}` : '', scenarios ? `Scenarios:\n${scenarios}` : '']
    .filter(Boolean)
    .join('\n\n');
}

/** Requirements as `id: text` lines, so verdicts can name the claim they are about. */
function requirementsText(spec: ParsedSpec): string {
  return spec.claims.filter((c) => c.id).map((c) => `- ${c.id}: ${c.text}`).join('\n') || spec.acceptanceCriteria;
}

function collectSpecs(config: SpecGuardConfig, opts: ValidateOpts): ParsedSpec[] {
  const apps: AppConfig[] = opts.app
    ? config.apps.filter((a) => a.name === opts.app)
    : config.apps;

  const all: ParsedSpec[] = [];
  for (const app of apps) {
    try {
      all.push(...loadCanonicalSpecs(config, resolveFromRoot(config, app.specDir)));
    } catch {
      // specDir may not exist yet
    }
  }

  if (opts.spec) {
    const key = opts.spec.replace(/\.md$/i, '');
    return all.filter(
      (s) => s.specKey === key || s.specKey.endsWith('/' + key) || s.filePath === opts.spec,
    );
  }

  if (opts.all) {
    // A v2 capability has no page of its own; with a base URL it is verified as a journey from there.
    return all.filter((s) => !!s.meta.url || (opts.baseUrl && isVerifiable(s)));
  }

  return [];
}

// ---------------------------------------------------------------------------
// Per-spec validation loop
// ---------------------------------------------------------------------------

/** The steps a browser check performed, and whether every planned step ran, for turning the check into a test. */
interface JourneyScript {
  steps: ScriptStep[];
  /** False when a step failed, was blocked or could not be recorded: such a run is not replayable. */
  complete: boolean;
  startUrl: string;
}

type ActPage = {
  click?: (sel: string) => Promise<void>;
  fill?: (sel: string, val: string) => Promise<void>;
  goto?: (url: string) => Promise<unknown>;
  textContent?: (sel: string) => Promise<string | null>;
  waitForSelector?: (sel: string, opts?: { timeout?: number }) => Promise<unknown>;
  url?: () => string;
};

type PlannedAction = z.infer<typeof PlannedActionSchema>['actions'][number];

/**
 * Perform one planned step. `done` means it ran (and, for an assertion, held); `failed` means it could not run or
 * the assertion did not hold; `skipped` means the planner gave too little to act on.
 */
async function performAction(page: ActPage, action: PlannedAction, startUrl: string): Promise<{ outcome: 'done' | 'failed' | 'skipped'; step?: ScriptStep; why?: string }> {
  const kind = action.kind ?? (action.selector && action.value ? 'fill' : 'click');
  const step: ScriptStep = { kind, description: action.description, ...(action.selector ? { selector: action.selector } : {}), ...(action.value ? { value: action.value } : {}), ...(action.claim ? { claim: action.claim } : {}) };
  try {
    switch (kind) {
      case 'fill':
        if (!action.selector || !action.value || !page.fill) return { outcome: 'skipped' };
        await page.fill(action.selector, action.value);
        break;
      case 'click':
        if (!action.selector || !page.click) return { outcome: 'skipped' };
        await page.click(action.selector);
        break;
      case 'navigate': {
        if (!action.value || !page.goto) return { outcome: 'skipped' };
        // Stay on the site under test: a link out of it is an outbound action the guardrails do not cover here.
        const target = new URL(action.value, page.url?.() ?? startUrl);
        if (target.origin !== new URL(startUrl).origin) return { outcome: 'failed', why: `navigation leaves the site (${target.origin})` };
        await page.goto(target.toString());
        step.value = `${target.pathname}${target.search}${target.hash}`;
        break;
      }
      case 'waitFor':
        if (!action.selector || !page.waitForSelector) return { outcome: 'skipped' };
        await page.waitForSelector(action.selector, { timeout: 5000 });
        break;
      case 'assertText': {
        if (!action.value || !page.textContent) return { outcome: 'skipped' };
        const text = await page.textContent(action.selector ?? 'body');
        if (!text?.includes(action.value)) return { outcome: 'failed', why: `"${action.value}" is not in ${action.selector ?? 'body'}` };
        break;
      }
    }
  } catch (err) {
    return { outcome: 'failed', why: (err as Error).message.split('\n')[0] };
  }
  return { outcome: 'done', step };
}

async function validateSpec(
  config: SpecGuardConfig,
  spec: ParsedSpec,
  opts: ValidateOpts,
  log: (line: string) => void,
  run: RunContext,
): Promise<{ verdicts: CriterionVerdict[]; evidence: string[]; issueReport?: IssueReport; value?: ValueJudgement; script?: JourneyScript }> {
  const verdicts: CriterionVerdict[] = [];
  const evidenceFiles: string[] = [];
  let issueReportResult: IssueReport | undefined;
  let valueJudgement: ValueJudgement | undefined;
  // What the check did, for turning it into a Playwright test afterwards.
  const script: ScriptStep[] = [];
  let scriptComplete = true;

  const url = resolveUrl(opts.baseUrl, spec.meta.url);
  if (opts.restrictHosts) {
    const target = checkAgentTarget(url, config.validate?.allowedHosts);
    if (!target.ok) {
      log(`[blocked] ${spec.specKey} — ${target.reason}`);
      return { verdicts: [{ criterion: '(target)', verdict: 'BLOCKED', reason: target.reason }], evidence: [] };
    }
  }
  // One spec's check has a wall-clock budget: it stops planning further steps when it is spent.
  const deadline = Date.now() + (config.validate?.timeoutMs ?? 600_000);
  const evidenceDir = resolveFromRoot(config, `.specguard/evidence/${spec.specKey}`);
  await ensureDir(evidenceDir);

  // One browser per run; one context per auth profile.
  let handle: BrowserHandle;
  let pool: SessionPool;
  try {
    await run.browser();
    pool = await run.pool();
  } catch (err) {
    if (err instanceof PlaywrightUnavailableError) {
      log(`[skip] ${spec.specKey} — Playwright not available: ${err.message}`);
      return {
        verdicts: [
          {
            criterion: '(all)',
            verdict: 'INCONCLUSIVE',
            reason: `Playwright not available: install @playwright/test`,
          },
        ],
        evidence: [],
        issueReport: undefined,
      };
    }
    throw err;
  }

  {
    // The spec's auth profile decides which context it runs in (anonymous when it names none).
    const session = await pool.acquire(spec.meta.auth);
    if (spec.meta.auth && session.auth && !session.auth.success) {
      log(`[fail] ${spec.specKey} — auth failed: ${session.auth.error}`);
      return {
        verdicts: [
          {
            criterion: '(auth)',
            verdict: 'FAIL',
            reason: `Authentication failed: ${session.auth.error}`,
          },
        ],
        evidence: [],
        issueReport: undefined,
      };
    }
    handle = session.handle;
    handle._consoleErrors.length = 0;
    if (spec.meta.auth) log(`[auth] ${spec.specKey} — authenticated as ${spec.meta.auth}`);
  }

  const mask = run.redactor.blankSelectors;
  const safe = (text: string, kind: 'dom' | 'a11y' | 'console' | 'text' = 'text') => run.redactor.text(text, kind);

  try {
    // --- PERCEIVE ---
    const snapshot = await navigateTo(handle, url);
    log(`[perceive] ${spec.specKey} — ${url} → HTTP ${snapshot.statusCode}`);

    const screenshotPath = await takeScreenshot(
      handle,
      `${path.basename(spec.specKey)}-initial`,
      evidenceDir,
      { maskSelectors: mask },
    );
    evidenceFiles.push(screenshotPath);

    const a11y = await getAccessibilitySnapshot(handle, run.redactor);

    if (snapshot.statusCode >= 400 && snapshot.statusCode !== 0) {
      verdicts.push({
        criterion: '(navigation)',
        verdict: 'FAIL',
        evidence: `HTTP ${snapshot.statusCode}`,
        reason: `Navigation returned HTTP ${snapshot.statusCode}`,
      });
      await appendHistory(config, {
        specKey: spec.specKey,
        url,
        timestamp: new Date().toISOString(),
        verdicts,
        overallVerdict: 'FAIL',
      });
      return { verdicts, evidence: evidenceFiles, issueReport: undefined };
    }

    // --- PLAN / ACT ---
    // A v1 spec gets one round on its own URL. A v2 capability gets several, so one run can walk a journey across pages.
    const v2 = isVerifiable(spec);
    const rounds = v2 ? (config.validate?.maxRounds ?? 3) : 1;
    const blockedActions: ReturnType<typeof makeBlockedAction>[] = [];
    const taken: string[] = [];
    let currentA11y = a11y;
    let pageUrl = url;
    let pageTitle = snapshot.title;
    for (let round = 1; round <= rounds; round += 1) {
      if (Date.now() > deadline) {
        log(`[timeout] ${spec.specKey} — the ${Math.round((config.validate?.timeoutMs ?? 600_000) / 1000)}s budget for this check is spent; judging what was seen so far`);
        scriptComplete = false;
        break;
      }
      const planPrompt = [
        `You are validating a web application. The spec's acceptance criteria are:`,
        v2 ? requirementsText(spec) : spec.acceptanceCriteria,
        '',
        v2 ? journeyText(spec) : '',
        `Current page: ${pageUrl}`,
        `Page title: ${untrusted('page-title', safe(pageTitle, 'dom'))}`,
        round === 1 ? `HTTP status: ${snapshot.statusCode}` : '',
        snapshot.consoleErrors.length > 0
          ? `Console errors: ${untrusted('console', snapshot.consoleErrors.slice(0, 5).map((e) => safe(e, 'console')).join('; '))}`
          : '',
        '',
        taken.length > 0 ? `Actions already taken: ${taken.join('; ')}` : '',
        `Accessibility tree:`,
        untrusted('page-accessibility-tree', currentA11y.slice(0, 3000)),
        '',
        `List the browser actions needed to verify all acceptance criteria.`,
        `Each action should be atomic (one click, one fill, one navigate).`,
        v2
          ? `Set "kind" to click, fill, navigate (value = a path on this site), waitFor (selector) or assertText (selector, and value = text that must be visible). For a requirement the page can show, add an assertText or waitFor step whose "claim" is that requirement's id, exactly.`
          : '',
        `If a criterion can be verified from the current page state alone, include NO actions for it.`,
        v2 && round > 1 ? `If every journey step has been walked, return no actions.` : '',
        `Keep the action list SHORT — maximum 5 actions.`,
      ]
        .filter(Boolean)
        .join('\n');

      let plannedActions: z.infer<typeof PlannedActionSchema> = { actions: [] };
      try {
        plannedActions = await llmGenerateObject({
          provider: config.llm.provider,
          model: config.llm.model,
          apiKeyEnv: config.llm.apiKeyEnv,
          system: withUntrustedNotice('You are a QA automation planner. Output ONLY valid JSON matching the schema.'),
          prompt: planPrompt,
          schema: PlannedActionSchema,
        });
      } catch {
        // Planning failed — skip actions, proceed to verify from the current state.
      }
      if (round > 1 && plannedActions.actions.length === 0) break;

      // --- ACT ---
      // The prompt asks for at most MAX_ACTIONS_PER_ROUND; the model's answer is not trusted to have kept to it.
      for (const action of plannedActions.actions.slice(0, MAX_ACTIONS_PER_ROUND)) {
        if (Date.now() > deadline) break;
        // Judge the element the action will touch (its role and accessible name), not just the planner's words.
        const target = action.selector ? await inspectTarget(handle, action.selector) : null;
        const classification = classifyAction(action.description, target ?? undefined, run.policy);
        if (isBlocked(classification, run.policy)) {
          const blocked = makeBlockedAction(action.description, classification);
          blockedActions.push(blocked);
          scriptComplete = false;
          log(`[blocked] ${spec.specKey} — ${blocked.reason}: "${action.description}"`);
          continue;
        }

        // Execute the step. A failure does not abort the check, but it is reported and a run with one is not replayable.
        const done = await performAction(handle._page as ActPage, action, url);
        if (done.outcome === 'done') {
          // Only an action that was really performed counts as taken: a planner step with no selector did nothing.
          if (done.step?.kind !== 'assertText' && done.step?.kind !== 'waitFor') taken.push(action.description);
          if (done.step) script.push(done.step);
        } else if (done.outcome === 'failed') {
          scriptComplete = false;
          log(`[action-failed] ${spec.specKey} — ${action.description}${done.why ? `: ${done.why}` : ''}`);
        }
      }
      if (plannedActions.actions.length === 0) break;
      if (round < rounds) {
        currentA11y = await getAccessibilitySnapshot(handle, run.redactor);
        // The journey may have moved to another page: later rounds plan from where it is now.
        const live = handle._page as { url?: () => string; title?: () => Promise<string> };
        try {
          pageUrl = live.url?.() ?? pageUrl;
          pageTitle = (await live.title?.()) ?? pageTitle;
        } catch {
          /* keep the previous page's details */
        }
      }
    }

    // Take post-action screenshot and capture HTML for REVIEW step.
    const postScreenshot = await takeScreenshot(
      handle,
      `${path.basename(spec.specKey)}-post-action`,
      evidenceDir,
      { maskSelectors: mask },
    );
    evidenceFiles.push(postScreenshot);
    const postA11y = await getAccessibilitySnapshot(handle, run.redactor);
    const postHtml = await getPageHtml(handle, 40_000, run.redactor);
    let postSnapshot: typeof snapshot;
    if (v2) {
      // Reloading would discard the state the journey built up.
      let title = snapshot.title;
      try {
        title = (await (handle._page as { title?: () => Promise<string> }).title?.()) ?? title;
      } catch {
        /* keep the first title */
      }
      postSnapshot = { ...snapshot, title, consoleErrors: [...handle._consoleErrors] };
    } else {
      postSnapshot = await navigateTo(handle, handle._page !== null ? (handle._page as { url?: () => string }).url?.() ?? url : url);
    }

    // --- VERIFY ---
    const blockedDescriptions = blockedActions.map((b) => `"${b.description}" (${b.classification})`);
    const verifyPrompt = [
      `You evaluated a web page. Assess each acceptance criterion.`,
      '',
      `Spec: ${spec.title}`,
      `URL: ${url}`,
      v2 ? `Problem & Value this capability exists to deliver:\n${spec.sections['Problem & Value'] ?? spec.overview}\n` : '',
      v2 ? `Requirements (use the requirement id, exactly, as "criterion"):` : `Acceptance Criteria:`,
      v2 ? requirementsText(spec) : spec.acceptanceCriteria,
      '',
      v2 && taken.length > 0 ? `Actions taken during the journey: ${taken.join('; ')}\n` : '',
      `Page state after actions:`,
      `Title: ${untrusted('page-title', safe(postSnapshot.title, 'dom'))}`,
      `HTTP status: ${postSnapshot.statusCode}`,
      postSnapshot.consoleErrors.length > 0
        ? `Console errors: ${untrusted('console', postSnapshot.consoleErrors.slice(0, 5).map((e) => safe(e, 'console')).join('; '))}`
        : '',
      '',
      `Accessibility tree (post-action):`,
      untrusted('page-accessibility-tree', postA11y.slice(0, 3000)),
      '',
      blockedActions.length > 0
        ? `Blocked actions (not executed): ${blockedDescriptions.join(', ')}`
        : '',
      '',
      `For each criterion, assign:`,
      `- PASS: criterion is visibly met in the current page state`,
      `- FAIL: criterion is clearly not met (cite evidence: screenshot path, HTTP status, or console error)`,
      `- BLOCKED: verification requires an action that was blocked by guardrails`,
      `- INCONCLUSIVE: cannot determine from page state alone`,
      ``,
      v2
        ? [
            `Also judge the capability as a whole against its Problem & Value, in "value":`,
            `- delivers: YES when a user would get the stated value from what you observed, PARTIAL when only some, NO when not, INCONCLUSIVE when the page state cannot tell`,
            `- gaps: value the capability promises that the observed behaviour does not deliver (empty when none)`,
            ``,
          ].join('\n')
        : '',
      `Screenshot evidence: ${postScreenshot}`,
    ]
      .filter(Boolean)
      .join('\n');

    let verifyResponse: z.infer<typeof VerifyResponseSchema> = { verdicts: [] };
    try {
      if (v2) {
        const judged = await llmGenerateObject({
          provider: config.llm.provider,
          model: config.llm.model,
          apiKeyEnv: config.llm.apiKeyEnv,
          system: withUntrustedNotice('You are a QA verification agent judging a running system against its stated problem and value. Output ONLY valid JSON matching the schema.'),
          prompt: verifyPrompt,
          schema: VerifyV2Schema,
        });
        verifyResponse = { verdicts: judged.verdicts };
        valueJudgement = judged.value;
      } else {
        verifyResponse = await llmGenerateObject({
          provider: config.llm.provider,
          model: config.llm.model,
          apiKeyEnv: config.llm.apiKeyEnv,
          system: withUntrustedNotice('You are a QA verification agent. Output ONLY valid JSON matching the schema.'),
          prompt: verifyPrompt,
          schema: VerifyResponseSchema,
        });
      }
    } catch (err) {
      // Verification LLM call failed — mark all as INCONCLUSIVE.
      log(`[warn] ${spec.specKey} — verification LLM call failed: ${(err as Error).message}`);
      verdicts.push({
        criterion: '(all)',
        verdict: 'INCONCLUSIVE',
        reason: `Verification LLM call failed: ${(err as Error).message}`,
      });
    }

    for (const v of verifyResponse.verdicts) {
      verdicts.push({
        criterion: v.criterion,
        verdict: v.verdict as Verdict,
        evidence: v.evidence,
        reason: v.reason,
      });
    }

    // Add BLOCKED entries for blocked actions not already in verdicts.
    for (const blocked of blockedActions) {
      const alreadyRecorded = verdicts.some(
        (v) => v.verdict === 'BLOCKED' && v.reason.includes(blocked.description),
      );
      if (!alreadyRecorded) {
        verdicts.push({
          criterion: `(blocked action: ${blocked.description})`,
          verdict: 'BLOCKED',
          reason: blocked.reason,
        });
      }
    }

    // --- REVIEW ---
    // Multimodal issue analysis. Runs when the spec has UI sections and
    // `--no-review` was not passed. Sends screenshot, HTML, and a11y tree to
    // the LLM to produce a typed issue report (functional/ux/accessibility/visual).
    if (!opts.noReview && hasUiSections(spec)) {
      log(`[review] ${spec.specKey} — running multimodal issue analysis`);
      try {
        let screenshotBuffer: Buffer | undefined;
        try {
          if (!run.allowImages) throw new Error('images disabled by llm.allowImages');
          const { readFile: fsReadFileReview } = await import('node:fs/promises');
          screenshotBuffer = await fsReadFileReview(postScreenshot);
        } catch {
          // Screenshot not readable, or images are not allowed — proceed without one.
        }

        const uiSectionsText = [
          spec.visualExpectations ? `## Visual Expectations\n${spec.visualExpectations}` : '',
          spec.accessibilityRequirements
            ? `## Accessibility Requirements\n${spec.accessibilityRequirements}`
            : '',
          spec.uxGuidelines ? `## UX Guidelines\n${spec.uxGuidelines}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');

        const reviewPrompt = [
          `You are a UX, accessibility, and functional QA reviewer. Analyse the provided web page`,
          `against the following specification requirements and identify concrete issues.`,
          ``,
          `Spec: ${spec.title}`,
          `URL: ${url}`,
          ``,
          uiSectionsText,
          ``,
          `Acceptance Criteria (for functional issues):`,
          spec.acceptanceCriteria,
          ``,
          `Accessibility tree:`,
          untrusted('page-accessibility-tree', postA11y.slice(0, 4000)),
          ``,
          `Page HTML (truncated):`,
          untrusted('page-html', postHtml.slice(0, 6000)),
          ``,
          `For each issue found, provide:`,
          `- type: functional | ux | accessibility | visual`,
          `- severity: critical | major | minor`,
          `- description: what is wrong`,
          `- element: CSS selector, aria role/name, or element description (if applicable)`,
          `- recommendation: how to fix it`,
          `- wcag_criterion: WCAG success criterion (if accessibility, e.g. "1.4.3 Contrast Minimum")`,
          ``,
          `If no issues are found, return an empty issues array and passed: true.`,
          `Critical or major issues should set passed: false.`,
        ]
          .filter(Boolean)
          .join('\n');

        issueReportResult = await llmGenerateObject({
          provider: config.llm.provider,
          model: config.llm.model,
          apiKeyEnv: config.llm.apiKeyEnv,
          system: withUntrustedNotice(
            'You are a senior QA engineer specialising in UX, accessibility, and functional correctness. ' +
              'Output ONLY valid JSON matching the schema.',
          ),
          prompt: reviewPrompt,
          schema: IssueReportSchema,
          images: screenshotBuffer ? [screenshotBuffer] : undefined,
        });

        log(`[review] ${spec.specKey} — ${issueReportResult.issues.length} issue(s): ${issueReportResult.summary}`);
      } catch (err) {
        log(`[review-warn] ${spec.specKey} — REVIEW step failed: ${(err as Error).message}`);
      }
    }
  } finally {
    // The pool owns the contexts and the run owns the browser; both are closed once the run ends.
  }

  await appendHistory(config, {
    specKey: spec.specKey,
    url,
    timestamp: new Date().toISOString(),
    verdicts,
    overallVerdict: overallVerdict(verdicts),
    ...(valueJudgement ? { value: valueJudgement } : {}),
  });

  return { verdicts, evidence: evidenceFiles, issueReport: issueReportResult, value: valueJudgement, script: { steps: script, complete: scriptComplete, startUrl: url } };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runValidate(
  config: SpecGuardConfig,
  opts: ValidateOpts,
): Promise<PipelineResult> {
  const result = emptyResult('validate');
  const log = (line: string) => result.messages.push(line);

  if (!opts.spec && !opts.all) {
    throw new SpecGuardError(
      'Nothing to validate: pass --spec <key> or --all.',
      ExitCode.InternalError,
    );
  }

  const specs = collectSpecs(config, opts);

  if (specs.length === 0) {
    log('[warn] No specs found with url: metadata to validate.');
    return result;
  }

  let anyFailed = false;

  // --- run-wide setup: redaction, guardrail policy, one browser, one context per auth profile ---
  const rootDir = config.rootDir ?? process.cwd();
  const cfg = config.validate;
  let hook;
  if (cfg?.redaction?.hookPath) {
    try {
      hook = await loadRedactHook(rootDir, cfg.redaction.hookPath);
    } catch (err) {
      // A redaction hook that cannot load must stop the run: continuing would send unredacted text.
      throw new SpecGuardError(`validate.redaction.hookPath: ${(err as Error).message}`, ExitCode.InternalError);
    }
  }
  const redactor = createRedactor(cfg?.redaction, hook);
  const policy: GuardrailPolicy = {
    deny: cfg?.guardrails?.deny,
    allow: cfg?.guardrails?.allow,
    allowOutbound: opts.allowOutbound ?? cfg?.guardrails?.allowOutbound ?? false,
  };
  const headless = opts.headed ? false : (cfg?.headless ?? true);
  clearSessionCache();

  const launched: { browser?: Promise<BrowserHandle>; pool?: Promise<SessionPool> } = {};
  const run: RunContext = {
    browser: () => {
      launched.browser ??= launchBrowser({
        headless,
        runner: config.runners?.playwright === 'docker' ? 'docker' : 'local',
      });
      return launched.browser;
    },
    pool: () => {
      launched.pool ??= run.browser().then((browser) => new SessionPool(browser, config, rootDir));
      return launched.pool;
    },
    redactor,
    policy,
    allowImages: config.llm.allowImages !== false,
  };
  await ensureEvidenceIgnored(config);
  if (config.validate?.evidenceRetentionDays) {
    const gone = pruneEvidence(resolveFromRoot(config, '.specguard/evidence'), config.validate.evidenceRetentionDays);
    if (gone > 0) log(`[evidence] removed ${gone} file(s) older than ${config.validate.evidenceRetentionDays} day(s)`);
  }

  try {
  for (const spec of specs) {
    if (!spec.meta.url && !opts.baseUrl) {
      log(`[skip] ${spec.specKey} — no url in spec metadata`);
      result.skipped += 1;
      result.items.push({ key: spec.specKey, status: 'skipped', message: 'no url in spec metadata' });
      continue;
    }

    log(`[validate] ${spec.specKey}`);

    try {
      const { verdicts, issueReport, value, script } = await validateSpec(config, spec, opts, log, run);
      const ov = overallVerdict(verdicts);

      for (const v of verdicts) {
        const emoji = v.verdict === 'PASS' ? '✓' : v.verdict === 'FAIL' ? '✗' : '~';
        log(`  ${emoji} [${v.verdict}] ${v.criterion}${v.evidence ? ` — evidence: ${v.evidence}` : ''}`);
      }

      // v2: the verdicts become proofs, and the capability is judged against its stated value.
      let valueFailed = false;
      if (isVerifiable(spec)) {
        const runId = `verify-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        const proven = await recordAgenticProofs(config, spec, verdicts, runId);
        if (proven > 0) log(`[proof] ${spec.specKey} — ${proven} requirement verdict(s) recorded as agentic proof`);
        if ((opts.emitTests || config.validate?.emitTests) && script) {
          const emitted = await emitPlaywrightTest(config, spec, verdicts, script, (t) => run.redactor.text(t));
          log(emitted.path ? `[emit] ${spec.specKey} — Playwright test written to ${emitted.path}` : `[emit] ${spec.specKey} — no Playwright test: ${emitted.skipped}`);
        }
        if (value) {
          log(`  value: ${value.delivers} — ${value.reason}`);
          for (const gap of value.gaps) log(`  ! [gap] ${gap}`);
          valueFailed = value.delivers === 'NO';
          try {
            await writeFile(
              resolveFromRoot(config, `.specguard/reports/verify-${spec.specKey.replace(/[\\/]/g, '-')}.json`),
              JSON.stringify({ spec: spec.specKey, verifiedAt: new Date().toISOString(), verdicts, value }, null, 2) + '\n',
            );
          } catch {
            // best-effort
          }
        }
      }

      // Persist and summarise issue report when present.
      if (issueReport) {
        try {
          const reportPath = await writeIssueReport(config, spec, issueReport);
          log(`[report] ${spec.specKey} → ${reportPath}`);
        } catch {
          // best-effort
        }
        for (const issue of issueReport.issues) {
          const sev = issue.severity.toUpperCase();
          log(`  ! [${sev}][${issue.type}] ${issue.description}${issue.wcag_criterion ? ` (WCAG ${issue.wcag_criterion})` : ''}`);
        }
        if (!issueReport.passed) {
          anyFailed = true;
        }
      }

      if (ov === 'FAIL' || valueFailed || (issueReport && !issueReport.passed)) {
        anyFailed = true;
        result.failed += 1;
        result.items.push({ key: spec.specKey, status: 'failed', message: `verdict: ${ov}` });
      } else {
        result.created += 1;
        result.items.push({ key: spec.specKey, status: 'ok', message: `verdict: ${ov}` });
      }

      log(`[result] ${spec.specKey} → ${ov}`);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      log(`[fail] ${spec.specKey} — ${message}`);
      anyFailed = true;
      result.failed += 1;
      result.items.push({ key: spec.specKey, status: 'failed', message });
    }
  }

  } finally {
    if (launched.pool) await (await launched.pool.catch(() => null))?.closeAll();
    if (launched.browser) {
      const browser = await launched.browser.catch(() => null);
      if (browser) await closeBrowser(browser);
    }
  }

  result.exitCode = anyFailed ? ExitCode.ValidationFailed : ExitCode.Success;

  if (anyFailed) {
    try {
      const { writePlan } = await import('../core/plan-writer.js');
      const failedItems = result.items.filter((i) => i.status === 'failed');
      writePlan({
        pipeline: 'validate',
        title: `Fix Validation Failures — ${failedItems.length} spec(s) failed`,
        summary: `The validate pipeline ran browser automation against your app and found ${failedItems.length} spec(s) ` +
          `where the running application does not match the expected behaviour described in the spec.`,
        sections: [
          {
            heading: 'Failed Specs',
            items: failedItems.map((i) => `\`${i.key}\` — ${i.message ?? 'validation failed'}`),
          },
          {
            heading: 'Fix Steps',
            ordered: true,
            items: [
              'Review the evidence files under `.specguard/evidence/` for each failing spec.',
              'Check whether the app behaviour is wrong (fix source code) or the spec is wrong (update spec).',
              'If fixing source code, run the full test suite to avoid regressions.',
              'If updating the spec, run `specguard drift` afterward to ensure consistency.',
              'Run `specguard validate` to confirm all scenarios pass.',
            ],
          },
        ],
        rootDir: config.rootDir ?? process.cwd(),
      });
    } catch { /* best-effort */ }
  }

  return result;
}
