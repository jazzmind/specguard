/**
 * Shared machinery for `spec draft` and `spec consolidate`: find the code,
 * summarise it with the fast model, and turn a capability plan into spec
 * content with structured LLM output. The markdown itself is written by
 * `core/spec-render.ts`.
 *
 * Spec: specs/capabilities/spec-authoring.md
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

import { llmGenerateObject, resolveTargets } from '../core/llm.js';
import { fileExists, readFile } from '../core/reader.js';
import { expandAppGlobs } from '../core/spec-key.js';
import type { CapabilityPlanT } from '../core/spec-map.js';
import type { CapabilityDoc, RenderedRequirement } from '../core/spec-render.js';
import type { SpecGuardConfig } from '../core/types.js';
import { writeFile } from '../core/writer.js';

const MAX_FILE_CHARS = 12_000;
const KEY_FILE_BUDGET = 20_000;
export const SUMMARY_CACHE = '.specguard/cache/summaries.json';

export function rootOf(config: SpecGuardConfig): string {
  return config.rootDir ?? process.cwd();
}

export interface SourceFile {
  rel: string;
  abs: string;
}

const rel = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

/** Source files of every app, repo-relative, without the `tests` group and without `exclude` matches. */
export async function collectSourceFiles(config: SpecGuardConfig): Promise<SourceFile[]> {
  const root = rootOf(config);
  const out = new Map<string, SourceFile>();
  for (const app of config.apps) {
    const patterns: string[] = [];
    for (const [name, group] of Object.entries(app.sources)) {
      if (name === 'tests') continue;
      if (Array.isArray(group)) patterns.push(...group);
    }
    const files = await expandAppGlobs(config, app, patterns, () => undefined);
    const excluded = new Set(app.exclude?.length ? await expandAppGlobs(config, app, app.exclude, () => undefined) : []);
    for (const abs of files) if (!excluded.has(abs)) out.set(abs, { rel: rel(root, abs), abs });
  }
  return [...out.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Test files named by any app's `tests` group or `extraTestSources`. */
export async function collectTestFiles(config: SpecGuardConfig): Promise<string[]> {
  const root = rootOf(config);
  const out = new Set<string>();
  for (const app of config.apps) {
    const patterns = [...(app.sources.tests ?? []), ...(app.extraTestSources ?? [])];
    for (const abs of await expandAppGlobs(config, app, patterns, () => undefined)) out.add(rel(root, abs));
  }
  return [...out].sort();
}

async function readCapped(abs: string, cap = MAX_FILE_CHARS): Promise<string> {
  const text = await readFile(abs);
  return text.length > cap ? `${text.slice(0, cap)}\n... (truncated)` : text;
}

const hashOf = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

const SummarySchema = z.object({
  summary: z.string().describe('One or two sentences, at most 240 characters: what user-visible or business functionality this file provides.'),
});

/** Bump when SUMMARY_SYSTEM changes, so cached summaries are rewritten. */
const SUMMARY_PROMPT_VERSION = 's1';

const SUMMARY_SYSTEM =
  'You summarise one source file for a system-design review. Say what functionality it provides to users or other parts of the system, ' +
  'not how it is implemented. Do not invent behaviour that is not in the file.';

/**
 * One-line summaries per file from the fast model, cached by content hash so
 * unchanged files cost nothing on the next run.
 */
export async function summarizeFiles(
  config: SpecGuardConfig,
  files: SourceFile[],
  opts: { concurrency?: number; onLog?: (line: string) => void } = {},
): Promise<Record<string, string>> {
  const root = rootOf(config);
  const cacheFile = path.join(root, SUMMARY_CACHE);
  let cache: Record<string, { hash: string; summary: string }> = {};
  if (await fileExists(cacheFile)) {
    try {
      cache = JSON.parse(await readFile(cacheFile)) as typeof cache;
    } catch {
      cache = {};
    }
  }
  const out: Record<string, string> = {};
  const queue = [...files];
  let fresh = 0;
  // A summary is only reusable for the same file content, prompt and model: a better model or prompt must not be served stale text.
  const stamp = `${SUMMARY_PROMPT_VERSION}|${resolveTargets({ provider: config.llm.provider, model: config.llm.model, apiKeyEnv: config.llm.apiKeyEnv, pipeline: 'summarize' })[0]?.model ?? config.llm.model}`;
  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const text = await readCapped(file.abs);
      const hash = hashOf(`${stamp}\n${text}`);
      const hit = cache[file.rel];
      if (hit?.hash === hash) {
        out[file.rel] = hit.summary;
        continue;
      }
      const res = await llmGenerateObject({
        provider: config.llm.provider,
        model: config.llm.model,
        apiKeyEnv: config.llm.apiKeyEnv,
        pipeline: 'summarize',
        system: SUMMARY_SYSTEM,
        prompt: `File: ${file.rel}\n\n--- SOURCE START ---\n${text}\n--- SOURCE END ---`,
        schema: SummarySchema,
      });
      cache[file.rel] = { hash, summary: res.summary };
      out[file.rel] = res.summary;
      fresh += 1;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, files.length || 1) }, worker));
  } finally {
    // Paid-for summaries are kept even when a later call fails, so the retry only pays for what is missing.
    if (fresh > 0) {
      await writeFile(cacheFile, JSON.stringify(cache, null, 2) + '\n');
      opts.onLog?.(`[info] summarised ${fresh} file(s), ${files.length - fresh} from cache`);
    }
  }
  return out;
}

/**
 * Files to show the model in full: interface-like files first (routes, handlers,
 * index/entry files), then the smallest, until the character budget is spent.
 */
export function pickKeyFiles(files: SourceFile[], sizes: Record<string, number>, budget = KEY_FILE_BUDGET): SourceFile[] {
  const interfaceLike = (f: SourceFile): number => (/(^|\/)(route|page|api|handler|controller|cli|index|server)[./]|\/api\//i.test(f.rel) ? 0 : 1);
  const ordered = [...files].sort((a, b) => interfaceLike(a) - interfaceLike(b) || (sizes[a.rel] ?? 0) - (sizes[b.rel] ?? 0));
  const picked: SourceFile[] = [];
  let used = 0;
  for (const f of ordered) {
    const size = Math.min(sizes[f.rel] ?? 0, MAX_FILE_CHARS);
    if (used + size > budget && picked.length > 0) continue;
    picked.push(f);
    used += size;
  }
  return picked;
}

const Scenario = z.object({ name: z.string(), steps: z.array(z.string()).min(1), expected: z.array(z.string()).min(1) });

export const SynthSchema = z.object({
  problemAndValue: z.string().describe('1-3 short paragraphs: why this capability exists, who is hurt without it, the value it creates.'),
  users: z.array(z.string()).describe('3-6 short user journeys, each one sentence.'),
  requirements: z
    .array(
      z.object({
        id: z.string().optional().describe('A short kebab-case id of 2 to 5 words naming the behaviour, such as "acknowledgement-is-recorded-once".'),
        text: z.string().describe('A testable, functional requirement about behaviour a user or system can rely on.'),
        replaces: z.array(z.string()).optional().describe('Consolidate only: ids like "<specKey>#<claimId>" of the old claims this requirement absorbs.'),
      }),
    )
    .min(1),
  scenarios: z.array(Scenario).min(1).describe('4-8 user-level flows.'),
  security: z.string().describe('Data touched, trust boundaries, abuse cases. Empty if truly none.'),
  interfaces: z.string().describe('Routes, APIs, commands, events and files the capability exposes.'),
  outOfScope: z.string().describe('Explicit non-goals.'),
});
export type Synth = z.infer<typeof SynthSchema>;

const SYNTH_SYSTEM =
  'You write ONE functional capability spec for a software system, in terms of user and business value. ' +
  'Requirements describe behaviour a user or integrating system can observe, not files, functions or data shapes: do not state counts of constants, internal object fields or component names unless they are part of a published interface. ' +
  'Merge fine-grained details into functional statements, but keep important edge cases and rules (limits, status codes, who may do what). One sentence or two per requirement, not a paragraph. ' +
  'Only describe behaviour that is supported by the material you are given. Do not invent features. ' +
  'Aim for 10-20 requirements and 4-8 scenarios.';

export interface SynthesizeInput {
  plan: CapabilityPlanT;
  ownedFiles: SourceFile[];
  summaries: Record<string, string>;
  testFiles: string[];
  /** Consolidate: the v1 spec bodies this capability absorbs, with claim anchors. */
  v1Material?: string;
  systemTitle: string;
}

export async function synthesizeCapability(config: SpecGuardConfig, input: SynthesizeInput): Promise<Synth> {
  const sizes: Record<string, number> = {};
  for (const f of input.ownedFiles) sizes[f.rel] = (await readFile(f.abs)).length;
  const key = pickKeyFiles(input.ownedFiles, sizes);
  const keyBlocks: string[] = [];
  for (const f of key) keyBlocks.push(`### ${f.rel}\n${await readCapped(f.abs)}`);

  const prompt = [
    `System: ${input.systemTitle}`,
    `Capability: ${input.plan.title} (${input.plan.id})`,
    `Value: ${input.plan.value}`,
    input.plan.rationale ? `Why it is a capability: ${input.plan.rationale}` : '',
    '',
    `Files it owns (${input.ownedFiles.length}):`,
    ...input.ownedFiles.map((f) => `- ${f.rel} — ${input.summaries[f.rel] ?? ''}`),
    '',
    input.testFiles.length > 0 ? `Tests that cover it:\n${input.testFiles.map((t) => `- ${t}`).join('\n')}\n` : '',
    input.v1Material
      ? `Existing fine-grained specs to consolidate. Cover their requirements functionally and list the old claim ids each requirement absorbs in "replaces" ("<specKey>#<claimId>"; unanchored bullets are "<specKey>#c<N>" counting from 1):\n${input.v1Material}\n`
      : '',
    key.length > 0 ? `Key source files:\n${keyBlocks.join('\n\n')}` : '',
  ]
    .filter((s) => s !== '')
    .join('\n');

  return llmGenerateObject({
    provider: config.llm.provider,
    model: config.llm.model,
    apiKeyEnv: config.llm.apiKeyEnv,
    pipeline: 'spec-draft',
    system: SYNTH_SYSTEM,
    prompt,
    schema: SynthSchema,
  });
}

/** Assemble the final capability document from a plan and the synthesised content. */
export function toCapabilityDoc(
  plan: { id: string; title: string; value: string; sources: string[]; tests: string[]; docs: string[] },
  synth: Synth,
  requirements: RenderedRequirement[],
  extra: { kind: 'capability' | 'component'; parent: string; history: string[]; status?: string },
): CapabilityDoc {
  return {
    id: plan.id,
    kind: extra.kind,
    title: plan.title,
    parent: extra.parent,
    value: plan.value,
    status: extra.status ?? 'active',
    sources: plan.sources,
    tests: plan.tests,
    docs: plan.docs,
    history: extra.history,
    problemAndValue: synth.problemAndValue,
    users: synth.users,
    requirements,
    scenarios: synth.scenarios,
    security: synth.security,
    interfaces: synth.interfaces,
    outOfScope: synth.outOfScope,
  };
}
