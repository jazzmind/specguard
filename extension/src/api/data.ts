/**
 * Loads what the dashboard and the sidebar show from the API, in the shapes their views already draw.
 */
import type { AppCoverage, FindingItem, MatrixModel } from '../dashboard/protocol.js';
import { coverageFromApi, findingsFromApi, matrixFromApi } from './adapters.js';
import type { ApiClient } from './client.js';
import type { CoverageResponse, FindingsResponse, SpecsResponse, TraceResponse } from './types.js';

export interface ProjectData {
  apps: AppCoverage[];
  matrix: MatrixModel;
  findings: FindingItem[];
  /** The project has functional (v2) specs. When false the API has nothing to show and callers use the command line instead. */
  functional: boolean;
}

export async function loadProjectData(client: ApiClient, opts: { name: string; workspaceRoot: string; configDir?: string }): Promise<ProjectData> {
  const [coverage, specs] = await Promise.all([client.get<CoverageResponse>('/coverage'), client.get<SpecsResponse>('/specs')]);
  if (coverage.capabilities.length === 0) return { apps: [], matrix: { generatedAt: null, rows: [] }, findings: [], functional: false };
  const [trace, findings] = await Promise.all([client.get<TraceResponse>('/trace'), client.get<FindingsResponse>('/findings')]);
  return {
    apps: coverageFromApi(coverage, specs, opts),
    matrix: matrixFromApi(trace),
    findings: findingsFromApi(findings),
    functional: true,
  };
}
