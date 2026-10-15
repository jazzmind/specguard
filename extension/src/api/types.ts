/** The parts of the API's responses the extension reads. */

export interface TraceCounts {
  claims: number;
  proven: number;
  failed: number;
  stale: number;
  unexercised: number;
  error: number;
  unproven: number;
  withTests: number;
}

export interface CoverageResponse {
  generated: string;
  totals: TraceCounts & { capabilities: number; ownedFiles: number; sourceFiles: number };
  sourceCoverage: number;
  provenCoverage: number;
  unowned: string[];
  capabilities: Array<{ id: string; title: string; status: string; files: number; tests: number; counts: TraceCounts; provenPercent: number; testedPercent: number }>;
  units: Array<{ unit: string; kind: 'repo' | 'package'; path: string; sourceFiles: number; unowned: number; capabilities: string[]; counts: TraceCounts }>;
}

export interface SpecsResponse {
  specs: Array<{ id: string; title: string; kind: string; specKey: string; file: string; claims: number }>;
}

export interface TraceResponse {
  generated: string;
  nodes: Array<{
    id: string;
    specKey: string;
    kind: string;
    title: string;
    unit: string;
    ownedFiles: string[];
    tests: string[];
    docs: string[];
    counts: TraceCounts;
  }>;
}

export interface FindingsResponse {
  plan: string | null;
  createdAt?: string;
  findings: Array<{ id: string; severity: 'critical' | 'high' | 'moderate' | 'low' | 'info'; type: string; title: string; status: string; version: number; capability: string | null; unit: string | null; files: string[]; externalRef: string | null }>;
}

export interface ContractsResponse {
  generatedAt: string | null;
  nodes: Array<{ id: string; repo: string; spec: string; title: string }>;
  edges: Array<{ consumer: string; provider: string; type: string; lastVerified: string | null }>;
}

export interface ProjectInfo {
  name: string;
  kind: 'working-tree' | 'snapshot';
  commit?: string;
  branch?: string;
  updatedAt?: string;
}
