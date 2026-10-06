/**
 * Shared types for the remediate pipeline and its injectable seams.
 *
 * Spec: specs/pipelines/remediate.md
 */
import type { Advisory, Candidate, Severity } from '../../core/advisory.js';
import type { Verdict, VerdictResult } from '../../core/behavior-verdict.js';
import type { CommandRunner } from '../../core/ecosystems/index.js';
import type { SastResult } from '../security.js';

export type ChangeType = 'dependency' | 'code';

/** Result of one git or gh invocation. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}
/** Synchronous git/gh runner. Tests inject a fake `gh` and a local bare remote. */
export type Exec = (args: string[], cwd: string) => ExecResult;

export type HttpGet = (url: string, headers?: Record<string, string>) => Promise<{ status: number; text: string }>;

/** Everything with side effects, in one injectable bag. */
export interface RemediateDeps {
  run: CommandRunner;
  git: Exec;
  gh: Exec;
  http: HttpGet;
  /** Semgrep seam. Default: the security pipeline's `sast.run`. */
  sast?: (dir: string) => Promise<SastResult>;
  /** gitleaks via the command runner is used when absent. */
  now: () => Date;
  /** Build a temp directory path root. Default os.tmpdir(). */
  tmpRoot?: string;
  /** Disables the LLM analysis entirely (budget exhausted, offline). */
  llm?: boolean;
  /** Code fixer for Semgrep findings. Default: the LLM-backed fixer. */
  codeFix?: import('./apply.js').CodeFixer;
}

export interface RemediateOpts {
  scanOnly?: boolean;
  advisory?: string;
  minSeverity?: Severity;
  allowMajor?: boolean;
  /** Ledger the baseline snapshot starts from. Default: `paths.proofLedger` or `.specguard/proofs.json`. */
  ledger?: string;
  /** `true` push + `gh pr create`; `false` leave the branch; undefined leaves the branch (same as `false`). */
  pr?: boolean;
  dryRun?: boolean;
  /** Skip the (slow) LLM breaking-change analysis. */
  noLlm?: boolean;
  /** Run id override (tests). */
  runId?: string;
  /** Restrict to one app. */
  app?: string;
  /** Ignore a fresh lock (never the default). */
  force?: boolean;
  /** Called with progress lines. */
  onLog?: (line: string) => void;
}

export type FindingKind = 'dependency' | 'sast' | 'secret';

export interface SastIssue {
  kind: 'sast';
  ruleId: string;
  path: string;
  line?: number;
  message: string;
  severity: Severity;
}
export interface SecretIssue {
  kind: 'secret';
  ruleId: string;
  path: string;
  line?: number;
  message: string;
}

export interface DetectionReport {
  advisories: Advisory[];
  suppressed: Array<{ id: string; reason: string; expires?: string }>;
  belowThreshold: Advisory[];
  sast: SastIssue[];
  secrets: SecretIssue[];
  warnings: string[];
  sources: string[];
  threshold: Severity;
}

export interface PlanItem {
  advisories: Advisory[];
  candidate: Candidate;
  /** Other acceptable candidates, smallest first. */
  alternatives: Candidate[];
  branch: string;
  changeType: ChangeType;
  risk: RiskScore;
  breaking?: BreakingAnalysis;
  changelog?: string;
  /** Set for code fixes: the Semgrep finding to patch. */
  issue?: SastIssue;
  skip?: string;
}

export interface RiskScore {
  score: number;
  level: 'low' | 'medium' | 'high';
  factors: string[];
}

export interface BreakingAnalysis {
  summary: string;
  breaking: boolean;
  items: string[];
  confidence: 'low' | 'medium' | 'high';
  /** `llm` when the LLM layer answered; `heuristic` otherwise. */
  source: 'llm' | 'heuristic';
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  parsed: boolean;
  commands: string[];
}

export interface RemediationReport {
  runId: string;
  startedAt: string;
  mode: 'scan-only' | 'dry-run' | 'full';
  baseCommit?: string;
  detection: DetectionReport;
  plan: Array<Pick<PlanItem, 'branch' | 'changeType' | 'risk' | 'breaking' | 'skip'> & { advisoryIds: string[]; candidate: Candidate }>;
  results: ItemReport[];
}

export interface ItemReport {
  branch: string;
  advisoryIds: string[];
  verdict?: Verdict;
  verdictDetail?: VerdictResult;
  changedFiles: FileChange[];
  selectedTests: { claimTagged: number; importing: number; total: number; files: string[] };
  baseline?: TestSummary;
  patched?: TestSummary;
  build?: { ok: boolean; skipped?: boolean };
  typecheck?: { ok: boolean; skipped?: boolean };
  sastDelta?: { before: number; after: number; new: string[] };
  evidence: Record<string, string>;
  prBodyPath?: string;
  pr?: { url?: string; draft: boolean; pushed: boolean; recorded?: boolean };
  commit?: string;
  skipped?: string;
  error?: string;
}
