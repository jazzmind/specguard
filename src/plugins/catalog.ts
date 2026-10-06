/**
 * Feature catalog: versioned Zod schema, a real YAML parser, and the generic
 * directory provider.
 *
 * File shape (version 1):
 *
 *   version: 1
 *   features:
 *     - id: orders.create
 *       title: Create an order
 *       requires: [ui, api]
 *       specs: ["web:orders/create"]
 *       tests: { unit: [orders.test.ts], regression: [QA-T12] }
 *       externalIds: [QA-T12]
 *
 * Spec: specs/plugins/plugins.md
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import {
  CHANNELS,
  type CatalogContext,
  type CatalogFeatureInput,
  type CatalogProvider,
  type ChannelName,
} from './types.js';

export const CATALOG_VERSION = 1;

const stringList = z.preprocess(
  (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value.map(String) : [String(value)]),
  z.array(z.string()),
);

const TestsSchema = z
  .object({
    unit: stringList.default([]),
    regression: stringList.default([]),
    integration: stringList.default([]),
    proof: stringList.default([]),
  })
  .passthrough();

export const CatalogFeatureSchema = z
  .object({
    id: z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().min(1)),
    title: z.string().default(''),
    area: z.string().default(''),
    summary: z.string().default(''),
    requires: stringList.default([]).transform((list) => list.filter((c): c is ChannelName => (CHANNELS as readonly string[]).includes(c))),
    specs: stringList.default([]),
    tests: TestsSchema.default({}),
    externalIds: stringList.default([]),
    tags: stringList.default([]),
    status: z.string().default('planned'),
  })
  .passthrough();

/** The versioned catalog file schema. */
export const CatalogSchemaV1 = z.object({
  version: z.literal(CATALOG_VERSION),
  features: z.array(CatalogFeatureSchema),
});

export type CatalogFile = z.infer<typeof CatalogSchemaV1>;

export class CatalogError extends SpecGuardError {
  constructor(message: string) {
    super(`Invalid catalog: ${message}`, ExitCode.ValidationFailed);
    this.name = 'CatalogError';
  }
}

function toInput(feature: z.infer<typeof CatalogFeatureSchema>): CatalogFeatureInput {
  const { id, title, area, summary, requires, specs, tests, externalIds, tags, status } = feature;
  return {
    id,
    title,
    area,
    summary,
    requires,
    specs,
    tests: { unit: tests.unit, regression: tests.regression, integration: tests.integration, proof: tests.proof },
    externalIds,
    tags,
    status,
  };
}

function zodMessage(error: z.ZodError): string {
  return error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
}

/** Parse one catalog file. Throws `CatalogError` naming the problem; never returns a partial catalog. */
export function parseCatalogYaml(text: string, label = 'catalog'): CatalogFeatureInput[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new CatalogError(`${label}: ${(err as Error).message}`);
  }
  const parsed = CatalogSchemaV1.safeParse(doc);
  if (!parsed.success) throw new CatalogError(`${label}: ${zodMessage(parsed.error)}`);
  return parsed.data.features.map(toInput);
}

/** Parse a bare list of features with the same field rules. Used by plugins that read unversioned files. */
export function parseFeatureList(text: string, label = 'catalog'): CatalogFeatureInput[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new CatalogError(`${label}: ${(err as Error).message}`);
  }
  const list = Array.isArray(doc) ? doc : doc && typeof doc === 'object' && Array.isArray((doc as { features?: unknown }).features) ? (doc as { features: unknown[] }).features : null;
  if (!list) throw new CatalogError(`${label}: expected a list of features`);
  const out: CatalogFeatureInput[] = [];
  list.forEach((item, index) => {
    const parsed = CatalogFeatureSchema.safeParse(item);
    if (!parsed.success) throw new CatalogError(`${label}[${index}]: ${zodMessage(parsed.error)}`);
    out.push(toInput(parsed.data));
  });
  return out;
}

/** Read every `*.yaml` / `*.yml` in a directory with `parse`. Missing directory means an empty catalog. */
export function loadCatalogDir(
  dir: string,
  parse: (text: string, label: string) => CatalogFeatureInput[] = parseCatalogYaml,
): CatalogFeatureInput[] {
  if (!existsSync(dir)) return [];
  const features: CatalogFeatureInput[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n)).sort()) {
    for (const feature of parse(readFileSync(path.join(dir, name), 'utf8'), name)) {
      if (seen.has(feature.id)) throw new CatalogError(`${name}: duplicate feature id '${feature.id}'`);
      seen.add(feature.id);
      features.push(feature);
    }
  }
  return features;
}

/** The generic provider: versioned YAML in a directory named by config. No directory means no catalog. */
export const yamlCatalogProvider: CatalogProvider = {
  id: 'yaml',
  async load(ctx: CatalogContext): Promise<CatalogFeatureInput[]> {
    if (!ctx.dir) return [];
    return loadCatalogDir(path.resolve(ctx.rootDir, ctx.dir));
  },
};
