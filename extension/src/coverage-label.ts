/**
 * Labels for the sidebar and status bar.
 *
 * A capability project does not have one spec per source file. The percentage
 * is how many source files a capability owns. The workspace file count excludes
 * specs/_archive so a consolidated repo is not shown as hundreds of current specs.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import type { AppCoverage } from './dashboard/protocol.js';

export type CoverageBasis = 'capability' | 'file';

export function coverageBasis(app: Pick<AppCoverage, 'basis'>): CoverageBasis {
  return app.basis === 'capability' ? 'capability' : 'file';
}

export function coverageRowLabel(app: Pick<AppCoverage, 'name' | 'percentage' | 'basis'>): string {
  if (coverageBasis(app) === 'capability') return `${app.name} (${app.percentage}% of source)`;
  return `${app.name} (${app.percentage}%)`;
}

export function coverageRowDescription(app: Pick<AppCoverage, 'specCount' | 'sourceCount' | 'basis'>): string {
  if (coverageBasis(app) === 'capability') {
    return `${app.specCount} capabilities · ${app.sourceCount} source files`;
  }
  return `${app.specCount}/${app.sourceCount} specs`;
}

/** Status-bar percentage. Capability rows already store source coverage in `percentage`. */
export function coveragePercent(apps: Array<Pick<AppCoverage, 'percentage' | 'sourceCount'>>): number {
  if (apps.length === 0) return 0;
  let weight = 0;
  let acc = 0;
  for (const app of apps) {
    const w = app.sourceCount > 0 ? app.sourceCount : 1;
    weight += w;
    acc += app.percentage * w;
  }
  return weight === 0 ? 0 : Math.round(acc / weight);
}

export function outputBasis(apps: Array<Pick<AppCoverage, 'basis'>>): CoverageBasis {
  return apps.some((app) => app.basis === 'capability') ? 'capability' : 'file';
}

export function specsOutputDescription(basis: CoverageBasis): string {
  return basis === 'capability' ? 'capabilities' : 'Living Specs';
}

export function testsOutputDescription(count: number, basis: CoverageBasis): string {
  if (count === 0) return basis === 'capability' ? 'none with tests' : 'run generate';
  return basis === 'capability' ? 'capabilities with tests' : 'generated tests';
}

export function docsOutputDescription(count: number, basis: CoverageBasis): string {
  if (count > 0) return 'user-facing docs';
  return basis === 'capability' ? 'served from specs' : 'run docs';
}

export function ageLabel(ageMs: number): string {
  if (ageMs < 3_600_000) return `${Math.max(0, Math.floor(ageMs / 60_000))}m ago`;
  if (ageMs < 48 * 3_600_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
}

const LAYER_ORDER = ['unit', 'integration', 'e2e', 'security', 'functional'];

export interface LayerCount {
  required: number;
  proven: number;
  failed: number;
  stale: number;
  missing: number;
}

/**
 * One row for proof by test layer (`trace.json` totals.layerCounts): proven over required per layer. Undefined when no
 * claim requires a layer, so a project that does not use layers sees no new row.
 */
export function layersRow(counts: Record<string, LayerCount> | undefined): { title: string; description: string; tooltip: string } | undefined {
  const present = LAYER_ORDER.filter((l) => counts?.[l] && counts[l].required > 0);
  if (!counts || present.length === 0) return undefined;
  const lacking = present.reduce((n, l) => n + counts[l].missing + counts[l].stale + counts[l].failed, 0);
  return {
    title: `Layers: ${present.map((l) => `${l} ${counts[l].proven}/${counts[l].required}`).join(' · ')}`,
    description: lacking === 0 ? 'every required layer proven' : `${lacking} to go`,
    tooltip: present
      .map((l) => {
        const c = counts[l];
        const bits = [c.failed ? `${c.failed} failed` : '', c.stale ? `${c.stale} stale` : '', c.missing ? `${c.missing} not proven` : ''].filter(Boolean);
        return `${l}: ${c.proven} of ${c.required} claims proven${bits.length ? ` (${bits.join(', ')})` : ''}`;
      })
      .join('\n'),
  };
}

export function traceRow(input: { traceAgeMs?: number; matrixAgeMs?: number }): { title: string; description: string; tooltip: string } {
  if (input.traceAgeMs !== undefined) {
    return {
      title: 'Traceability: current',
      description: `trace.json · ${ageLabel(input.traceAgeMs)}`,
      tooltip: 'Click to open trace.json',
    };
  }
  if (input.matrixAgeMs !== undefined) {
    return {
      title: 'Traceability: old matrix',
      description: `traceability.json · ${ageLabel(input.matrixAgeMs)}`,
      tooltip: 'This is the pre-0.2 matrix. specguard check writes trace.json.',
    };
  }
  return {
    title: 'Traceability: missing',
    description: 'run check',
    tooltip: 'Run specguard check to write trace.json',
  };
}

export function contractsDescription(staleCount: number, nodeCount: number): string {
  if (staleCount === 0) return `${nodeCount} nodes`;
  return `${staleCount} unverified >30d`;
}
