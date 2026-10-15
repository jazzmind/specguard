/**
 * `specguard spec index`: keep the Capability Map table in `specs/system.md`
 * current. Only the region between the capability-map sentinels is rewritten;
 * everything else in the master spec is hand-owned.
 *
 * Spec: specs/capabilities/spec-authoring.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode } from '../core/exit-codes.js';
import { replaceSentinel } from '../core/sentinels.js';
import { buildSpecGraph } from '../core/spec-graph.js';
import { specsRootDir } from '../core/spec-key.js';
import type { SpecMap } from '../core/spec-map.js';
import { CAPABILITY_MAP_KEY, renderCapabilityMap, renderSystemSpec, type CapabilityRow } from '../core/spec-render.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { writeFile } from '../core/writer.js';

/** One row per capability spec in the repo, ordered by id. */
export async function capabilityRows(config: SpecGuardConfig): Promise<CapabilityRow[]> {
  const graph = await buildSpecGraph(config);
  return [...graph.nodes.values()]
    .filter((n) => n.kind === 'capability')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      title: n.spec.title || n.id,
      value: n.spec.meta.value ?? '',
      status: n.spec.meta.status ?? 'draft',
      specKey: n.specKey,
      claims: n.spec.claims.filter((c) => c.id).length,
    }));
}

/**
 * Create `specs/system.md` from a capability map when it does not exist (or
 * `force`), else refresh its capability table.
 */
export async function writeSystemSpec(
  config: SpecGuardConfig,
  map: SpecMap,
  opts: { force?: boolean; history?: string[]; log?: (line: string) => void } = {},
): Promise<void> {
  const file = path.join(specsRootDir(config), 'system.md');
  const rows = await capabilityRows(config);
  if (opts.force || !fs.existsSync(file)) {
    await writeFile(file, renderSystemSpec({ ...map.system, history: opts.history ?? [] }, rows));
    opts.log?.(`[gen] system (${rows.length} capabilities)`);
    return;
  }
  await refreshCapabilityMap(file, rows);
  opts.log?.('[info] refreshed the capability map in system.md');
}

async function refreshCapabilityMap(file: string, rows: CapabilityRow[]): Promise<boolean> {
  const before = fs.readFileSync(file, 'utf8');
  const after = replaceSentinel(before, CAPABILITY_MAP_KEY, renderCapabilityMap(rows));
  if (after === before) return false;
  await writeFile(file, after);
  return true;
}

export async function runSpecIndex(config: SpecGuardConfig): Promise<PipelineResult> {
  const result = emptyResult('spec-index');
  const file = path.join(specsRootDir(config), 'system.md');
  if (!fs.existsSync(file)) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    result.messages.push('specs/system.md does not exist; run `specguard spec draft` or create it first');
    return result;
  }
  const rows = await capabilityRows(config);
  const changed = await refreshCapabilityMap(file, rows);
  result.created = rows.length;
  if (changed) result.updated = 1;
  result.messages.push(changed ? `capability map updated (${rows.length} capabilities)` : `capability map already current (${rows.length} capabilities)`);
  return result;
}
