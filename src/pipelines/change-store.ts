/**
 * The change protocol's files and git reads, kept apart from the stage logic so `history capture` can link a plan
 * to an open change without importing the pipeline that imports it. Two stores live here:
 *
 * - `.specguard/changes/<id>.json`, one committed record per change (declared intent only, see `change-record.ts`);
 * - `.specguard/cache/changes/<id>/{red,green}.json`, gitignored pointers that name the run record of the newest red
 *   and green run plus the hashes taken when it ran. A pointer never says a stage was reached: the stage is detected
 *   from the run record's content and the current files (`change.ts`).
 *
 * Git is only ever called through `execFileSync` with an argument array.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { CHANGE_ID_PATTERN, CHANGES_DIR, parseChangeRecord, serializeChangeRecord, type ChangeRecord } from '../core/change-record.js';
import { writeFile } from '../core/writer.js';

const GIT_BUFFER = 64 * 1024 * 1024;

/** Output of a git command, or undefined when git fails (not a repository, unknown ref, no commits). */
export function gitOut(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_BUFFER });
  } catch {
    return undefined;
  }
}

/** Raw bytes of a git command (a file at a commit), or undefined when git fails. */
export function gitBytes(root: string, args: string[]): Buffer | undefined {
  try {
    return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_BUFFER });
  } catch {
    return undefined;
  }
}

/** The branch HEAD is on; undefined when detached or not a repository. */
export function currentBranch(root: string): string | undefined {
  const name = gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  return name && name !== 'HEAD' ? name : undefined;
}

/** Who is acting: `SPECGUARD_ACTOR`, else git `user.name`, else the login name. */
export function actorName(root: string): string {
  return process.env.SPECGUARD_ACTOR || gitOut(root, ['config', 'user.name'])?.trim() || process.env.USER || 'unknown';
}

export const isChangeId = (id: string): boolean => CHANGE_ID_PATTERN.test(id);

export const changeFile = (root: string, id: string): string => path.join(root, CHANGES_DIR, `${id}.json`);

/** Every record under `.specguard/changes/`, oldest id first; a file that does not parse is reported, not hidden. */
export function loadChanges(root: string): { records: ChangeRecord[]; errors: string[] } {
  const dir = path.join(root, CHANGES_DIR);
  const records: ChangeRecord[] = [];
  const errors: string[] = [];
  if (!existsSync(dir)) return { records, errors };
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const parsed = parseChangeRecord(readFileSync(path.join(dir, name), 'utf8'), `${CHANGES_DIR}/${name}`);
    if (!parsed.ok) errors.push(parsed.error);
    else if (name !== `${parsed.record.id}.json`) errors.push(`${CHANGES_DIR}/${name}: the file name does not match the id ${parsed.record.id}`);
    else records.push(parsed.record);
  }
  return { records, errors };
}

export async function saveChange(root: string, record: ChangeRecord): Promise<void> {
  await writeFile(changeFile(root, record.id), serializeChangeRecord(record));
}

/** Whether a record is open on `branch`: not closed, and (when it names a branch) the same branch. */
export const openOnBranch = (r: ChangeRecord, branch: string | undefined): boolean => !r.closed && (r.branch === undefined || branch === undefined || r.branch === branch);

/** The record `key` names: an exact id, else the one id that starts with it, else the one id that contains it. */
export function pickChange(records: ChangeRecord[], key: string): { ok: true; record: ChangeRecord } | { ok: false; error: string } {
  const exact = records.find((r) => r.id === key);
  if (exact) return { ok: true, record: exact };
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: 'a change id is required' };
  for (const match of [(r: ChangeRecord) => r.id.startsWith(trimmed), (r: ChangeRecord) => r.id.includes(trimmed)]) {
    const hits = records.filter(match);
    if (hits.length === 1) return { ok: true, record: hits[0]! };
    if (hits.length > 1) return { ok: false, error: `"${key}" matches ${hits.length} changes: ${hits.map((h) => h.id).join(', ')}` };
  }
  return { ok: false, error: records.length === 0 ? `no change "${key}": none has been started (specguard change start <capability>)` : `no change "${key}"; known: ${records.map((r) => r.id).join(', ')}` };
}

// ---------------------------------------------------------------------------
// Run pointers
// ---------------------------------------------------------------------------

export type RunKind = 'red' | 'green';

/** What `change red` or `change green` remembers about a run: where its record is and the hashes of the files it ran against. */
export interface RunPointer {
  version: 1;
  changeId: string;
  kind: RunKind;
  /** Id of the run record under `.specguard/runs/` (`<changeId>-red`). The verdicts are read from there. */
  runRecord: string;
  mode: 'working-tree' | 'constructed';
  claimsHash: string;
  testsHash: string;
  ownedHash: string;
  baseOwnedHash: string;
  at: string;
}

export const pointerFile = (root: string, id: string, kind: RunKind): string => path.join(root, '.specguard', 'cache', 'changes', id, `${kind}.json`);

export async function writePointer(root: string, pointer: RunPointer): Promise<void> {
  await writeFile(pointerFile(root, pointer.changeId, pointer.kind), `${JSON.stringify(pointer, null, 2)}\n`);
}

const HASH = /^[0-9a-f]{64}$/;

/** The pointer, or undefined when it is missing or not what this version writes. */
export function readPointer(root: string, id: string, kind: RunKind): RunPointer | undefined {
  try {
    const raw = JSON.parse(readFileSync(pointerFile(root, id, kind), 'utf8')) as Partial<RunPointer>;
    const ok =
      raw.version === 1 && raw.changeId === id && raw.kind === kind && typeof raw.runRecord === 'string' && typeof raw.at === 'string' &&
      (raw.mode === 'working-tree' || raw.mode === 'constructed') &&
      [raw.claimsHash, raw.testsHash, raw.ownedHash, raw.baseOwnedHash].every((h) => typeof h === 'string' && HASH.test(h));
    return ok ? (raw as RunPointer) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Plan links
// ---------------------------------------------------------------------------

/**
 * Record a captured plan on the open changes it belongs to, so `derivePlanApprovals` can use it. A change gets the
 * plan when it is open, is on `branch` (or names none) and either one of its capabilities is among `affects` or the
 * plan was recorded against the system as a whole (`wholeSystem`, which is what happens when no capability could be
 * proposed). Returns the ids of the changes that were updated; a change that already holds the plan is left alone.
 */
export async function linkPlanToOpenChanges(
  root: string,
  planId: string,
  target: { affects: string[]; wholeSystem: boolean; branch?: string },
): Promise<string[]> {
  const linked: string[] = [];
  for (const record of loadChanges(root).records) {
    if (!openOnBranch(record, target.branch) || record.plans.includes(planId)) continue;
    if (!target.wholeSystem && !record.capabilities.some((c) => target.affects.includes(c))) continue;
    await saveChange(root, { ...record, plans: [...record.plans, planId] });
    linked.push(record.id);
  }
  return linked;
}
