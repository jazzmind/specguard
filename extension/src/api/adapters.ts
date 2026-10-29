/**
 * Turns the API's responses into the shapes the extension's views already draw. Pure functions, no VS Code imports.
 */
import { resolveEvidenceFile } from '../project-config.js';

import type { AppCoverage, CoverageItem, FindingItem, FindingSeverity, MatrixModel, MatrixRow } from '../dashboard/protocol.js';
import type { CoverageResponse, FindingsResponse, SpecsResponse, TraceResponse } from './types.js';

/**
 * One coverage entry for the whole project: each capability is an item (does it have tests?), and each source file no
 * spec owns is a missing-spec item, so the tree still points at what needs a spec.
 */
export function coverageFromApi(cov: CoverageResponse, specs: SpecsResponse, opts: { name: string; workspaceRoot: string; configDir?: string }): AppCoverage[] {
  const specFile = new Map(specs.specs.map((s) => [s.id, s.file]));
  const items: CoverageItem[] = cov.capabilities.map((c) => {
    const file = specFile.get(c.id);
    return { app: opts.name, key: c.id, hasSpec: true, hasTest: c.tests > 0, ...(file ? { specPath: resolveEvidenceFile(opts.workspaceRoot, opts.configDir ?? opts.workspaceRoot, file) } : {}) };
  });
  for (const file of cov.unowned) items.push({ app: opts.name, key: file, hasSpec: false, hasTest: false });
  return [
    {
      name: opts.name,
      specCount: cov.totals.capabilities,
      sourceCount: cov.totals.sourceFiles,
      testCount: cov.capabilities.filter((c) => c.tests > 0).length,
      percentage: cov.sourceCoverage,
      basis: 'capability',
      items,
    },
  ];
}

export function matrixFromApi(trace: TraceResponse): MatrixModel {
  const rows: MatrixRow[] = trace.nodes
    .filter((n) => n.kind !== 'system')
    .map((n) => ({
      specKey: n.id,
      title: n.title,
      appName: n.unit || 'system',
      sourceModule: n.ownedFiles[0] ?? '',
      hasTests: n.tests.length > 0,
      testCount: n.tests.length,
      hasDocs: n.docs.length > 0,
    }));
  return { generatedAt: trace.generated ?? null, rows };
}

const SEVERITY: Record<FindingsResponse['findings'][number]['severity'], FindingSeverity> = { critical: 'critical', high: 'error', moderate: 'warning', low: 'info', info: 'info' };

/** Unresolved security plan items as findings. Quality and lint findings are not on the server. */
export function findingsFromApi(res: FindingsResponse): FindingItem[] {
  return res.findings.map((f) => ({
    id: f.id,
    severity: SEVERITY[f.severity] ?? 'info',
    category: 'security',
    file: f.files[0] ?? '',
    message: `${f.title}${f.capability ? ` (${f.capability})` : ''}${f.externalRef ? ` [${f.externalRef}]` : ''}`,
    rule: f.type,
    source: res.plan ?? 'security scan',
  }));
}
