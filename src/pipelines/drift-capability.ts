/**
 * Capability-level drift for v2 specs.
 *
 * For each capability, find the owned files whose content changed since the
 * last assessment, read those changes against the capability's Problem &
 * Value and requirements, and record which claims they affect. One verdict per
 * capability, in chunks that fit the model, instead of one call per file.
 *
 * The result lands in `.specguard/drift-assessments.json` (see
 * core/drift-assessments.ts), which decides which proofs go stale.
 *
 * Spec: specs/capabilities/traceability-and-drift.md
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { z } from 'zod';

import { assessmentKey, loadAssessments, saveAssessments, type Assessments } from '../core/drift-assessments.js';
import { getOrCreateSpecEntry, hashFile, hashString, loadRegistry, saveRegistry, updateFileEntry, fromRegistryKey } from '../core/drift-registry.js';
import { ExitCode } from '../core/exit-codes.js';
import { llmGenerateObject } from '../core/llm.js';
import { buildSpecGraph, type SpecNode } from '../core/spec-graph.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { collectSourceFiles } from './spec-synth.js';

export interface CapabilityDriftOpts {
  /** Git ref to diff against. Default: the working tree against HEAD. */
  since?: string;
  /** Restrict to one capability id or spec key. */
  spec?: string;
  /** Reassess every owned file, ignoring the registry. */
  force?: boolean;
}

const CHUNK_BUDGET = 40_000;
const MAX_CHUNKS = 6;

// Lockfiles, snapshots and build output. `build/` only counts at the top level: `src/build/` is real source.
const IGNORED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum)$|\.(snap|lock|min\.js|map)$|(^|\/)(dist|coverage|\.next)\/|^build\//;

export interface ChangedFile {
  path: string;
  diff: string;
}

const interfaceRank = (p: string): number =>
  /(^|\/)(route|page|api|handler|controller|cli|index|server)[./]|\/api\//i.test(p) ? 0 : 1;

/** Shrink one diff to hunk headers plus changed declarations/exports so it fits `budget` characters. */
export function reduceDiff(diff: string, budget: number): string {
  if (diff.length <= budget) return diff;
  const keep = diff
    .split('\n')
    .filter((l) => /^(@@|\+\+\+|---)/.test(l) || /^[+-]\s*(export|public|private|protected|app\.|router\.|@|def |class |func |fn |interface |type )/.test(l));
  const out = keep.join('\n');
  return (out.length > budget ? out.slice(0, budget) : out) + '\n... (diff reduced to headers and declarations)';
}

/**
 * Pack changed files into chunks of at most `budget` characters, interface-like
 * files first. A file larger than the budget is reduced. Returns the chunks and
 * the files that did not fit within `maxChunks` (to review manually).
 */
export function chunkChanges(files: ChangedFile[], budget = CHUNK_BUDGET, maxChunks = MAX_CHUNKS): { chunks: ChangedFile[][]; overflow: string[] } {
  const ordered = [...files].sort((a, b) => interfaceRank(a.path) - interfaceRank(b.path) || a.path.localeCompare(b.path));
  const chunks: ChangedFile[][] = [];
  const overflow: string[] = [];
  let current: ChangedFile[] = [];
  let used = 0;
  for (const f of ordered) {
    const diff = reduceDiff(f.diff, budget);
    if (used + diff.length > budget && current.length > 0) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    if (chunks.length >= maxChunks) {
      overflow.push(f.path);
      continue;
    }
    current.push({ path: f.path, diff });
    used += diff.length;
  }
  if (current.length > 0) {
    if (chunks.length < maxChunks) chunks.push(current);
    else overflow.push(...current.map((f) => f.path));
  }
  return { chunks, overflow };
}

const VerdictSchema = z.object({
  drifted: z.boolean().describe('True when the change alters, adds or removes behaviour that the requirements describe.'),
  confidence: z.number().describe('0 to 1'),
  reason: z.string(),
  affectedClaims: z.array(z.string()).describe('Ids of the requirements whose behaviour the change affects. Empty when none.'),
  unspecifiedBehaviour: z.array(z.string()).describe('New user-visible behaviour that no requirement covers.'),
});

const SYSTEM =
  'You review a code change against the functional spec of the capability it belongs to. Decide whether the change affects behaviour the requirements describe, ' +
  'and name the affected requirement ids. Refactors, renames, comments and formatting do not affect requirements. ' +
  'Also list new user-visible behaviour that no requirement covers.';

function gitDiff(root: string, since: string | undefined, file: string): string {
  const args = since ? ['diff', since, '-U2', '--diff-algorithm=histogram', '--', file] : ['diff', 'HEAD', '-U2', '--diff-algorithm=histogram', '--', file];
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function requirementsOf(node: SpecNode): string {
  return node.spec.claims.filter((c) => c.id).map((c) => `- ${c.id}: ${c.text}`).join('\n');
}

export async function runCapabilityDrift(config: SpecGuardConfig, opts: CapabilityDriftOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('drift');
  const log = (line: string): void => void result.messages.push(line);
  const root = config.rootDir ?? process.cwd();
  const graph = await buildSpecGraph(config);
  const registry = loadRegistry(root);
  const assessments: Assessments = loadAssessments(root);

  const nodes = [...graph.nodes.values()].filter(
    (n) => (n.kind === 'capability' || n.kind === 'component') && (!opts.spec || n.id === opts.spec || n.specKey === opts.spec),
  );
  let drifted = 0;
  const changedAnywhere = new Set<string>();

  for (const node of nodes) {
    const specHash = hashString(JSON.stringify(node.spec.sections));
    const entry = getOrCreateSpecEntry(registry, node.specKey, specHash);
    const first = Object.keys(entry.files).length === 0;
    const forSpec = (assessments[node.specKey] ??= {});

    const current: Record<string, string> = {};
    for (const f of node.ownedFiles) {
      const h = hashFile(fromRegistryKey(root, f));
      if (h) current[f] = h;
    }
    const changed = Object.keys(current).filter((f) => opts.force || entry.files[f]?.hash !== current[f]);
    const baseline = first && !opts.force;

    if (baseline) {
      for (const f of Object.keys(current)) updateFileEntry(entry, f, current[f], 'new-file');
      result.skipped += 1;
      result.items.push({ key: node.id, status: 'skipped', message: 'baselined; changes are assessed from the next run' });
      log(`[baseline] ${node.id} (${Object.keys(current).length} files)`);
      continue;
    }
    if (changed.length === 0) {
      result.items.push({ key: node.id, status: 'ok' });
      continue;
    }
    for (const f of changed) changedAnywhere.add(f);

    // Files whose changes cannot affect behaviour are assessed as unaffected without a model call.
    const reviewable: ChangedFile[] = [];
    for (const f of changed) {
      if (IGNORED.test(f)) {
        forSpec[assessmentKey(f, current[f])] = { affectedClaims: [], at: new Date().toISOString(), reason: 'lockfile, generated or build output' };
        updateFileEntry(entry, f, current[f], 'no-drift');
        continue;
      }
      const diff = gitDiff(root, opts.since, f);
      reviewable.push({ path: f, diff: diff || `(no diff available; file is new or committed earlier)\n${fs.readFileSync(fromRegistryKey(root, f), 'utf8').slice(0, 4000)}` });
    }

    const { chunks, overflow } = chunkChanges(reviewable);
    const affected = new Set<string>();
    const unspecified: string[] = [];
    const reasons: string[] = [];
    let anyDrift = false;
    for (const chunk of chunks) {
      let verdict: z.infer<typeof VerdictSchema>;
      try {
        verdict = await llmGenerateObject({
          provider: config.llm.provider,
          model: config.llm.model,
          apiKeyEnv: config.llm.apiKeyEnv,
          pipeline: 'drift',
          system: SYSTEM,
          prompt:
            `Capability: ${node.spec.title} (${node.id})\n\nProblem & Value:\n${node.spec.sections['Problem & Value'] ?? node.spec.overview}\n\n` +
            `Requirements:\n${requirementsOf(node)}\n\nChanged files:\n` +
            chunk.map((c) => `### ${c.path}\n${c.diff}`).join('\n\n'),
          schema: VerdictSchema,
        });
      } catch {
        // No usable verdict: treat the change as affecting every claim, as the file-level drift check does.
        verdict = { drifted: true, confidence: 0, reason: 'no verdict available; the change is assumed to matter', affectedClaims: ['*'], unspecifiedBehaviour: [] };
      }
      // Only ids the spec really has count; an id the model made up must not read as "no claim affected".
      const known = new Set(node.spec.claims.map((c) => c.id).filter(Boolean) as string[]);
      const named = verdict.affectedClaims.map((c) => c.replace(/^.*#/, '')).filter((id) => known.has(id));
      const claims = verdict.drifted ? (named.length > 0 ? named : ['*']) : [];
      if (verdict.drifted) anyDrift = true;
      for (const c of claims) affected.add(c);
      unspecified.push(...verdict.unspecifiedBehaviour);
      if (verdict.reason) reasons.push(verdict.reason);
      for (const c of chunk) {
        forSpec[assessmentKey(c.path, current[c.path])] = { affectedClaims: claims, at: new Date().toISOString(), reason: verdict.reason };
        updateFileEntry(entry, c.path, current[c.path], verdict.drifted ? 'drifted' : 'no-drift');
      }
    }
    // Files that did not fit are left unassessed, so their proofs stay stale until someone reviews them.
    for (const f of overflow) updateFileEntry(entry, f, entry.files[f]?.hash ?? '', 'drifted');

    if (anyDrift || overflow.length > 0 || unspecified.length > 0) {
      drifted += 1;
      const why = [
        anyDrift ? `affects ${[...affected].join(', ')}` : '',
        overflow.length > 0 ? `${overflow.length} file(s) too large to review automatically: ${overflow.slice(0, 5).join(', ')}` : '',
        unspecified.length > 0 ? `unspecified behaviour: ${unspecified.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      result.items.push({ key: node.id, status: 'failed', message: why });
      log(`[drift] ${node.id}: ${why}${reasons[0] ? ` (${reasons[0]})` : ''}`);
    } else {
      result.items.push({ key: node.id, status: 'ok', message: `${changed.length} file(s) changed, no requirement affected` });
      log(`[ok] ${node.id}: ${changed.length} file(s) changed, no requirement affected`);
    }
  }

  // Changed source files that no capability owns point at a capability whose `sources` are too narrow.
  if (!opts.spec) {
    const sourceRels = (await collectSourceFiles(config)).map((f) => f.rel);
    const unowned = graph.unowned(sourceRels).filter((f) => {
      const diff = gitDiff(root, opts.since, f);
      return diff.length > 0;
    });
    for (const f of unowned) {
      result.items.push({ key: f, status: 'failed', message: 'changed but owned by no spec' });
      log(`[unowned-change] ${f}`);
    }
    drifted += unowned.length;
  }

  saveRegistry(root, registry);
  saveAssessments(root, assessments);
  result.failed = drifted;
  result.exitCode = drifted > 0 ? ExitCode.DriftDetected : ExitCode.Success;
  log(`drift: ${nodes.length} capabilities checked, ${drifted} with drift`);
  return result;
}
