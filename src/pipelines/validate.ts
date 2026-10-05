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
 * Spec: specs/pipelines/validate.md
 */
import path from 'node:path';
import { readFile as fsReadFile } from 'node:fs/promises';
import { z } from 'zod';

import type { SpecGuardConfig, AppConfig, PipelineResult, ParsedSpec } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import { loadAllSpecs } from '../core/spec-parser.js';
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
  PlaywrightUnavailableError,
} from '../adapters/playwright.js';
import type { BrowserHandle } from '../adapters/playwright.js';
import { authenticate, clearSessionCache } from '../adapters/auth-state-machine.js';
import { classifyAction, isBlocked, makeBlockedAction } from '../adapters/guardrails.js';

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
}

// ---------------------------------------------------------------------------
// LLM schemas
// ---------------------------------------------------------------------------

const PlannedActionSchema = z.object({
  actions: z.array(
    z.object({
      description: z.string(),
      selector: z.string().optional(),
      value: z.string().optional(),
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

function resolveUrl(base: string | undefined, specUrl: string): string {
  if (!base) return specUrl;
  if (specUrl.startsWith('http://') || specUrl.startsWith('https://')) return specUrl;
  return base.replace(/\/$/, '') + '/' + specUrl.replace(/^\//, '');
}

function overallVerdict(verdicts: CriterionVerdict[]): Verdict {
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

function collectSpecs(config: SpecGuardConfig, opts: ValidateOpts): ParsedSpec[] {
  const apps: AppConfig[] = opts.app
    ? config.apps.filter((a) => a.name === opts.app)
    : config.apps;

  const all: ParsedSpec[] = [];
  for (const app of apps) {
    try {
      all.push(...loadAllSpecs(resolveFromRoot(config, app.specDir)));
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
    return all.filter((s) => !!s.meta.url);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Per-spec validation loop
// ---------------------------------------------------------------------------

async function validateSpec(
  config: SpecGuardConfig,
  spec: ParsedSpec,
  opts: ValidateOpts,
  log: (line: string) => void,
): Promise<{ verdicts: CriterionVerdict[]; evidence: string[]; issueReport?: IssueReport }> {
  const verdicts: CriterionVerdict[] = [];
  const evidenceFiles: string[] = [];
  let issueReportResult: IssueReport | undefined;

  const url = resolveUrl(opts.baseUrl, spec.meta.url!);
  const evidenceDir = resolveFromRoot(config, `.specguard/evidence/${spec.specKey}`);
  await ensureDir(evidenceDir);

  // Launch browser.
  let handle: BrowserHandle;
  try {
    handle = await launchBrowser({ headless: true });
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

  try {
    // Authenticate if required.
    if (spec.meta.auth) {
      if (!opts.reuseSession) clearSessionCache();
      const authResult = await authenticate(handle, spec.meta.auth, config);
      if (!authResult.success) {
        log(`[fail] ${spec.specKey} — auth failed: ${authResult.error}`);
        return {
          verdicts: [
            {
              criterion: '(auth)',
              verdict: 'FAIL',
              reason: `Authentication failed: ${authResult.error}`,
            },
          ],
          evidence: [],
          issueReport: undefined,
        };
      }
      log(`[auth] ${spec.specKey} — authenticated as ${spec.meta.auth}`);
    }

    // --- PERCEIVE ---
    const snapshot = await navigateTo(handle, url);
    log(`[perceive] ${spec.specKey} — ${url} → HTTP ${snapshot.statusCode}`);

    const screenshotPath = await takeScreenshot(
      handle,
      `${path.basename(spec.specKey)}-initial`,
      evidenceDir,
    );
    evidenceFiles.push(screenshotPath);

    const a11y = await getAccessibilitySnapshot(handle);

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

    // --- PLAN ---
    const planPrompt = [
      `You are validating a web application. The spec's acceptance criteria are:`,
      spec.acceptanceCriteria,
      '',
      `Current page: ${url}`,
      `Page title: "${snapshot.title}"`,
      `HTTP status: ${snapshot.statusCode}`,
      snapshot.consoleErrors.length > 0
        ? `Console errors: ${snapshot.consoleErrors.slice(0, 5).join('; ')}`
        : '',
      '',
      `Accessibility tree:`,
      a11y.slice(0, 3000),
      '',
      `List the browser actions needed to verify all acceptance criteria.`,
      `Each action should be atomic (one click, one fill, one navigate).`,
      `If a criterion can be verified from the current page state alone, include NO actions for it.`,
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
        system: 'You are a QA automation planner. Output ONLY valid JSON matching the schema.',
        prompt: planPrompt,
        schema: PlannedActionSchema,
      });
    } catch {
      // Planning failed — skip actions, proceed to verify from initial state.
    }

    // --- ACT ---
    const blockedActions: ReturnType<typeof makeBlockedAction>[] = [];
    for (const action of plannedActions.actions) {
      const classification = classifyAction(action.description);
      if (isBlocked(classification)) {
        const blocked = makeBlockedAction(action.description, classification);
        blockedActions.push(blocked);
        log(`[blocked] ${spec.specKey} — ${blocked.reason}: "${action.description}"`);
        continue;
      }

      // Execute action (best-effort — failures don't abort validation).
      try {
        const page = handle._page as {
          click?: (sel: string) => Promise<void>;
          fill?: (sel: string, val: string) => Promise<void>;
        };
        if (action.selector && action.value && page.fill) {
          await page.fill(action.selector, action.value);
        } else if (action.selector && page.click) {
          await page.click(action.selector);
        }
      } catch {
        // Action failed — continue to verify
      }
    }

    // Take post-action screenshot and capture HTML for REVIEW step.
    const postScreenshot = await takeScreenshot(
      handle,
      `${path.basename(spec.specKey)}-post-action`,
      evidenceDir,
    );
    evidenceFiles.push(postScreenshot);
    const postA11y = await getAccessibilitySnapshot(handle);
    const postHtml = await getPageHtml(handle);
    const postSnapshot = await navigateTo(handle, handle._page !== null ? (handle._page as { url?: () => string }).url?.() ?? url : url);

    // --- VERIFY ---
    const blockedDescriptions = blockedActions.map((b) => `"${b.description}" (${b.classification})`);
    const verifyPrompt = [
      `You evaluated a web page. Assess each acceptance criterion.`,
      '',
      `Spec: ${spec.title}`,
      `URL: ${url}`,
      `Acceptance Criteria:`,
      spec.acceptanceCriteria,
      '',
      `Page state after actions:`,
      `Title: "${postSnapshot.title}"`,
      `HTTP status: ${postSnapshot.statusCode}`,
      postSnapshot.consoleErrors.length > 0
        ? `Console errors: ${postSnapshot.consoleErrors.slice(0, 5).join('; ')}`
        : '',
      '',
      `Accessibility tree (post-action):`,
      postA11y.slice(0, 3000),
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
      `Screenshot evidence: ${postScreenshot}`,
    ]
      .filter(Boolean)
      .join('\n');

    let verifyResponse: z.infer<typeof VerifyResponseSchema> = { verdicts: [] };
    try {
      verifyResponse = await llmGenerateObject({
        provider: config.llm.provider,
        model: config.llm.model,
        apiKeyEnv: config.llm.apiKeyEnv,
        system: 'You are a QA verification agent. Output ONLY valid JSON matching the schema.',
        prompt: verifyPrompt,
        schema: VerifyResponseSchema,
      });
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
          const { readFile: fsReadFileReview } = await import('node:fs/promises');
          screenshotBuffer = await fsReadFileReview(postScreenshot);
        } catch {
          // Screenshot not readable — proceed without image.
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
          postA11y.slice(0, 4000),
          ``,
          `Page HTML (truncated):`,
          postHtml.slice(0, 6000),
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
          system:
            'You are a senior QA engineer specialising in UX, accessibility, and functional correctness. ' +
            'Output ONLY valid JSON matching the schema.',
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
    await closeBrowser(handle);
  }

  await appendHistory(config, {
    specKey: spec.specKey,
    url,
    timestamp: new Date().toISOString(),
    verdicts,
    overallVerdict: overallVerdict(verdicts),
  });

  return { verdicts, evidence: evidenceFiles, issueReport: issueReportResult };
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

  for (const spec of specs) {
    if (!spec.meta.url && !opts.baseUrl) {
      log(`[skip] ${spec.specKey} — no url in spec metadata`);
      result.skipped += 1;
      result.items.push({ key: spec.specKey, status: 'skipped', message: 'no url in spec metadata' });
      continue;
    }

    log(`[validate] ${spec.specKey}`);

    try {
      const { verdicts, issueReport } = await validateSpec(config, spec, opts, log);
      const ov = overallVerdict(verdicts);

      for (const v of verdicts) {
        const emoji = v.verdict === 'PASS' ? '✓' : v.verdict === 'FAIL' ? '✗' : '~';
        log(`  ${emoji} [${v.verdict}] ${v.criterion}${v.evidence ? ` — evidence: ${v.evidence}` : ''}`);
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

      if (ov === 'FAIL' || (issueReport && !issueReport.passed)) {
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
