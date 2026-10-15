/**
 * The capability map: the reviewable proposal that sits between clustering and
 * writing specs. `spec draft` and `spec consolidate` write it to
 * `.specguard/spec-map.json` (editable) and `.specguard/spec-map.md` (for
 * reading), and continue from the JSON with `--from-map`.
 *
 * It is deliberately outside `.specguard/plans/`, which dashboards list.
 *
 * Spec: specs/capabilities/spec-authoring.md
 */
import path from 'node:path';
import { z } from 'zod';

import { fileExists, readFile, expandGlobs } from './reader.js';
import { writeFile } from './writer.js';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ComponentPlan = z.object({
  id: z.string().regex(ID),
  title: z.string(),
  value: z.string(),
  sources: z.array(z.string()).default([]),
});

export const CapabilityPlan = z.object({
  id: z.string().regex(ID),
  title: z.string(),
  value: z.string(),
  rationale: z.string().default(''),
  /** Repo-relative globs of the code the capability owns. */
  sources: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]),
  docs: z.array(z.string()).default([]),
  /** Consolidate only: canonical keys of the v1 specs this capability absorbs. */
  specs: z.array(z.string()).default([]),
  components: z.array(ComponentPlan).default([]),
});

export const SpecMapSchema = z.object({
  system: z.object({
    title: z.string(),
    problem: z.string(),
    users: z.array(z.string()).default([]),
    value: z.string(),
    nonGoals: z.array(z.string()).default([]),
  }),
  capabilities: z.array(CapabilityPlan).min(1),
});

/**
 * What the model is asked to produce: the same shape with every list required.
 * (Defaults would make the schema's input and output types differ.) The result
 * is passed through `SpecMapSchema.parse` to apply defaults.
 */
export const ClusterOutputSchema = z.object({
  system: z.object({
    title: z.string(),
    problem: z.string().describe('Why this system exists; who is hurt without it. 1-2 short paragraphs.'),
    users: z.array(z.string()),
    value: z.string().describe('One or two sentences: the value the system creates.'),
    nonGoals: z.array(z.string()),
  }),
  capabilities: z
    .array(
      z.object({
        id: z.string().describe('kebab-case id, unique, not "system"'),
        title: z.string(),
        value: z.string().describe('One sentence: the user or business value this capability delivers.'),
        rationale: z.string().describe('Why these files and specs belong together.'),
        sources: z.array(z.string()).describe('Repo-relative globs of code this capability owns. Prefer directory globs. Must match existing files.'),
        tests: z.array(z.string()),
        docs: z.array(z.string()),
        specs: z.array(z.string()).describe('Consolidate only: keys of existing specs this capability absorbs. Otherwise empty.'),
        components: z.array(z.object({ id: z.string(), title: z.string(), value: z.string(), sources: z.array(z.string()) })),
      }),
    )
    .min(1),
});

export type SpecMap = z.infer<typeof SpecMapSchema>;
export type CapabilityPlanT = z.infer<typeof CapabilityPlan>;

export const SPEC_MAP_JSON = '.specguard/spec-map.json';
export const SPEC_MAP_MD = '.specguard/spec-map.md';

export interface MapCheck {
  map: SpecMap;
  warnings: string[];
  /** Root-relative source files that no capability owns. */
  unowned: string[];
  /** v1 spec keys no capability absorbs (consolidate). */
  unassignedSpecs: string[];
  /** v1 spec keys more than one capability claims (consolidate). */
  doubleAssignedSpecs: string[];
}

/**
 * Check a proposed map against the files that exist. A glob that matches
 * nothing is dropped with a warning; duplicate ids are an error.
 */
export async function checkSpecMap(
  map: SpecMap,
  opts: { root: string; sourceFiles: string[]; target?: [number, number]; v1Specs?: string[] },
): Promise<MapCheck> {
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const cap of map.capabilities) {
    if (seen.has(cap.id)) throw new Error(`capability id "${cap.id}" appears twice in the map`);
    seen.add(cap.id);
    for (const comp of cap.components) {
      if (seen.has(comp.id)) throw new Error(`component id "${comp.id}" collides with another id in the map`);
      seen.add(comp.id);
    }
  }
  if (seen.has('system')) throw new Error('"system" is reserved for the master spec');

  const owned = new Set<string>();
  const cleaned: SpecMap = { ...map, capabilities: [] };
  for (const cap of map.capabilities) {
    const keep = async (globs: string[], label: string): Promise<string[]> => {
      const out: string[] = [];
      for (const glob of globs) {
        const hits = await expandGlobs([glob], opts.root);
        if (hits.length === 0) {
          warnings.push(`${cap.id}: ${label} glob "${glob}" matches no files; dropped`);
          continue;
        }
        out.push(glob);
        if (label === 'sources') for (const h of hits) owned.add(path.relative(opts.root, h).split(path.sep).join('/'));
      }
      return out;
    };
    cleaned.capabilities.push({
      ...cap,
      sources: await keep(cap.sources, 'sources'),
      tests: await keep(cap.tests, 'tests'),
      docs: await keep(cap.docs, 'docs'),
      components: await Promise.all(
        cap.components.map(async (c) => ({ ...c, sources: await keep(c.sources, 'sources') })),
      ),
    });
  }

  if (opts.target) {
    const [min, max] = opts.target;
    const n = cleaned.capabilities.length;
    if (n < min || n > max) warnings.push(`${n} capabilities is outside the target of ${min}-${max}`);
  }

  const unowned = opts.sourceFiles.filter((f) => !owned.has(f));

  const claimed = new Map<string, number>();
  for (const cap of cleaned.capabilities) for (const key of cap.specs) claimed.set(key, (claimed.get(key) ?? 0) + 1);
  const unassignedSpecs = (opts.v1Specs ?? []).filter((k) => !claimed.has(k));
  const doubleAssignedSpecs = [...claimed].filter(([, n]) => n > 1).map(([k]) => k);

  return { map: cleaned, warnings, unowned, unassignedSpecs, doubleAssignedSpecs };
}

export function renderSpecMapMarkdown(check: MapCheck): string {
  const { map } = check;
  const lines: string[] = [
    '# Proposed capability map',
    '',
    'Edit `.specguard/spec-map.json`, then run the same command with `--from-map` to write the specs.',
    '',
    `## System: ${map.system.title}`,
    '',
    map.system.problem,
    '',
    '## Capabilities',
    '',
    '| Id | Title | Value | Source globs | v1 specs absorbed |',
    '|---|---|---|---|---|',
    ...map.capabilities.map(
      (c) => `| ${c.id} | ${c.title} | ${c.value.replace(/\|/g, '\\|')} | ${c.sources.length} | ${c.specs.length} |`,
    ),
  ];
  for (const cap of map.capabilities) {
    lines.push('', `### ${cap.id}`, '', cap.rationale || '_No rationale given._', '');
    for (const g of cap.sources) lines.push(`- source: \`${g}\``);
    for (const c of cap.components) lines.push(`- component \`${c.id}\`: ${c.sources.map((s) => `\`${s}\``).join(', ')}`);
  }
  if (check.unowned.length > 0) {
    lines.push('', `## Unowned source files (${check.unowned.length})`, '', ...check.unowned.slice(0, 80).map((f) => `- ${f}`));
    if (check.unowned.length > 80) lines.push(`- … and ${check.unowned.length - 80} more`);
  }
  if (check.unassignedSpecs.length > 0) lines.push('', '## v1 specs not assigned to any capability', '', ...check.unassignedSpecs.map((k) => `- ${k}`));
  if (check.doubleAssignedSpecs.length > 0) lines.push('', '## v1 specs assigned to more than one capability', '', ...check.doubleAssignedSpecs.map((k) => `- ${k}`));
  if (check.warnings.length > 0) lines.push('', '## Warnings', '', ...check.warnings.map((w) => `- ${w}`));
  return lines.join('\n') + '\n';
}

export async function writeSpecMap(root: string, check: MapCheck): Promise<void> {
  await writeFile(path.join(root, SPEC_MAP_JSON), JSON.stringify(check.map, null, 2) + '\n');
  await writeFile(path.join(root, SPEC_MAP_MD), renderSpecMapMarkdown(check));
}

export async function readSpecMap(root: string): Promise<SpecMap | null> {
  const file = path.join(root, SPEC_MAP_JSON);
  if (!(await fileExists(file))) return null;
  return SpecMapSchema.parse(JSON.parse(await readFile(file)));
}
