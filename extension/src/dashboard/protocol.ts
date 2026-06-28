/** Shared message + model contracts between the extension host and the webview. */

export interface CoverageItem { app: string; key: string; hasSpec: boolean; hasTest: boolean; specPath?: string; }
export interface AppCoverage { name: string; specCount: number; sourceCount: number; testCount: number; percentage: number; items: CoverageItem[]; }

export interface MatrixRow { specKey: string; title: string; appName: string; sourceModule: string; hasTests: boolean; testCount: number; hasDocs: boolean; }
export interface MatrixModel { generatedAt: string | null; rows: MatrixRow[]; }

export type PipelineCounts = { created: number; updated: number; skipped: number; failed: number };

export type DashboardEvent =
  | { type: 'pipeline:start'; pipeline: string }
  | { type: 'pipeline:log'; pipeline: string; line: string }
  | { type: 'pipeline:done'; pipeline: string; exitCode: number; counts?: PipelineCounts }
  | { type: 'artifact'; kind: 'spec' | 'test' | 'doc'; path: string; change: 'create' | 'update' }
  | { type: 'matrix'; data: MatrixModel }
  | { type: 'coverage'; data: AppCoverage[] }
  | { type: 'error'; scope: string; message: string };

export type DashboardCommand =
  | { type: 'run'; pipeline: string; args?: string[] }
  | { type: 'refresh' }
  | { type: 'openFile'; path: string };

/** A node in the system-flow graph. `from` lists upstream node ids feeding it. */
export interface PipelineNode { id: string; label: string; kind: 'input' | 'pipeline' | 'artifact'; from: string[]; }

/** The flow graph, mirroring the README architecture diagram. */
export const PIPELINE_NODES: PipelineNode[] = [
  { id: 'docs-in', label: 'PRD / Jira / MD', kind: 'input', from: [] },
  { id: 'code', label: 'Source code', kind: 'input', from: [] },
  { id: 'import', label: 'import', kind: 'pipeline', from: ['docs-in'] },
  { id: 'reverse', label: 'reverse', kind: 'pipeline', from: ['code'] },
  { id: 'specs', label: 'Specs', kind: 'artifact', from: ['import', 'reverse'] },
  { id: 'generate', label: 'generate', kind: 'pipeline', from: ['specs'] },
  { id: 'tests', label: 'Tests', kind: 'artifact', from: ['generate'] },
  { id: 'heal', label: 'heal', kind: 'pipeline', from: ['tests'] },
  { id: 'security', label: 'security', kind: 'pipeline', from: ['specs'] },
  { id: 'validate', label: 'validate', kind: 'pipeline', from: ['specs'] },
  { id: 'docs', label: 'docs', kind: 'pipeline', from: ['specs'] },
  { id: 'user-docs', label: 'User Docs', kind: 'artifact', from: ['docs'] },
  { id: 'drift', label: 'drift', kind: 'pipeline', from: ['specs'] },
  { id: 'matrix', label: 'matrix', kind: 'pipeline', from: ['specs'] },
  { id: 'traceability', label: 'Traceability', kind: 'artifact', from: ['matrix'] },
];

/** Pipelines runnable from the Activity tab and whether they need a confirm. */
export const RUNNABLE_PIPELINES: { id: string; destructive: boolean }[] = [
  { id: 'status', destructive: false },
  { id: 'drift', destructive: false },
  { id: 'matrix', destructive: false },
  { id: 'reverse', destructive: true },
  { id: 'generate', destructive: true },
  { id: 'heal', destructive: true },
  { id: 'security', destructive: true },
  { id: 'docs', destructive: true },
  { id: 'validate', destructive: true },
  { id: 'import', destructive: true },
];
