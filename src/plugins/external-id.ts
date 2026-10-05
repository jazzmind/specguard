/**
 * External-id adapters. A normalized test case carries `externalIds` and `tags`;
 * adapters decide how an external system's ids are read from raw rows, tags, and
 * titles. The generic adapter reads `@ext:` / `@id:` tags. Zephyr and Jira are
 * adapters, not core concepts.
 *
 * Spec: specs/plugins/plugins.md
 */
import type { ExternalIdAdapter, FeatureCase } from './types.js';

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** `@ext:ID`, `@id:ID`, `@externalId:ID` tags and the `externalId` field. */
export const genericExternalIdAdapter: ExternalIdAdapter = {
  id: 'generic',
  extract({ tags = [], text = '', row }) {
    const ids: string[] = [];
    for (const source of [text, ...tags]) {
      for (const match of source.matchAll(/@(?:ext|id|externalId):([A-Za-z0-9_.:/-]+)/g)) ids.push(match[1]);
    }
    if (row) {
      if (typeof row.externalId === 'string') ids.push(row.externalId);
      if (Array.isArray(row.externalIds)) ids.push(...row.externalIds.map(String));
    }
    return unique(ids);
  },
};

/** Zephyr test-case keys such as `PROJ-T123`, in the `zephyr` field, tags, or the title. */
export const zephyrAdapter: ExternalIdAdapter = {
  id: 'zephyr',
  extract({ tags = [], text = '', row }) {
    const ids: string[] = [];
    if (row && typeof row.zephyr === 'string') ids.push(row.zephyr);
    for (const source of [text, ...tags]) {
      for (const match of source.matchAll(/\b[A-Z][A-Z0-9]*-T\d+\b/g)) ids.push(match[0]);
    }
    return unique(ids);
  },
};

/** Jira issue keys such as `PROJ-123`, in the `jira` field, tags, or the title. */
export const jiraAdapter: ExternalIdAdapter = {
  id: 'jira',
  extract({ tags = [], text = '', row }) {
    const ids: string[] = [];
    if (row && typeof row.jira === 'string') ids.push(row.jira);
    for (const source of [text, ...tags]) {
      for (const match of source.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)) {
        if (!/-T\d+$/.test(match[0])) ids.push(match[0]);
      }
    }
    return unique(ids);
  },
};

export const BUILTIN_EXTERNAL_ID_ADAPTERS: Record<string, ExternalIdAdapter> = {
  generic: genericExternalIdAdapter,
  zephyr: zephyrAdapter,
  jira: jiraAdapter,
};

/** Fill `externalId` / `externalIds` on each case using every adapter. The input is not mutated. */
export function normalizeCases(cases: FeatureCase[], adapters: ExternalIdAdapter[]): FeatureCase[] {
  const all = [genericExternalIdAdapter, ...adapters.filter((a) => a.id !== 'generic')];
  return cases.map((row) => {
    const ids = unique([
      ...all.flatMap((adapter) =>
        adapter.extract({
          tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
          text: `${row.name ?? ''}`,
          row: row as Record<string, unknown>,
        }),
      ),
    ]);
    if (ids.length === 0) return row;
    return { ...row, externalId: row.externalId ?? ids[0], externalIds: ids };
  });
}
