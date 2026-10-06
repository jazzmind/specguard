/**
 * Built-in result sources for feature-state.
 *
 * - `caseDirSource`: JSON files holding normalized `FeatureCase` rows.
 * - `reporterSource`: test-runner reporter output (Vitest, Playwright, JUnit, ...)
 *   read through `src/core/test-results.ts`.
 *
 * Spec: specs/plugins/plugins.md
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expandGlobsSync } from './glob.js';
import { parseResults, type ResultFormat } from '../core/test-results.js';
import type { FeatureCase, ResultSource } from './types.js';

export function readCaseFiles(dir: string): FeatureCase[] {
  if (!existsSync(dir)) return [];
  const rows: FeatureCase[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as FeatureCase[] | { cases?: FeatureCase[] };
      rows.push(...(Array.isArray(parsed) ? parsed : parsed.cases ?? []));
    } catch {
      /* a bad results file is not a pass */
    }
  }
  return rows;
}

/** Directories (relative to the root) of normalized case JSON. */
export function caseDirSource(id: string, dirs: string[]): ResultSource {
  return {
    id,
    load: ({ rootDir }) => dirs.flatMap((dir) => readCaseFiles(path.resolve(rootDir, dir))),
  };
}

export interface ReporterEntry {
  /** File or glob, relative to the root. */
  path: string;
  /** Result kind used by the feature gate. Default: e2e for Playwright, unit otherwise. */
  kind?: string;
  format?: ResultFormat | 'auto';
}

const STATUS = { pass: 'passed', fail: 'failed', skip: 'skipped' } as const;

export function reporterSource(entries: ReporterEntry[]): ResultSource {
  return {
    id: 'reporters',
    load({ rootDir }) {
      const rows: FeatureCase[] = [];
      for (const entry of entries) {
        for (const file of expandGlobsSync(entry.path, rootDir)) {
          try {
            const parsed = parseResults(readFileSync(file, 'utf8'), entry.format ?? 'auto');
            const isE2e = /playwright/i.test(entry.format ?? '') || /e2e/i.test(entry.path);
            for (const t of parsed) {
              rows.push({
                kind: entry.kind ?? (isE2e ? 'e2e' : 'unit'),
                status: STATUS[t.status],
                name: t.fullTitle || t.title,
                file: t.file,
                tags: t.tags,
                externalIds: t.externalIds,
                externalId: t.externalIds[0],
              });
            }
          } catch {
            /* an unreadable reporter file is not a pass */
          }
        }
      }
      return rows;
    },
  };
}
