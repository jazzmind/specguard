import type { DashboardEvent } from './protocol.js';

/** Map a changed file path to an artifact event, or null if not a tracked artifact. */
export function artifactEventFor(path: string, change: 'create' | 'update'): DashboardEvent | null {
  const p = path.replace(/\\/g, '/');
  let kind: 'spec' | 'test' | 'doc' | null = null;
  if (/(^|\/)specs\/.+\.md$/.test(p)) kind = 'spec';
  else if (/(^|\/)tests\/.+\.(test|spec)\.(ts|js)$/.test(p)) kind = 'test';
  else if (/(^|\/)docs\/.+\.md$/.test(p)) kind = 'doc';
  return kind ? { type: 'artifact', kind, path: p, change } : null;
}

/** Build CLI args for a pipeline run. */
export function cliArgsFor(pipeline: string, extra: string[] = []): string[] {
  return [pipeline, ...extra];
}
