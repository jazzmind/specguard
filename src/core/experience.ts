/** Business organization is a view over stable spec/catalog refs, never a file move. Spec: workspaces, spec-authoring. */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { loadWorkspaceWithConfigs } from './workspace.js';
import { loadCanonicalSpecs } from './spec-key.js';
import { parseCatalogYaml } from '../plugins/feature-catalog/catalog.js';
import type { SpecGuardConfig } from './types.js';

const id = z.string().min(1).max(160);
const group = z.object({ id, title: z.string().min(1), order: z.number().int() });
const step = z.object({ id, title: z.string().min(1), summary: z.string(), order: z.number().int(), refs: z.array(z.string().min(1)) });
const journey = z.object({ id, title: z.string().min(1), summary: z.string(), group: z.string(), order: z.number().int(), status: z.enum(['draft', 'reviewed']), steps: z.array(step) });
const placement = z.object({ ref: z.string().min(1), group: z.string(), order: z.number().int() });
export const experienceSchema = z.object({ version: z.literal(1), title: z.string(), overview: z.string(), groups: z.array(group), journeys: z.array(journey), placements: z.array(placement) });
export type Experience = z.infer<typeof experienceSchema>;
export interface ExperienceEntry { ref: string; app: string; title: string; summary: string; kind: 'spec' | 'feature'; file: string; claims: string[]; specs?: string[]; }
export const experienceFile = (root: string): string => path.join(root, '.specguard/experience.json');
export const revisionOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const emptyExperience = (title: string): Experience => ({ version: 1, title, overview: '', groups: [], journeys: [], placements: [] });

export function validateExperience(value: unknown): Experience {
  const doc = experienceSchema.parse(value);
  const unique = (values: string[], label: string): void => { if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`); };
  unique(doc.groups.map(g => g.id), 'group id'); unique(doc.journeys.map(j => j.id), 'journey id'); unique(doc.placements.map(p => p.ref), 'placement');
  const groups = new Set(doc.groups.map(g => g.id));
  for (const node of [...doc.journeys, ...doc.placements]) if (node.group && !groups.has(node.group)) throw new Error(`Unknown group: ${node.group}`);
  for (const j of doc.journeys) unique(j.steps.map(s => s.id), `step id in ${j.id}`);
  return doc;
}

export function readExperience(root: string, title = path.basename(root)): Experience {
  const file = experienceFile(root);
  return existsSync(file) ? validateExperience(JSON.parse(readFileSync(file, 'utf8'))) : emptyExperience(title);
}
export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, file);
}
export function saveExperience(root: string, value: unknown, expected: string): Experience {
  const currentRevision = existsSync(experienceFile(root)) ? revisionOf(readExperience(root)) : revisionOf(null);
  if (currentRevision !== expected) throw new Error('Organization changed since you opened it. Reload before saving.');
  const next = validateExperience(value);
  writeJson(experienceFile(root), next);
  return next;
}

/** Additive refresh: retain human descriptions, order, groups and existing references. */
export function mergeExperience(current: Experience, generated: Experience): Experience {
  const next = structuredClone(current);
  if (!next.overview) next.overview = generated.overview;
  const groups = new Set(next.groups.map(g => g.id));
  for (const g of generated.groups) if (!groups.has(g.id)) { next.groups.push({ ...g, order: next.groups.length }); groups.add(g.id); }
  for (const candidate of generated.journeys) {
    const prior = next.journeys.find(j => j.id === candidate.id);
    if (!prior) next.journeys.push({ ...candidate, status: 'draft', order: next.journeys.length });
    else for (const s of candidate.steps) if (!prior.steps.some(p => p.id === s.id)) { prior.steps.push({ ...s, order: prior.steps.length }); prior.status = 'draft'; }
  }
  for (const p of generated.placements) if (!next.placements.some(x => x.ref === p.ref)) next.placements.push(p);
  return validateExperience(next);
}

export async function experienceContext(cwd: string, workspace?: string, inheritWorkspace?: string) {
  const catalog: ExperienceEntry[] = [];
  const warnings: string[] = [];
  const configs: SpecGuardConfig[] = [];
  const collect = (config: SpecGuardConfig, repoKey?: string): void => {
    configs.push(config);
    for (const app of config.apps) {
      const key = repoKey ?? app.name;
      for (const spec of loadCanonicalSpecs(config, path.resolve(config.rootDir!, app.specDir))) {
        catalog.push({ ref: `${key}:${spec.specKey}`, app: key, title: spec.title || spec.specKey,
          summary: (spec.overview || spec.sections['Problem & Value'] || spec.sections.Problem || '').slice(0, 1800), kind: 'spec', file: spec.filePath,
          claims: spec.claims.filter(c => c.id).map(c => `${key}:${spec.specKey}#${c.id}`) });
      }
      const dir = path.resolve(config.rootDir!, config.featureState?.catalog ?? 'catalog');
      if (existsSync(dir)) for (const file of readdirSync(dir).filter(f => /\.ya?ml$/.test(f))) {
        try {
          for (const feature of parseCatalogYaml(readFileSync(path.join(dir, file), 'utf8'), file)) {
            catalog.push({ ref: `${key}:feature/${feature.id}`, app: key, title: feature.title, summary: feature.summary, kind: 'feature', file: path.join(dir, file), claims: [], specs: feature.specs.map(ref => repoKey && ref.startsWith(app.name + ':') ? `${repoKey}:${ref.slice(ref.indexOf(':') + 1)}` : ref) });
          }
        } catch (err) { warnings.push(`Catalog ${file}: ${(err as Error).message}`); }
      }
    }
  };
  let root: string;
  let title: string;
  if (workspace) {
    const loaded = await loadWorkspaceWithConfigs(cwd, workspace);
    root = loaded.manifest.rootDir; title = loaded.manifest.name;
    for (const repo of loaded.repos) if (repo.specGuardConfig) collect(repo.specGuardConfig, repo.key);
  } else {
    const config = await loadConfig(cwd); root = config.rootDir!; title = path.basename(root); collect(config);
  }
  const stored = readExperience(root, title);
  const document = structuredClone(stored);
  if (!workspace) {
    // An application's own choices win; otherwise follow the nearest workspace's journey order.
    try {
      const parent = await loadWorkspaceWithConfigs(root, inheritWorkspace);
      const repo = parent.repos.find(r => r.specGuardConfig?.rootDir === root);
      if (repo && parent.manifest.rootDir !== root && existsSync(experienceFile(parent.manifest.rootDir))) {
        const shared = readExperience(parent.manifest.rootDir);
        for (const journey of [...shared.journeys].sort((a, b) => a.order - b.order)) {
          for (const step of [...journey.steps].sort((a, b) => a.order - b.order)) {
            const groupId = `workspace:${journey.id}:${step.id}`;
            for (const ref of step.refs) {
              const entries = catalog.filter(e => [e.ref, ...(e.specs ?? [])].some(link => `${repo.key}:${link.slice(link.indexOf(':') + 1)}` === ref.split('#')[0]));
              for (const entry of entries) {
                if (document.placements.some(p => p.ref === entry.ref)) continue;
                if (!document.groups.some(g => g.id === groupId)) document.groups.push({ id: groupId, title: `${journey.title} · ${step.title}`, order: document.groups.length });
                document.placements.push({ ref: entry.ref, group: groupId, order: document.placements.length });
              }
            }
          }
        }
      }
    } catch (err) { if (inheritWorkspace) warnings.push(`Workspace organization unavailable: ${(err as Error).message}`); }
  }
  const known = new Set(catalog.flatMap(e => [e.ref, ...e.claims]));
  const refs = [...document.placements.map(p => p.ref), ...document.journeys.flatMap(j => j.steps.flatMap(s => s.refs))];
  for (const ref of new Set(refs)) if (!known.has(ref)) warnings.push(`Missing reference: ${ref}`);
  const duplicates = catalog.filter((e, i) => catalog.findIndex(x => x.ref === e.ref) !== i);
  if (duplicates.length) throw new Error(`Ambiguous application references: ${duplicates.map(e => e.ref).join(', ')}`);
  return { root, title, document, revision: existsSync(experienceFile(root)) ? revisionOf(stored) : revisionOf(null), catalog, warnings, configs };
}
