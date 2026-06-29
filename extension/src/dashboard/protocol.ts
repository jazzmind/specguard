/** Shared message + model contracts between the extension host and the webview. */

export type ActivityStatus = 'running' | 'pass' | 'fail' | 'error' | 'info';
export type ActivitySource = 'extension' | 'mcp' | 'cli';

export interface ActivityEntry {
  id: string;
  timestamp: number;
  pipeline: string;
  status: ActivityStatus;
  source: ActivitySource;
  message?: string;
  durationMs?: number;
  counts?: { created?: number; updated?: number; skipped?: number; failed?: number };
  /** Full log output captured during this run. */
  logLines?: string[];
}

export interface CoverageItem { app: string; key: string; hasSpec: boolean; hasTest: boolean; specPath?: string; }
export interface AppCoverage { name: string; specCount: number; sourceCount: number; testCount: number; percentage: number; items: CoverageItem[]; }

export interface MatrixRow { specKey: string; title: string; appName: string; sourceModule: string; hasTests: boolean; testCount: number; hasDocs: boolean; }
export interface MatrixModel { generatedAt: string | null; rows: MatrixRow[]; }

export type PipelineCounts = { created: number; updated: number; skipped: number; failed: number };

/** Summary of the most recent run of a pipeline. */
export interface PipelineRunInfo {
  pipeline: string;
  status: 'pass' | 'fail' | 'running';
  exitCode: number;
  /** ISO timestamp of completion. */
  finishedAt: string;
  /** Last few log lines (for showing inline errors). */
  tail: string[];
  /**
   * Number of findings reported by the pipeline (e.g. `deps: 54 finding(s)`).
   * A value of 0 means the pipeline passed cleanly with nothing to fix.
   * Undefined means the pipeline did not report findings (non-finding pipeline).
   */
  findingCount?: number;
}

export interface WorkspaceInfo {
  name: string;
  path: string;
  configFound: boolean;
  appCount: number;
  configApps: string[];
}

/** A recommended action from the analyze pipeline. */
export interface AnalysisRecommendation {
  pipeline: string;
  reason: string;
  priority: 'high' | 'medium' | 'low';
}

/** A single step in a fix plan produced by the plan-fix pipeline. */
export interface FixPlanStep {
  id: string;
  description: string;
  action: 'run-pipeline' | 'edit-file' | 'run-command';
  pipeline?: string;
  file?: string;
  content?: string;
  command?: string;
}

export interface FixPlan {
  title: string;
  summary: string;
  steps: FixPlanStep[];
  /** Pipeline that produced the failures this plan addresses. */
  sourcePipeline: string;
}

/** A plan file found in .specguard/plans/. */
export interface PlanItem {
  filePath: string;
  title: string;
  pipeline: string;
  generatedAt: string;
  status: 'pending' | 'in-progress' | 'done';
  specKey?: string;
  completedAt?: string;
}

export type DashboardTab = 'overview' | 'flow' | 'activity' | 'findings' | 'coverage' | 'matrix' | 'docs' | 'plans';

export type DashboardEvent =
  | { type: 'pipeline:start'; pipeline: string }
  | { type: 'pipeline:log'; pipeline: string; line: string }
  | { type: 'pipeline:done'; pipeline: string; exitCode: number; counts?: PipelineCounts }
  | { type: 'pipeline:lastRun'; info: PipelineRunInfo }
  | { type: 'artifact'; kind: 'spec' | 'test' | 'doc'; path: string; change: 'create' | 'update'; title?: string; description?: string; category?: string; order?: number }
  | { type: 'matrix'; data: MatrixModel }
  | { type: 'coverage'; data: AppCoverage[] }
  | { type: 'activity'; entries: ActivityEntry[] }
  | { type: 'findings'; data: FindingItem[] }
  | { type: 'workspace'; info: WorkspaceInfo }
  | { type: 'analyze:result'; recommendations: AnalysisRecommendation[] }
  | { type: 'fix-plan'; plan: FixPlan | null }
  | { type: 'plans'; items: PlanItem[] }
  | { type: 'clearArtifacts' }
  | { type: 'error'; scope: string; message: string }
  /** Navigate to a tab and optionally scroll to a pipeline card. */
  | { type: 'navigate'; tab: DashboardTab; scrollTo?: string };

export type FindingSeverity = 'critical' | 'error' | 'warning' | 'info';
export type FindingCategory = 'lint' | 'security' | 'deps' | 'dead-code' | 'quality';

export interface FindingItem {
  id: string;
  severity: FindingSeverity;
  category: FindingCategory;
  file: string;
  line?: number;
  message: string;
  rule?: string;
  source: string;
}

export type DashboardCommand =
  | { type: 'run'; pipeline: string; args?: string[] }
  | { type: 'cancel'; pipeline: string }
  | { type: 'runSequence'; pipelines: string[] }
  | { type: 'runSequenceBatch'; pipelines: string[] }
  | { type: 'refresh' }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'clearActivity'; scope: 'all' | 'completed' }
  | { type: 'markPlanStatus'; filePath: string; status: 'pending' | 'in-progress' | 'done' };

/**
 * A node in the system-flow graph.
 * - `from`: upstream node ids feeding it
 * - `description`: shown as a subtitle under the label
 * - `requiresInput`: if true, node is not directly runnable from the flow (needs extra CLI args)
 */
export interface PipelineNode {
  id: string;
  label: string;
  kind: 'input' | 'pipeline' | 'artifact';
  from: string[];
  description?: string;
  requiresInput?: boolean;
}

/** The flow graph, mirroring the README architecture diagram. */
export const PIPELINE_NODES: PipelineNode[] = [
  { id: 'docs-in', label: 'PRD / Jira / MD', kind: 'input', from: [], description: 'Source documents' },
  { id: 'code', label: 'Source code', kind: 'input', from: [], description: 'Your source files' },
  {
    id: 'import', label: 'import', kind: 'pipeline', from: ['docs-in'],
    description: 'Convert a PRD, Jira ticket, or doc into a Living Spec',
    requiresInput: true,
  },
  {
    id: 'reverse', label: 'reverse', kind: 'pipeline', from: ['code'],
    description: 'Reverse-engineer Living Specs from existing source code',
  },
  { id: 'specs', label: 'Specs', kind: 'artifact', from: ['import', 'reverse'], description: 'Living Specification files' },
  {
    id: 'generate', label: 'generate', kind: 'pipeline', from: ['specs'],
    description: 'Generate test code from specs',
  },
  { id: 'tests', label: 'Tests', kind: 'artifact', from: ['generate'], description: 'Generated test files' },
  {
    id: 'heal', label: 'heal', kind: 'pipeline', from: ['tests'],
    description: 'Self-heal failing generated tests with LLM assistance',
  },
  {
    id: 'security', label: 'security', kind: 'pipeline', from: ['specs'],
    description: 'Generate security tests and run static analysis (SAST)',
  },
  {
    id: 'validate', label: 'validate', kind: 'pipeline', from: ['specs'],
    description: 'Validate specs against the running app via browser automation',
  },
  {
    id: 'docs', label: 'docs', kind: 'pipeline', from: ['specs'],
    description: 'Generate user-facing documentation from specs',
  },
  { id: 'user-docs', label: 'User Docs', kind: 'artifact', from: ['docs'], description: 'Generated documentation' },
  {
    id: 'drift', label: 'drift', kind: 'pipeline', from: ['specs'],
    description: 'Detect specs that are out of sync with the current source code',
  },
  {
    id: 'matrix', label: 'matrix', kind: 'pipeline', from: ['specs'],
    description: 'Build traceability matrix linking specs to tests and docs',
  },
  { id: 'traceability', label: 'Traceability', kind: 'artifact', from: ['matrix'], description: 'Spec → test → doc map' },
  {
    id: 'quality', label: 'quality', kind: 'pipeline', from: ['code'],
    description: 'Run ESLint and dead-code checks (Knip)',
  },
  {
    id: 'deps', label: 'deps', kind: 'pipeline', from: ['code'],
    description: 'Audit dependencies for vulnerabilities and unused packages',
  },
  {
    id: 'commit', label: 'commit', kind: 'pipeline', from: ['tests', 'user-docs', 'traceability'],
    description: 'Stage and commit all SpecGuard-generated files',
  },
  {
    id: 'gap-analysis', label: 'gap-analysis', kind: 'pipeline', from: ['specs'],
    description: 'Detect unimplemented specs and generate implementation plans',
  },
  {
    id: 'analyze', label: 'analyze', kind: 'pipeline', from: ['specs', 'code'],
    description: 'Run all diagnostic checks and get prioritised pipeline recommendations',
  },
  {
    id: 'plan-fix', label: 'plan-fix', kind: 'pipeline', from: ['specs'],
    description: 'Generate an agent-consumable fix plan from pipeline findings',
  },
];

/** Pipelines runnable from the Activity tab and whether they need a confirm. */
export const RUNNABLE_PIPELINES: { id: string; destructive: boolean; label?: string }[] = [
  { id: 'status', destructive: false },
  { id: 'drift', destructive: false },
  { id: 'matrix', destructive: false },
  { id: 'quality', destructive: false, label: 'quality (lint + dead code)' },
  { id: 'deps', destructive: false, label: 'deps (audit + unused)' },
  { id: 'analyze', destructive: false, label: 'analyze (smart diagnostics)' },
  { id: 'gap-analysis', destructive: true, label: 'gap-analysis (unimplemented specs → plans)' },
  { id: 'reverse', destructive: true },
  { id: 'generate', destructive: true },
  { id: 'heal', destructive: true },
  { id: 'security', destructive: true },
  { id: 'docs', destructive: true },
  { id: 'validate', destructive: true },
  { id: 'import', destructive: true },
  { id: 'commit', destructive: true, label: 'commit (stage specguard files)' },
];
