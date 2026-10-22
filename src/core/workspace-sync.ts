/**
 * Keep a workspace manifest in step with a VS Code `.code-workspace` file.
 *
 * `workspace.json` stays the source of truth. Sync only adds the folders the `.code-workspace`
 * lists, retires the ones it dropped, and lifts an automatic ignore once a repo gets a SpecGuard
 * config. It never overwrites a hand edit: it changes an entry only when it created it and the
 * fields it wrote are still what is in the file.
 *
 * Spec: specs/capabilities/workspaces.md
 */
import path from 'node:path';
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { guessRepoRole, workspaceRepoKey } from './workspace-heuristics.js';
import { readCodeWorkspace, WORKSPACE_REL } from './workspace.js';

type Json = Record<string, unknown>;

/** What sync needs to know about the file system; replaced in tests. */
export interface SyncProbe {
  exists(abs: string): boolean;
  /** Canonical path, so two spellings of one folder are one repo. */
  real(abs: string): string;
  hasConfig(abs: string): boolean;
  role(abs: string): string;
  now(): string;
}

export const fsProbe: SyncProbe = {
  exists: (abs) => existsSync(abs),
  real: (abs) => {
    try {
      return realpathSync.native(abs);
    } catch {
      return path.resolve(abs);
    }
  },
  hasConfig: (abs) => existsSync(path.join(abs, '.specguard', 'config.json')),
  role: (abs) => guessRepoRole(abs),
  now: () => new Date().toISOString(),
};

export type SyncChangeType = 'added' | 'removed' | 'ignored' | 'unignored' | 'updated' | 'missing';

export interface SyncChange {
  type: SyncChangeType;
  key: string;
  detail: string;
}

export interface SyncResult {
  next: Json;
  changes: SyncChange[];
}

export interface SyncOptions {
  /** Directory holding `.specguard/workspace.json`. */
  manifestRoot: string;
  /** Absolute path of the `.code-workspace` file. */
  codeWorkspaceFile: string;
  /** Folders of the `.code-workspace`, as read by `readCodeWorkspace`. */
  folders: { path: string; name?: string }[];
  probe?: SyncProbe;
}

const posix = (p: string): string => p.split(path.sep).join('/');

/** A repo entry's container: `repos` for legacy entries, `units` for kind-repo units. */
function entriesOf(raw: Json): { key: string; entry: Json; from: 'repos' | 'units' }[] {
  const out: { key: string; entry: Json; from: 'repos' | 'units' }[] = [];
  for (const from of ['repos', 'units'] as const) {
    const bucket = raw[from];
    if (!bucket || typeof bucket !== 'object') continue;
    for (const [key, entry] of Object.entries(bucket as Json)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Json;
      if (from === 'units' && e.kind !== 'repo') continue; // packages belong to the monorepo scan
      out.push({ key, entry: e, from });
    }
  }
  return out;
}

function uniqueKey(base: string, parentName: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  const prefixed = `${workspaceRepoKey(parentName)}-${base}`;
  if (!taken.has(prefixed)) return prefixed;
  let n = 2;
  while (taken.has(`${prefixed}-${n}`)) n++;
  return `${prefixed}-${n}`;
}

/** Compute the manifest that results from syncing `raw` with the `.code-workspace` folders. Pure. */
export function syncFromCodeWorkspace(raw: Json, opts: SyncOptions): SyncResult {
  const probe = opts.probe ?? fsProbe;
  const next = JSON.parse(JSON.stringify(raw)) as Json;
  const changes: SyncChange[] = [];
  const cwsDir = path.dirname(opts.codeWorkspaceFile);

  const source = (next.source && typeof next.source === 'object' ? next.source : {}) as Json;
  const autoIgnore = source.autoIgnoreUnconfigured !== false;

  const live = entriesOf(next);
  const taken = new Set<string>(live.map((e) => e.key));
  const byReal = new Map<string, { key: string; entry: Json; from: 'repos' | 'units' }>();
  for (const e of live) {
    const abs = path.resolve(opts.manifestRoot, String(e.entry.path ?? ''));
    byReal.set(probe.real(abs), e);
  }

  const wanted = new Set<string>();
  for (const folder of opts.folders) {
    const abs = path.resolve(cwsDir, folder.path);
    if (!probe.exists(abs)) {
      changes.push({ type: 'missing', key: folder.name ?? path.basename(abs), detail: `${abs} does not exist` });
      continue;
    }
    const real = probe.real(abs);
    wanted.add(real);
    const found = byReal.get(real);
    const hasConfig = probe.hasConfig(abs);

    if (!found) {
      const base = workspaceRepoKey(folder.name ?? path.basename(abs));
      const key = uniqueKey(base, path.basename(path.dirname(abs)), taken);
      taken.add(key);
      const rel = posix(path.relative(opts.manifestRoot, abs)) || '.';
      const role = probe.role(abs);
      const entry: Json = {
        path: rel,
        role,
        origin: 'code-workspace',
        ...(folder.name ? { folderName: folder.name } : {}),
        syncedValues: { path: rel, role },
      };
      let detail = `${rel} as ${role}`;
      if (!hasConfig && autoIgnore) {
        entry.ignore = true;
        entry.ignoreReason = 'auto:no-config';
        detail += ' (ignored: no SpecGuard config)';
      }
      const bucket = ((next.repos as Json | undefined) ?? (next.repos = {})) as Json;
      bucket[key] = entry;
      changes.push({ type: 'added', key, detail });
      continue;
    }

    const { key, entry } = found;
    if (entry.origin !== 'code-workspace') continue; // hand-made entry: leave it alone
    if (entry.ignore === true && entry.ignoreReason === 'auto:no-config' && hasConfig) {
      delete entry.ignore;
      delete entry.ignoreReason;
      changes.push({ type: 'unignored', key, detail: 'a SpecGuard config appeared' });
    }
    if (entry.ignore === true && entry.ignoreReason === 'auto:removed') {
      delete entry.ignore;
      delete entry.ignoreReason;
      changes.push({ type: 'unignored', key, detail: 'the folder is back in the workspace' });
    }
    const synced = (entry.syncedValues ?? {}) as Record<string, string>;
    const role = probe.role(abs);
    if (synced.role !== undefined && entry.role === synced.role && role !== synced.role) {
      entry.role = role;
      entry.syncedValues = { ...synced, role };
      changes.push({ type: 'updated', key, detail: `role ${synced.role} -> ${role}` });
    }
  }

  for (const { key, entry, from } of live) {
    if (entry.origin !== 'code-workspace') continue;
    const abs = path.resolve(opts.manifestRoot, String(entry.path ?? ''));
    if (wanted.has(probe.real(abs))) continue;
    if (!probe.exists(abs) && opts.folders.some((f) => path.resolve(cwsDir, f.path) === abs)) continue; // reported as missing
    const synced = (entry.syncedValues ?? {}) as Record<string, string>;
    const untouched = entry.path === synced.path && entry.role === synced.role && entry.ignore !== true;
    if (untouched) {
      delete (next[from] as Json)[key];
      changes.push({ type: 'removed', key, detail: 'no longer in the .code-workspace' });
    } else if (entry.ignore !== true) {
      entry.ignore = true;
      entry.ignoreReason = 'auto:removed';
      changes.push({ type: 'ignored', key, detail: 'no longer in the .code-workspace, but edited by hand' });
    }
  }

  const changed = changes.some((c) => c.type !== 'missing');
  next.source = {
    ...source,
    codeWorkspace: posix(path.relative(opts.manifestRoot, opts.codeWorkspaceFile)),
    mode: source.mode ?? 'auto',
    autoIgnoreUnconfigured: autoIgnore,
    ...(changed || !source.syncedAt ? { syncedAt: probe.now() } : { syncedAt: source.syncedAt }),
  };
  return { next, changes };
}

/** Read the manifest as raw JSON, so a write never serialises the normalised view. */
export function readRawManifest(manifestRoot: string): { raw: Json; mtimeMs: number } {
  const file = path.join(manifestRoot, WORKSPACE_REL);
  const raw = JSON.parse(readFileSync(file, 'utf-8')) as Json;
  return { raw, mtimeMs: statSync(file).mtimeMs };
}

/** Write the manifest atomically; refuse when it changed on disk since it was read. */
export function writeRawManifest(manifestRoot: string, raw: Json, expectedMtimeMs?: number): void {
  const file = path.join(manifestRoot, WORKSPACE_REL);
  if (expectedMtimeMs !== undefined && existsSync(file) && statSync(file).mtimeMs !== expectedMtimeMs) {
    throw new Error(`${file} changed while it was being updated; run the command again`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, file);
}

/** Sync the manifest at `manifestRoot` with its `.code-workspace` (from `source.codeWorkspace`). */
export function syncManifestOnDisk(manifestRoot: string, codeWorkspaceFile?: string, probe?: SyncProbe): SyncResult {
  const { raw, mtimeMs } = readRawManifest(manifestRoot);
  const linked = (raw.source as Json | undefined)?.codeWorkspace;
  const file = codeWorkspaceFile ?? (typeof linked === 'string' ? path.resolve(manifestRoot, linked) : undefined);
  if (!file) throw new Error('this manifest is not linked to a .code-workspace file; pass one with --from');
  const { folders } = readCodeWorkspace(file);
  const result = syncFromCodeWorkspace(raw, { manifestRoot, codeWorkspaceFile: file, folders, probe });
  writeRawManifest(manifestRoot, result.next, mtimeMs);
  return result;
}

/** Set or clear `ignore` on one entry of the manifest on disk. */
export function setIgnoreOnDisk(manifestRoot: string, key: string, ignore: boolean, reason?: string): void {
  const { raw, mtimeMs } = readRawManifest(manifestRoot);
  const target = entriesOf(raw).find((e) => e.key === key);
  if (!target) throw new Error(`no repo "${key}" in the manifest`);
  if (ignore) {
    target.entry.ignore = true;
    target.entry.ignoreReason = reason ?? 'ignored by hand';
  } else {
    delete target.entry.ignore;
    delete target.entry.ignoreReason;
  }
  writeRawManifest(manifestRoot, raw, mtimeMs);
}
