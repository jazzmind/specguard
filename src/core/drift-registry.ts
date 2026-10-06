/**
 * Drift Registry — load/save/update helpers.
 *
 * The registry lives at `.specguard/drift-registry.json` and tracks, for each
 * spec, the set of "key files" that can affect it. For each key file we store:
 *
 *   - content hash (SHA-256)
 *   - ISO timestamp of last check
 *   - last verdict: 'no-drift' | 'drifted' | 'new-file'
 *
 * A hash change triggers an LLM semantic check; no hash change ⇒ skip.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface DriftFileEntry {
  hash: string;
  lastChecked: string;
  lastVerdict: 'no-drift' | 'drifted' | 'new-file';
}

export interface DriftSpecEntry {
  specKey: string;
  specHash: string;
  files: Record<string, DriftFileEntry>;
}

export type DriftRegistry = Record<string, DriftSpecEntry>;

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

export function registryPath(rootDir: string): string {
  return path.join(rootDir, '.specguard', 'drift-registry.json');
}

/** Repo-relative POSIX key for a file. Keys never contain machine-specific prefixes. */
export function toRegistryKey(rootDir: string, absPath: string): string {
  const rel = path.relative(rootDir, absPath);
  return rel.split(path.sep).join('/');
}

/** Resolve a registry key back to an absolute path under `rootDir`. */
export function fromRegistryKey(rootDir: string, key: string): string {
  return path.isAbsolute(key) ? key : path.resolve(rootDir, ...key.split('/'));
}

function isAbsoluteKey(key: string): boolean {
  return path.isAbsolute(key) || /^[A-Za-z]:[\\/]/.test(key);
}

/**
 * Rewrite absolute keys as relative keys. Returns true when anything changed.
 * Absolute keys that are not under `rootDir` are still made relative (they
 * begin with `../`) so the file is portable.
 */
export function migrateRegistryKeys(rootDir: string, registry: DriftRegistry): boolean {
  let changed = false;
  for (const entry of Object.values(registry)) {
    if (!entry || typeof entry !== 'object' || !entry.files) continue;
    for (const key of Object.keys(entry.files)) {
      if (!isAbsoluteKey(key)) continue;
      const rel = toRegistryKey(rootDir, key);
      if (!(rel in entry.files)) entry.files[rel] = entry.files[key];
      delete entry.files[key];
      changed = true;
    }
  }
  return changed;
}

export function loadRegistry(rootDir: string): DriftRegistry {
  const p = registryPath(rootDir);
  if (!fs.existsSync(p)) return {};
  let registry: DriftRegistry;
  try {
    registry = JSON.parse(fs.readFileSync(p, 'utf-8')) as DriftRegistry;
  } catch {
    return {};
  }
  if (migrateRegistryKeys(rootDir, registry)) saveRegistry(rootDir, registry);
  return registry;
}

export function saveRegistry(rootDir: string, registry: DriftRegistry): void {
  const p = registryPath(rootDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(registry, null, 2));
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function hashFile(absPath: string): string | null {
  try {
    const content = fs.readFileSync(absPath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

export function hashString(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Registry mutation helpers
// ---------------------------------------------------------------------------

export function getOrCreateSpecEntry(registry: DriftRegistry, specKey: string, specHash: string): DriftSpecEntry {
  if (!registry[specKey]) {
    registry[specKey] = { specKey, specHash, files: {} };
  } else {
    registry[specKey].specHash = specHash;
  }
  return registry[specKey];
}

export function updateFileEntry(
  specEntry: DriftSpecEntry,
  key: string,
  hash: string,
  verdict: DriftFileEntry['lastVerdict'],
): void {
  specEntry.files[key] = {
    hash,
    lastChecked: new Date().toISOString(),
    lastVerdict: verdict,
  };
}
