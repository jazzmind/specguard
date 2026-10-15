/**
 * A cache for slow, content-addressed results (generated documents). One entry per slot; the caller
 * decides whether an entry is still good by comparing its `hash`.
 *
 * Spec: specs/capabilities/documentation-api.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { writeFile } from '../writer.js';

export interface CacheEntry {
  /** Fingerprint of everything the value was made from; the entry is stale when this no longer matches. */
  hash: string;
  value: string;
}

export interface ContentCache {
  get(namespace: string, slot: string): Promise<CacheEntry | undefined>;
  put(namespace: string, slot: string, entry: CacheEntry): Promise<void>;
}

const safe = (part: string): string => part.replace(/[^a-z0-9-]/gi, '_');

/** Entries as `<root>/.specguard/cache/<namespace>/<slot>.json`. */
export function fileContentCache(rootDir: string): ContentCache {
  const file = (namespace: string, slot: string): string => path.join(rootDir, '.specguard', 'cache', ...namespace.split('/').map(safe), `${safe(slot)}.json`);
  return {
    get: async (namespace, slot) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(file(namespace, slot), 'utf8')) as Partial<CacheEntry>;
        return typeof parsed.hash === 'string' && typeof parsed.value === 'string' ? { hash: parsed.hash, value: parsed.value } : undefined;
      } catch {
        return undefined;
      }
    },
    put: async (namespace, slot, entry) => {
      await writeFile(file(namespace, slot), `${JSON.stringify(entry)}\n`);
    },
  };
}
