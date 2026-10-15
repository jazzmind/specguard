/**
 * `specguard spec draft`: write functional specs for an existing codebase.
 *
 * Inventory (no LLM) -> summarise each file (fast model, cached) -> cluster
 * into ~8-15 capabilities (frontier model) -> a reviewable capability map ->
 * synthesise one spec per capability. The run stops after the map unless
 * `--yes` is given; `--from-map` continues from the (edited) map.
 *
 * Spec: specs/capabilities/spec-authoring.md
 */
import path from 'node:path';

import { ExitCode } from '../core/exit-codes.js';
import { llmGenerateObject } from '../core/llm.js';
import { mergeClaims } from '../core/claim-migration.js';
import { expandGlobs, fileExists, readFile } from '../core/reader.js';
import { specsRootDir } from '../core/spec-key.js';
import {
  checkSpecMap,
  ClusterOutputSchema,
  readSpecMap,
  SPEC_MAP_JSON,
  SpecMapSchema,
  writeSpecMap,
  type MapCheck,
  type SpecMap,
} from '../core/spec-map.js';
import { renderCapabilitySpec } from '../core/spec-render.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { writeFile } from '../core/writer.js';
import {
  collectSourceFiles,
  collectTestFiles,
  rootOf,
  summarizeFiles,
  synthesizeCapability,
  toCapabilityDoc,
  type SourceFile,
} from './spec-synth.js';
import { writeSystemSpec } from './spec-index.js';

export interface SpecDraftOpts {
  /** Write the specs without stopping at the map for review. */
  yes?: boolean;
  /** Continue from `.specguard/spec-map.json`. */
  fromMap?: boolean;
  /** Overwrite specs that already exist. */
  force?: boolean;
  /** Ids of `specs/history` entries to link from every generated spec. */
  history?: string[];
  /** Maintainers' steer for the clustering, such as capability names to use. Followed unless the material contradicts it. */
  guidance?: string;
  onLog?: (line: string) => void;
}

export const DEFAULT_TARGET: [number, number] = [8, 15];

const CLUSTER_SYSTEM =
  'You are a software architect. Group a codebase into functional capabilities that each deliver user or business value, ' +
  'plus a short description of the whole system. A capability is a cohesive area of functionality (for example "Identity & Access" or ' +
  '"Training: Learner Journey"), never a single file or layer. Every source file must be owned by at least one capability. ' +
  'Use directory globs, not one entry per file, and only globs that match real files. Use a component (for example frontend and backend halves) ' +
  'only when a capability is too large to read as one spec. Do not invent functionality that the material does not support.';

async function readmeExcerpt(root: string): Promise<string> {
  for (const name of ['README.md', 'readme.md']) {
    const file = path.join(root, name);
    if (await fileExists(file)) return (await readFile(file)).slice(0, 4000);
  }
  return '';
}

/** Ask the frontier model for a capability map, retrying once when the count misses the target. */
export async function proposeSpecMap(
  config: SpecGuardConfig,
  material: string,
  target: [number, number],
  check: (map: SpecMap) => Promise<MapCheck>,
  guidance?: string,
): Promise<MapCheck> {
  const steer = guidance?.trim() ? `\n\nGuidance from the maintainers (follow it unless the material contradicts it):\n${guidance.trim()}` : '';
  let nudge = '';
  let last: MapCheck | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await llmGenerateObject({
      provider: config.llm.provider,
      model: config.llm.model,
      apiKeyEnv: config.llm.apiKeyEnv,
      pipeline: 'cluster',
      system: CLUSTER_SYSTEM,
      prompt: `${material}\n\nProduce between ${target[0]} and ${target[1]} capabilities.${steer}${nudge}`,
      schema: ClusterOutputSchema,
    });
    try {
      last = await check(SpecMapSchema.parse(raw));
    } catch (err) {
      // A malformed id or a duplicate is the model's slip, not a reason to abandon the run: ask once more.
      if (attempt === 1) throw err;
      nudge = `\n\nYour previous answer was rejected: ${err instanceof Error ? err.message.slice(0, 400) : String(err)}. Use lowercase kebab-case ids and give every capability a distinct id.`;
      continue;
    }
    const n = last.map.capabilities.length;
    if (n >= target[0] && n <= target[1]) return last;
    nudge = `\n\nYour previous answer had ${n} capabilities. It must have between ${target[0]} and ${target[1]}; merge or split accordingly.`;
  }
  return last as MapCheck;
}

export async function runSpecDraft(config: SpecGuardConfig, opts: SpecDraftOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('spec-draft');
  const log = (line: string): void => (opts.onLog ? opts.onLog(line) : void result.messages.push(line));
  const root = rootOf(config);
  const target = config.granularity?.target ?? DEFAULT_TARGET;

  const files = await collectSourceFiles(config);
  if (files.length === 0) {
    result.failed = 1;
    result.exitCode = ExitCode.ValidationFailed;
    result.messages.push('no source files matched the configured source globs');
    return result;
  }
  const sourceRels = files.map((f) => f.rel);
  const checkMap = (map: SpecMap): Promise<MapCheck> => checkSpecMap(map, { root, sourceFiles: sourceRels, target });

  let check: MapCheck;
  const summaries = opts.fromMap ? {} : await summarizeFiles(config, files, { onLog: log });
  if (opts.fromMap) {
    const saved = await readSpecMap(root);
    if (!saved) {
      result.failed = 1;
      result.exitCode = ExitCode.InternalError;
      result.messages.push(`no ${SPEC_MAP_JSON}; run \`specguard spec draft\` first`);
      return result;
    }
    check = await checkMap(saved);
  } else {
    const tests = await collectTestFiles(config);
    const docs = (await expandGlobs(['README.md', 'docs/**/*.md'], root)).map((a) => path.relative(root, a).split(path.sep).join('/')).slice(0, 100);
    const material = [
      `Project README (excerpt):\n${await readmeExcerpt(root)}`,
      `Source files (${files.length}), one per line as "path — what it does":`,
      ...files.map((f) => `${f.rel} — ${summaries[f.rel] ?? ''}`),
      `\nTest files:\n${tests.slice(0, 300).join('\n')}`,
      `\nDoc files:\n${docs.join('\n')}`,
    ].join('\n');
    check = await proposeSpecMap(config, material, target, checkMap, opts.guidance);
    await writeSpecMap(root, check);
    log(`[info] wrote capability map: ${check.map.capabilities.length} capabilities, ${check.unowned.length} unowned file(s)`);
    for (const w of check.warnings) log(`[warn] ${w}`);
    if (!opts.yes) {
      log('Review .specguard/spec-map.md, edit .specguard/spec-map.json if needed, then run `specguard spec draft --from-map`.');
      return result;
    }
  }

  const byRel = new Map<string, SourceFile>(files.map((f) => [f.rel, f]));
  const ownedBy = async (globs: string[]): Promise<SourceFile[]> => {
    const out = new Map<string, SourceFile>();
    for (const abs of await expandGlobs(globs, root)) {
      const r = path.relative(root, abs).split(path.sep).join('/');
      const hit = byRel.get(r);
      if (hit) out.set(r, hit);
    }
    return [...out.values()];
  };
  const fileSummaries = Object.keys(summaries).length > 0 ? summaries : await summarizeFiles(config, files, { onLog: log });
  const capsDir = path.join(specsRootDir(config), 'capabilities');
  const history = opts.history ?? [];

  for (const plan of check.map.capabilities) {
    const target = path.join(capsDir, `${plan.id}.md`);
    if (!opts.force && (await fileExists(target))) {
      result.skipped += 1;
      result.items.push({ key: plan.id, status: 'skipped', path: target, message: 'exists; use --force to overwrite' });
      continue;
    }
    try {
      const owned = await ownedBy(plan.sources);
      const synth = await synthesizeCapability(config, {
        plan,
        ownedFiles: owned,
        summaries: fileSummaries,
        testFiles: plan.tests,
        systemTitle: check.map.system.title,
      });
      const merged = mergeClaims([{ specKey: plan.id, claims: synth.requirements.map((r) => ({ text: r.text, suggestedId: r.id })) }]);
      await writeFile(target, renderCapabilitySpec(toCapabilityDoc(plan, synth, merged.claims, { kind: 'capability', parent: 'system', history })));
      result.created += 1;
      result.items.push({ key: plan.id, status: 'created', path: target });
      log(`[gen] ${plan.id} (${owned.length} files, ${merged.claims.length} requirements)`);

      for (const comp of plan.components) {
        const compOwned = await ownedBy(comp.sources);
        const compSynth = await synthesizeCapability(config, {
          plan: { ...plan, id: comp.id, title: comp.title, value: comp.value, sources: comp.sources, components: [] },
          ownedFiles: compOwned,
          summaries: fileSummaries,
          testFiles: plan.tests,
          systemTitle: check.map.system.title,
        });
        const compMerged = mergeClaims([{ specKey: comp.id, claims: compSynth.requirements.map((r) => ({ text: r.text, suggestedId: r.id })) }]);
        const compFile = path.join(capsDir, plan.id, `${comp.id}.md`);
        await writeFile(
          compFile,
          renderCapabilitySpec(
            toCapabilityDoc({ id: comp.id, title: comp.title, value: comp.value, sources: comp.sources, tests: [], docs: [] }, compSynth, compMerged.claims, {
              kind: 'component',
              parent: plan.id,
              history,
            }),
          ),
        );
        result.created += 1;
        result.items.push({ key: comp.id, status: 'created', path: compFile });
      }
    } catch (err) {
      result.failed += 1;
      result.items.push({ key: plan.id, status: 'failed', message: err instanceof Error ? err.message : String(err) });
      log(`[fail] ${plan.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await writeSystemSpec(config, check.map, { force: opts.force, history, log });
  if (result.failed > 0) result.exitCode = ExitCode.ValidationFailed;
  return result;
}
