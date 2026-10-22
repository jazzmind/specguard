import { describe, expect, it } from 'vitest';
import {
  contractsDescription,
  coveragePercent,
  coverageRowDescription,
  coverageRowLabel,
  docsOutputDescription,
  layersRow,
  testsOutputDescription,
  traceRow,
} from './coverage-label.js';

describe('coverage labels [vscode-dashboard]', () => {
  const capability = { name: 'admin-app', specCount: 9, sourceCount: 228, percentage: 100, basis: 'capability' as const };

  it('shows capabilities and source files as separate counts', () => {
    expect(coverageRowLabel(capability)).toBe('admin-app (100% of source)');
    expect(coverageRowDescription(capability)).toBe('9 capabilities · 228 source files');
  });

  it('keeps the per-file fraction for a file-shaped report', () => {
    const file = { name: 'core', specCount: 8, sourceCount: 9, percentage: 89, basis: 'file' as const };
    expect(coverageRowLabel(file)).toBe('core (89%)');
    expect(coverageRowDescription(file)).toBe('8/9 specs');
  });

  it('uses source coverage for the status bar instead of capabilities divided by files', () => {
    expect(coveragePercent([capability])).toBe(100);
    expect(coveragePercent([])).toBe(0);
  });

  it('names an empty docs folder as served from specs when the project is capability-shaped', () => {
    expect(docsOutputDescription(0, 'capability')).toBe('served from specs');
    expect(docsOutputDescription(0, 'file')).toBe('run docs');
    expect(testsOutputDescription(5, 'capability')).toBe('capabilities with tests');
  });

  it('prefers trace.json and calls an old matrix by its name', () => {
    expect(traceRow({ traceAgeMs: 60_000 }).title).toBe('Traceability: current');
    expect(traceRow({ matrixAgeMs: 8 * 86_400_000 }).description).toContain('traceability.json');
    expect(traceRow({}).description).toBe('run check');
  });

  it('calls a contract edge unverified when it is past 30 days', () => {
    expect(contractsDescription(50, 59)).toBe('50 unverified >30d');
    expect(contractsDescription(0, 59)).toBe('59 nodes');
  });
});

describe('proof by layer row [vscode-dashboard]', () => {
  const c = (required: number, proven: number, over: Partial<{ failed: number; stale: number; missing: number }> = {}) => ({ required, proven, failed: 0, stale: 0, missing: required - proven, ...over });

  it('is absent when no claim requires a layer', () => {
    expect(layersRow(undefined)).toBeUndefined();
    expect(layersRow({})).toBeUndefined();
    expect(layersRow({ unit: c(0, 0) })).toBeUndefined();
  });

  it('shows proven over required in a fixed order, with what is left', () => {
    const row = layersRow({ e2e: c(4, 1, { stale: 1, missing: 2 }), unit: c(40, 38, { missing: 2 }), functional: c(0, 0) })!;
    expect(row.title).toBe('Layers: unit 38/40 · e2e 1/4');
    expect(row.description).toBe('5 to go');
    expect(row.tooltip).toBe('unit: 38 of 40 claims proven (2 not proven)\ne2e: 1 of 4 claims proven (1 stale, 2 not proven)');
    expect(layersRow({ unit: c(3, 3) })!.description).toBe('every required layer proven');
  });
});

