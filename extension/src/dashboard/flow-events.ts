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

/**
 * Build CLI args for a pipeline run from the dashboard.
 * Pipelines that require --spec or --all get --all by default so they process
 * all configured apps/specs rather than failing with "nothing to do".
 * Pipelines that need positional args (import) are handled by requiresInput on
 * their PipelineNode and should not be invoked from here.
 */
export function cliArgsFor(pipeline: string, extra: string[] = []): string[] {
  const needsAll = new Set(['docs', 'generate', 'reverse', 'security', 'heal', 'validate']);
  const defaults = needsAll.has(pipeline) ? ['--all'] : [];
  return [pipeline, ...defaults, ...extra];
}
