import type { DashboardEvent, AppCoverage, MatrixModel, ActivityEntry, FindingItem, WorkspaceInfo, PipelineRunInfo, AnalysisRecommendation, FixPlan, PlanItem, ProjectConfig } from './protocol.js';

export type NodeState = 'idle' | 'running' | 'done' | 'failed';
export interface ViewModel {
  nodeStates: Record<string, NodeState>;
  logs: Record<string, string[]>;
  lastRunInfo: Record<string, PipelineRunInfo>;
  coverage: AppCoverage[];
  matrix: MatrixModel | null;
  artifacts: { kind: string; path: string; title?: string; description?: string; category?: string; order?: number }[];
  activity: ActivityEntry[];
  findings: FindingItem[];
  workspace: WorkspaceInfo | null;
  errors: string[];
  /** Which pipeline's log panel is currently expanded in the FlowView. */
  selectedLogPipeline: string | null;
  /** Latest recommendations from the analyze pipeline. */
  analysisRecommendations: AnalysisRecommendation[];
  /** Fix plan awaiting human approval. */
  pendingFixPlan: FixPlan | null;
  /** All plan files in .specguard/plans/ with their metadata. */
  plans: PlanItem[];
  /** LLM config and env vars from .specguard/ (null until first push). */
  projectConfig: ProjectConfig | null;
}

export function initialViewModel(): ViewModel {
  return {
    nodeStates: {},
    logs: {},
    lastRunInfo: {},
    coverage: [],
    matrix: null,
    artifacts: [],
    activity: [],
    findings: [],
    workspace: null,
    errors: [],
    selectedLogPipeline: null,
    analysisRecommendations: [],
    pendingFixPlan: null,
    plans: [],
    projectConfig: null,
  };
}

export function reduce(vm: ViewModel, e: DashboardEvent): ViewModel {
  switch (e.type) {
    case 'pipeline:start':
      return { ...vm, nodeStates: { ...vm.nodeStates, [e.pipeline]: 'running' } };
    case 'pipeline:done': {
      const ok = e.exitCode === 0 || e.exitCode === 4;
      return { ...vm, nodeStates: { ...vm.nodeStates, [e.pipeline]: ok ? 'done' : 'failed' } };
    }
    case 'pipeline:log':
      return { ...vm, logs: { ...vm.logs, [e.pipeline]: [...(vm.logs[e.pipeline] ?? []), e.line] } };
    case 'pipeline:lastRun':
      return { ...vm, lastRunInfo: { ...vm.lastRunInfo, [e.info.pipeline]: e.info } };
    case 'artifact': {
      // Upsert by path so re-scans update existing entries rather than duplicating them.
      const existing = vm.artifacts.filter((a) => a.path !== e.path);
      const entry = { kind: e.kind, path: e.path, title: e.title, description: e.description, category: e.category, order: e.order };
      return { ...vm, artifacts: [...existing, entry].slice(-200) };
    }
    case 'coverage':
      return { ...vm, coverage: e.data };
    case 'matrix':
      return { ...vm, matrix: e.data };
    case 'activity':
      return { ...vm, activity: e.entries };
    case 'findings':
      return { ...vm, findings: e.data };
    case 'workspace':
      return { ...vm, workspace: e.info };
    case 'clearArtifacts':
      return { ...vm, artifacts: [] };
    case 'analyze:result':
      return { ...vm, analysisRecommendations: e.recommendations };
    case 'fix-plan':
      return { ...vm, pendingFixPlan: e.plan };
    case 'plans':
      return { ...vm, plans: e.items };
    case 'projectConfig':
      return { ...vm, projectConfig: e.config };
    case 'error':
      return { ...vm, errors: [...vm.errors, `${e.scope}: ${e.message}`].slice(-50) };
    default:
      return vm;
  }
}
