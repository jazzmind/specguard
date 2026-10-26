/**
 * The hook's ownership index: which files each capability owns, which paths are tests, and which changes are open. The
 * agent edit guard (`src/hooks/entry.ts`) reads it on every tool call, so it is cached at
 * `.specguard/cache/hook-index.json` under a stat-only fingerprint and rebuilt in process only when something that
 * feeds it changed (a spec, the config, a change record or a red record).
 *
 * The top of this module is dependency-free on purpose (node builtins and the decision table's types): the hot path
 * imports it and must not pay for the spec parser, the config schema or git. `buildHookIndex` loads those on demand.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { testFilesHash } from '../core/change-stage.js';
import { HOOK_INDEX_VERSION, type HookIndex } from './decide.js';
import type { SpecGuardConfig } from '../core/types.js';

/** Bump when the builder's output means something different, so an old cache is not trusted. */
export const INDEX_REVISION = 'k1';

export const CONFIG_FILE = '.specguard/config.json';
export const HOOK_INDEX_FILE = '.specguard/cache/hook-index.json';
export const CHANGES_DIRECTORY = '.specguard/changes';
export const CHANGE_CACHE_DIRECTORY = '.specguard/cache/changes';

type IndexedChange = HookIndex['openChanges'][number] & {
  /** The red record is well formed and shows a failing run on unchanged code; its test hash is checked live. */
  redSane?: boolean;
};

/** The cache file: the decision table's index plus what the entry needs around it. */
export interface CachedHookIndex extends HookIndex {
  openChanges: IndexedChange[];
  /** `hooks.onError` from the config, so the entry need not parse the config to apply its error policy. */
  onError?: 'allow' | 'deny';
  /** Things the builder could not judge (a change record that does not parse, a base that does not resolve). */
  notes?: string[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Fingerprint: stat-only, no file is read except the config
// ---------------------------------------------------------------------------------------------------------------------

interface LiteConfig {
  specsRoot: string;
  specDirs: string[];
  onError?: 'allow' | 'deny';
  extendsFiles: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The few config fields the fingerprint and the error policy need, read without the config schema. Never throws. */
export function readLiteConfig(root: string): LiteConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const paths = isRecord(raw.paths) ? raw.paths : {};
  const hooks = isRecord(raw.hooks) ? raw.hooks : {};
  const apps = Array.isArray(raw.apps) ? raw.apps : [];
  const ext = typeof raw.extends === 'string' ? [raw.extends] : Array.isArray(raw.extends) ? raw.extends.filter((e): e is string => typeof e === 'string') : [];
  return {
    specsRoot: typeof paths.specsRoot === 'string' && paths.specsRoot ? paths.specsRoot : 'specs',
    specDirs: apps.flatMap((a) => (isRecord(a) && typeof a.specDir === 'string' ? [a.specDir] : [])),
    ...(hooks.onError === 'deny' || hooks.onError === 'allow' ? { onError: hooks.onError } : {}),
    extendsFiles: ext.map((e) => path.resolve(root, path.dirname(CONFIG_FILE), e)),
  };
}

function statKey(file: string, label: string): string {
  try {
    const s = statSync(file);
    return `${label}\0${s.mtimeMs}\0${s.size}`;
  } catch {
    return `${label}\0-`;
  }
}

/** Every `.md` under `dir` (skipping dependency and VCS directories) as stat keys. */
function walkMarkdown(root: string, dir: string, out: string[]): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(root, full, out);
    else if (e.name.endsWith('.md')) out.push(statKey(full, path.relative(root, full)));
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Cheap staleness key: (path, mtimeMs, size) of the config, every spec file (history entries included: an approval
 * changes what a change may do), every change record and every red record. A stat per file, no reads: well under 10 ms
 * for a few hundred specs. Test and source edits are deliberately absent: tests are re-hashed live and new source files
 * are matched by the capabilities' globs.
 */
export function indexFingerprint(root: string, lite: LiteConfig | null = readLiteConfig(root)): string {
  const parts: string[] = [`v${HOOK_INDEX_VERSION}`, INDEX_REVISION, statKey(path.join(root, CONFIG_FILE), CONFIG_FILE)];
  for (const f of lite?.extendsFiles ?? []) parts.push(statKey(f, `extends:${path.basename(f)}`));

  const specsRoot = path.resolve(root, lite?.specsRoot ?? 'specs');
  const dirs = existsSync(specsRoot) ? [specsRoot] : (lite?.specDirs ?? []).map((d) => path.resolve(root, d));
  for (const d of dirs) walkMarkdown(root, d, parts);

  for (const name of listDir(path.join(root, CHANGES_DIRECTORY))) {
    if (name.endsWith('.json')) parts.push(statKey(path.join(root, CHANGES_DIRECTORY, name), `${CHANGES_DIRECTORY}/${name}`));
  }
  for (const id of listDir(path.join(root, CHANGE_CACHE_DIRECTORY))) {
    parts.push(statKey(path.join(root, CHANGE_CACHE_DIRECTORY, id, 'red.json'), `${CHANGE_CACHE_DIRECTORY}/${id}/red.json`));
  }
  return createHash('sha1').update(parts.join('\n')).digest('hex');
}

// ---------------------------------------------------------------------------------------------------------------------
// Cache file
// ---------------------------------------------------------------------------------------------------------------------

/** The cached index, or null when it is missing, unreadable or from another version. Never throws. */
export function readHookIndexCache(root: string): CachedHookIndex | null {
  try {
    const data: unknown = JSON.parse(readFileSync(path.join(root, HOOK_INDEX_FILE), 'utf8'));
    if (!isRecord(data) || data.version !== HOOK_INDEX_VERSION || typeof data.fingerprint !== 'string') return null;
    if (!isRecord(data.owned) || !Array.isArray(data.capabilities) || !Array.isArray(data.openChanges) || !Array.isArray(data.testGlobs)) return null;
    if (typeof data.specsRoot !== 'string' || typeof data.historyDir !== 'string') return null;
    return data as unknown as CachedHookIndex;
  } catch {
    return null;
  }
}

/** Atomic write (temp file, then rename), so two hooks running at once never read half an index. Returns false when the cache cannot be written. */
export function writeHookIndexCache(root: string, index: CachedHookIndex): boolean {
  const file = path.join(root, HOOK_INDEX_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(index));
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export interface LoadedIndex {
  index: CachedHookIndex;
  /** True when this call built it (the cache was missing or stale). */
  rebuilt: boolean;
  /** False when the rebuilt index could not be cached (read-only checkout). */
  cached: boolean;
}

/** The index for the repository at `root`: the cache when its fingerprint still holds, else a fresh build that is cached. Throws when the build fails. */
export async function loadHookIndex(root: string, opts: { force?: boolean } = {}): Promise<LoadedIndex> {
  const lite = readLiteConfig(root);
  const fingerprint = indexFingerprint(root, lite);
  if (!opts.force) {
    const hit = readHookIndexCache(root);
    if (hit && hit.fingerprint === fingerprint) return { index: hit, rebuilt: false, cached: true };
  }
  const { loadConfig } = await import('../core/config.js');
  const config = await loadConfig(root);
  const index = await buildHookIndex(config);
  index.fingerprint = fingerprint;
  return { index, rebuilt: true, cached: writeHookIndexCache(root, index) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Live red check: tests are re-hashed on every call, because editing one does not change the fingerprint
// ---------------------------------------------------------------------------------------------------------------------

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * Change id -> whether its red evidence still holds right now: the record was sane when the index was built and the
 * locked test files still hash to what the red run saw. A change without red evidence is absent from the map.
 */
export function liveRedValidity(root: string, index: CachedHookIndex): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const c of index.openChanges) {
    if (!c.red) continue;
    if (c.redSane === false) {
      out.set(c.id, false);
      continue;
    }
    const files: Array<{ path: string; sha256: string }> = [];
    for (const rel of c.lockedTests) {
      try {
        files.push({ path: rel, sha256: sha256(readFileSync(path.join(root, rel))) });
      } catch {
        /* a deleted test no longer contributes, so the hash differs from red's */
      }
    }
    out.set(c.id, testFilesHash(files) === c.red.testsHash);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------------------------------

const posixRel = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

const git = (root: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return undefined;
  }
};

/**
 * The test files red locks. `change red` names them (`lockedTests`: exactly the files `testsHash` covers); a record
 * without that list (hand-written, or from an older writer) falls back to the files of its tests, whose ids are
 * `file::title`. Repo-relative POSIX.
 */
function redFiles(record: Record<string, unknown>): string[] {
  const listed = record.lockedTests;
  if (Array.isArray(listed) && listed.every((f) => typeof f === 'string')) return [...new Set(listed as string[])].sort();
  const files = new Set<string>();
  if (!Array.isArray(record.tests)) return [];
  for (const t of record.tests) {
    const id = isRecord(t) && typeof t.id === 'string' ? t.id : '';
    const file = id.split('::')[0]!.replace(/\\/g, '/').replace(/^\.\//, '');
    if (file) files.add(file);
  }
  return [...files].sort();
}

/**
 * What the index says about one red record, from the record alone. The record is the pointer `change red` writes
 * (`.specguard/cache/changes/<id>/red.json`, see `change-store.ts`): the hashes of the files the run saw, the verdicts
 * of the tests it ran and the test files it locks. Red holds while those files still hash to the recorded `testsHash`,
 * the run saw the owned code at base and at least one test failed. It does not re-derive the changed claims, so a spec
 * edited after red is caught by `change status` and CI, not here.
 */
function redFacts(root: string, id: string): Pick<IndexedChange, 'lockedTests' | 'red' | 'redSane'> {
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(path.join(root, CHANGE_CACHE_DIRECTORY, id, 'red.json'), 'utf8'));
  } catch {
    return { lockedTests: [] };
  }
  if (!isRecord(record) || record.changeId !== id || typeof record.testsHash !== 'string') return { lockedTests: [] };
  const lockedTests = redFiles(record);
  const tests = Array.isArray(record.tests) ? record.tests : [];
  const failed = tests.some((t) => isRecord(t) && (t.status === 'fail' || t.status === 'error'));
  const sane = failed && lockedTests.length > 0 && record.ownedHash === record.baseOwnedHash;
  return {
    lockedTests,
    redSane: sane,
    red: { testsHash: record.testsHash, claimsHash: typeof record.claimsHash === 'string' ? record.claimsHash : '', valid: false },
  };
}

/**
 * Build the index from the repository: the spec graph (ownership, enforce levels), the test globs and the open change
 * records. Heavy modules load here, not at import.
 */
export async function buildHookIndex(config: SpecGuardConfig): Promise<CachedHookIndex> {
  const root = path.resolve(config.rootDir ?? process.cwd());
  const [{ buildSpecGraph }, { effectiveEnforce }, { declaredSources, specsRootDir }, { historyDir }] = await Promise.all([
    import('../core/spec-graph.js'),
    import('../core/enforce.js'),
    import('../core/spec-key.js'),
    import('../core/history.js'),
  ]);

  const notes: string[] = [];
  const graph = await buildSpecGraph(config, { warn: () => undefined });

  const owned: Record<string, string[]> = {};
  const capabilities: HookIndex['capabilities'] = [];
  const testGlobs = new Set<string>();
  for (const node of [...graph.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!node.kind) continue;
    capabilities.push({
      id: node.id,
      specFile: posixRel(root, path.resolve(root, node.spec.filePath)),
      enforce: effectiveEnforce(node.spec.meta, config.enforce),
      sources: declaredSources(node.spec),
    });
    for (const file of node.ownedFiles) (owned[file] ??= []).push(node.id);
    for (const t of node.spec.meta.tests ?? []) testGlobs.add(t);
  }
  for (const app of config.apps) for (const t of [...(app.sources.tests ?? []), ...(app.extraTestSources ?? [])]) testGlobs.add(t);

  const openChanges = await openChangesOf(config, root, graph, notes);

  return {
    version: HOOK_INDEX_VERSION,
    builtAt: new Date().toISOString(),
    fingerprint: indexFingerprint(root),
    specsRoot: posixRel(root, specsRootDir(config)),
    historyDir: posixRel(root, historyDir(config)),
    testGlobs: [...testGlobs],
    owned: Object.fromEntries(Object.entries(owned).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    capabilities,
    openChanges,
    onError: config.hooks?.onError === 'deny' ? 'deny' : 'allow',
    ...(notes.length > 0 ? { notes } : {}),
  };
}

type Graph = Awaited<ReturnType<typeof import('../core/spec-graph.js').buildSpecGraph>>;

async function openChangesOf(config: SpecGuardConfig, root: string, graph: Graph, notes: string[]): Promise<IndexedChange[]> {
  const dir = path.join(root, CHANGES_DIRECTORY);
  const files = listDir(dir).filter((n) => n.endsWith('.json'));
  if (files.length === 0) return [];
  const { parseChangeRecord } = await import('../core/change-record.js');

  const out: IndexedChange[] = [];
  const features: Array<{ record: import('../core/change-record.js').ChangeRecord; slot: IndexedChange }> = [];
  for (const name of files) {
    const parsed = parseChangeRecord(readFileSync(path.join(dir, name), 'utf8'), `${CHANGES_DIRECTORY}/${name}`);
    if (!parsed.ok) {
      notes.push(parsed.error);
      continue;
    }
    const { record } = parsed;
    if (record.closed) continue;
    const red = redFacts(root, record.id);
    const slot: IndexedChange = {
      id: record.id,
      kind: record.kind,
      capabilities: [...record.capabilities],
      lockedTests: red.lockedTests,
      ...(red.red ? { red: red.red } : {}),
      ...(red.redSane !== undefined ? { redSane: red.redSane } : {}),
      approvedAll: true,
    };
    out.push(slot);
    if (record.kind === 'feature') features.push({ record, slot });
  }

  if (features.length > 0) await judgeApprovals(config, root, graph, features, notes);

  // The red record's validity as of now (the entry re-checks it live, which is what matters between rebuilds).
  const live = liveRedValidity(root, { openChanges: out } as CachedHookIndex);
  for (const c of out) if (c.red) c.red.valid = live.get(c.id) === true;
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * `approvedAll` for feature changes: every added or modified claim of the change's capabilities, against the base the
 * change was started from, has an approval at its current wording (a recorded approval or its linked plan's). When the
 * base cannot be resolved or git is missing it stays true, a conservative answer for a guard that fails open: CI and
 * `change status` judge approvals properly. This duplicates a slice of the change pipeline's status on purpose, so the
 * hook does not wait for or load it.
 */
async function judgeApprovals(
  config: SpecGuardConfig,
  root: string,
  graph: Graph,
  features: Array<{ record: import('../core/change-record.js').ChangeRecord; slot: IndexedChange }>,
  notes: string[],
): Promise<void> {
  const [{ pickBase }, { diffClaims }, { derivePlanApprovals }, { approvalsFrom, indexApprovals }, { listHistory }, { parseSpecContent }, { specsRootDir }] =
    await Promise.all([
      import('../core/change-base.js'),
      import('../core/change-claims.js'),
      import('../core/change-record.js'),
      import('../core/approvals.js'),
      import('../core/history.js'),
      import('../core/spec-parser.js'),
      import('../core/spec-key.js'),
    ]);
  const history = listHistory(config);
  const recorded = approvalsFrom(history);
  const specsRoot = specsRootDir(config);

  const resolve = (ref: string): string | undefined => git(root, ['merge-base', 'HEAD', ref]) || undefined;
  const originHead = git(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);

  for (const { record, slot } of features) {
    const base = pickBase({ recordBaseRef: record.baseRef, configBaseRef: config.change?.baseRef, originHead }, resolve);
    if (!base.ok) {
      notes.push(`${record.id}: ${base.error}; approvals were not checked`);
      continue;
    }
    const was = new Map<string, import('../core/types.js').ParsedSpec | undefined>();
    const now = new Map<string, import('../core/types.js').ParsedSpec | undefined>();
    for (const cap of record.capabilities) {
      const node = graph.nodes.get(cap);
      if (!node) continue;
      const abs = path.resolve(root, node.spec.filePath);
      const text = git(root, ['show', `${base.sha}:./${posixRel(root, abs)}`]);
      was.set(cap, text === undefined ? undefined : parseSpecContent(text, abs, specsRoot));
      now.set(cap, node.spec);
    }
    const changed = diffClaims(was, now).filter((c) => c.change !== 'removed' && c.hash);
    const plans = history.filter((h) => record.plans.includes(h.id));
    const approvals = indexApprovals([...recorded, ...derivePlanApprovals(record, plans, changed)]);
    slot.approvedAll = changed.length > 0 && changed.every((c) => approvals.find(c.ref, c.hash!) !== undefined);
  }
}
