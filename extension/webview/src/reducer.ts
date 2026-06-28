import type { DashboardEvent, AppCoverage, MatrixModel, ActivityEntry, FindingItem } from './protocol.js';

export type NodeState = 'idle' | 'running' | 'done' | 'failed';
export interface ViewModel {
  nodeStates: Record<string, NodeState>;
  logs: Record<string, string[]>;
  coverage: AppCoverage[];
  matrix: MatrixModel | null;
  artifacts: { kind: string; path: string }[];
  activity: ActivityEntry[];
  findings: FindingItem[];
  errors: string[];
}

export function initialViewModel(): ViewModel {
  return { nodeStates: {}, logs: {}, coverage: [], matrix: null, artifacts: [], activity: [], findings: [], errors: [] };
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
    case 'artifact':
      return { ...vm, artifacts: [...vm.artifacts, { kind: e.kind, path: e.path }].slice(-200) };
    case 'coverage':
      return { ...vm, coverage: e.data };
    case 'matrix':
      return { ...vm, matrix: e.data };
    case 'activity':
      return { ...vm, activity: e.entries };
    case 'findings':
      return { ...vm, findings: e.data };
    case 'error':
      return { ...vm, errors: [...vm.errors, `${e.scope}: ${e.message}`].slice(-50) };
    default:
      return vm;
  }
}
