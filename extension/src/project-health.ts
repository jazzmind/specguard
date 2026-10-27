/** Read current catalog/spec links and the versions behind the last check. No timestamps imply proof. */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { glob } from 'tinyglobby';
import { parse } from 'yaml';
import { collectOutputs, markdownMeta, readProjectSettings } from './output-inventory.js';

export interface CatalogHealth {
  directory: string;
  files: Array<{ path: string; name: string; version: string; features: number }>;
  revision: string;
  features: number;
  linked: number;
  missing: string[];
  error?: string;
}
export interface ProjectHealth {
  setupVersion: string | null;
  extensionVersion: string;
  setupCurrent: boolean;
  specFormat: 'capability' | 'legacy' | 'missing';
  codeRevision: string | null;
  checkedRevision: string | null;
  dirty: boolean | null;
  codeCurrent: boolean;
  checkedWith: string | null;
  checkVersionCurrent: boolean;
  counts: { claims: number; proven: number; failed: number; stale: number } | null;
  catalog: CatalogHealth | null;
  error?: string;
}
const git = promisify(execFile);
const readJson = (file: string): Record<string, unknown> | null => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return null; }
};

export async function projectHealth(root: string, configDir: string, version: string, fallbackCatalog?: string): Promise<ProjectHealth> {
  const stored = readJson(path.join(configDir, '.specguard', 'sg-version.json'));
  const trace = readJson(path.join(configDir, '.specguard', 'trace.json'));
  const checked = (trace?.statement as { head?: unknown } | undefined)?.head;
  const checkedWith = (trace?.tool as { version?: unknown } | undefined)?.version;
  const totals = trace?.totals as Record<string, unknown> | undefined;
  const counts = totals && ['claims', 'proven', 'failed', 'stale'].every((key) => typeof totals[key] === 'number' && Number.isFinite(totals[key]))
    ? { claims: totals.claims as number, proven: totals.proven as number, failed: totals.failed as number, stale: totals.stale as number } : null;
  const health: ProjectHealth = {
    setupVersion: typeof stored?.version === 'string' ? stored.version : null,
    extensionVersion: version,
    setupCurrent: stored?.version === version,
    specFormat: 'missing', codeRevision: null,
    checkedRevision: typeof checked === 'string' ? checked : null,
    dirty: null, codeCurrent: false, catalog: null,
    checkedWith: typeof checkedWith === 'string' ? checkedWith : null,
    checkVersionCurrent: checkedWith === version,
    counts,
  };
  try {
    const [head, status] = await Promise.all([
      git('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 3000 }),
      git('git', ['status', '--porcelain', '-z', '--untracked-files=normal'], { cwd: root, timeout: 3000 }),
    ]);
    health.codeRevision = head.stdout.trim();
    // A check rewrites its own evidence; that alone is not an uncommitted code change.
    health.dirty = status.stdout.split('\0').filter(Boolean).some((line) => !/^\.specguard\/(trace|proofs|rollup|sg-version)\.json$/.test(line.slice(3)));
    health.codeCurrent = health.codeRevision === health.checkedRevision && !health.dirty;
  } catch { /* no Git revision is explicitly unknown */ }
  try {
    const config = readProjectSettings(configDir);
    const specs = await collectOutputs('specs', root, configDir);
    const refs = new Set<string>();
    const tagged = new Set<string>();
    for (const spec of specs) {
      const text = fs.readFileSync(spec.path, 'utf8');
      const meta = markdownMeta(text);
      if (['system', 'capability', 'component', 'journey'].includes(String(meta.kind))) health.specFormat = 'capability';
      else if (health.specFormat === 'missing') health.specFormat = 'legacy';
      if (typeof meta.id === 'string') refs.add(meta.id);
      const feature = meta.feature ?? [...text.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => /^\s*feature:\s*(.+)$/m.exec(m[1])?.[1]).find(Boolean);
      for (const id of Array.isArray(feature) ? feature.map(String) : String(feature ?? '').split(',')) if (id.trim()) tagged.add(id.trim());
      for (const app of config.apps ?? []) {
        const rel = path.relative(path.resolve(configDir, app.specDir ?? 'specs'), spec.path).split(path.sep).join('/').replace(/\.md$/, '');
        if (!rel.startsWith('../')) { refs.add(rel); if (app.name) refs.add(`${app.name}:${rel}`); }
      }
    }
    const catalogDir = config.featureState?.catalog ? path.resolve(configDir, config.featureState.catalog) : fallbackCatalog;
    if (!catalogDir) return health;
    const catalog: CatalogHealth = { directory: catalogDir, files: [], revision: '', features: 0, linked: 0, missing: [] };
    health.catalog = catalog;
    if (!fs.existsSync(catalogDir)) throw new Error(`Catalog directory is missing: ${catalogDir}`);
    const files = (await glob('*.{yaml,yml}', { cwd: catalogDir, absolute: true, ignore: config.featureState?.catalogExclude ?? [] })).sort();
    const hash = createHash('sha256');
    const seen = new Set<string>();
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      hash.update(path.basename(file)).update('\0').update(text).update('\0');
      const doc = parse(text) as { version?: unknown; features?: unknown } | unknown[];
      const list = config.featureState?.catalogFormat === 'list' && Array.isArray(doc) ? doc : (doc as { features?: unknown })?.features;
      const catalogVersion = Array.isArray(doc) ? 'list' : String((doc as { version?: unknown })?.version ?? 'unversioned');
      if (!Array.isArray(list) || (config.featureState?.catalogFormat !== 'list' && catalogVersion !== '1')) throw new Error(`Invalid or unsupported catalog: ${path.basename(file)}`);
      catalog.files.push({ path: file, name: path.basename(file), version: catalogVersion, features: list.length });
      for (const row of list as Array<{ id?: unknown; specs?: unknown }>) {
        if (!row || row.id === undefined || !String(row.id).trim() || seen.has(String(row.id))) throw new Error(`Missing or duplicate feature ID in ${path.basename(file)}`);
        const id = String(row.id);
        seen.add(id);
        catalog.features++;
        const linked = Array.isArray(row.specs) ? row.specs.map(String) : typeof row.specs === 'string' ? [row.specs] : [];
        if (tagged.has(id) || linked.some((ref) => refs.has(ref))) catalog.linked++;
        else catalog.missing.push(id);
      }
    }
    catalog.revision = hash.digest('hex').slice(0, 12);
  } catch (error) {
    if (health.catalog) health.catalog.error = (error as Error).message;
    else health.error = (error as Error).message;
  }
  return health;
}
