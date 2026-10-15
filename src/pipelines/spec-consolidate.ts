/**
 * `specguard spec consolidate`: migrate per-file (v1) specs to functional
 * capability specs.
 *
 * Cluster the existing specs into capabilities, merge their requirements
 * (the model writes functional requirements and says which old claims each
 * one absorbs; claims with an id that it leaves out are carried over verbatim), then rewrite
 * everything keyed by the old claim refs in one pass: test tags, the proof
 * ledger and the drift registry. The old specs move to `specs/_archive/v1/`.
 * The alias map stays in `.specguard/claim-migration.json` so results that
 * still carry old tags are accepted on ingest for one release.
 *
 * Spec: specs/capabilities/spec-authoring.md
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  emptyMigration,
  mergeClaims,
  MIGRATION_FILE,
  aliasRef,
  rekeyLedger,
  rekeyRegistry,
  type ClaimMigration,
} from '../core/claim-migration.js';
import { rewriteClaimRefs } from '../core/claim-tags.js';
import { loadRegistry, saveRegistry } from '../core/drift-registry.js';
import { ExitCode } from '../core/exit-codes.js';
import { emptyLedger, type ProofLedger } from '../core/proof-ledger.js';
import { expandGlobs, fileExists, readFile } from '../core/reader.js';
import { loadRepoSpecs } from '../core/spec-graph.js';
import { specsRootDir } from '../core/spec-key.js';
import { checkSpecMap, readSpecMap, SPEC_MAP_JSON, writeSpecMap, type MapCheck, type SpecMap } from '../core/spec-map.js';
import { renderCapabilitySpec } from '../core/spec-render.js';
import type { ParsedSpec, PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { writeFile } from '../core/writer.js';
import { DEFAULT_TARGET, proposeSpecMap } from './spec-draft.js';
import { writeSystemSpec } from './spec-index.js';
import { ledgerPath } from './proof.js';
import { collectSourceFiles, collectTestFiles, rootOf, synthesizeCapability, toCapabilityDoc, type SourceFile } from './spec-synth.js';

export interface SpecConsolidateOpts {
  yes?: boolean;
  fromMap?: boolean;
  force?: boolean;
  /** Keep the v1 spec files where they are and leave tags, ledger and registry alone. */
  noArchive?: boolean;
  /** Rewrite `Spec: specs/capabilities/spec-authoring.md` comments in source files to the new capability spec. */
  rewriteSourceRefs?: boolean;
  history?: string[];
  /** Maintainers' steer for the clustering, such as capability names to use. */
  guidance?: string;
  onLog?: (line: string) => void;
}

const MAX_MATERIAL_CHARS = 30_000;
const ARCHIVE_DIR = '_archive/v1';

const CLUSTER_SYSTEM_NOTE =
  'You are consolidating many fine-grained specs into functional capabilities. Assign EVERY existing spec to exactly one capability by listing its key in "specs". ' +
  'The capability\'s "sources" globs should cover the code those specs describe (the module headers may be wrong; use the real file list).';

interface V1Entry {
  spec: ParsedSpec;
  /** Claims in order, with the ref used to name them: `specKey#id` or `specKey#cN`. */
  claims: Array<{ ref: string; id?: string; text: string }>;
}

function v1Entries(config: SpecGuardConfig): V1Entry[] {
  return loadRepoSpecs(config)
    .map((r) => r.spec)
    .filter((s) => !s.meta.kind && s.specKey !== 'system')
    .map((spec) => ({
      spec,
      claims: spec.claims.map((c, i) => ({ ref: `${spec.specKey}#${c.id ?? `c${i + 1}`}`, id: c.id, text: c.text })),
    }));
}

function materialFor(entries: V1Entry[]): string {
  const parts: string[] = [];
  let used = 0;
  for (const e of entries) {
    const scen = e.spec.scenarios.map((s) => s.name).join('; ');
    const block =
      `## ${e.spec.specKey} — ${e.spec.title}\nmodule: ${e.spec.meta.module ?? ''}\n${e.spec.overview.slice(0, 400)}\n` +
      e.claims.map((c) => `- ${c.ref}: ${c.text}`).join('\n') +
      (scen ? `\nscenarios: ${scen}` : '');
    if (used + block.length > MAX_MATERIAL_CHARS) {
      parts.push(`## ${e.spec.specKey} — ${e.spec.title} (${e.claims.length} claims, omitted for length)`);
      continue;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n\n');
}

export async function runSpecConsolidate(config: SpecGuardConfig, opts: SpecConsolidateOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('spec-consolidate');
  const log = (line: string): void => (opts.onLog ? opts.onLog(line) : void result.messages.push(line));
  const root = rootOf(config);
  const specsRoot = specsRootDir(config);
  const target = config.granularity?.target ?? DEFAULT_TARGET;

  const entries = v1Entries(config);
  if (entries.length === 0) {
    result.messages.push('no v1 specs to consolidate');
    return result;
  }
  const files = await collectSourceFiles(config);
  const sourceRels = files.map((f) => f.rel);
  const v1Keys = entries.map((e) => e.spec.specKey);
  const checkMap = (map: SpecMap): Promise<MapCheck> => checkSpecMap(map, { root, sourceFiles: sourceRels, target, v1Specs: v1Keys });

  let check: MapCheck;
  if (opts.fromMap) {
    const saved = await readSpecMap(root);
    if (!saved) {
      result.failed = 1;
      result.exitCode = ExitCode.InternalError;
      result.messages.push(`no ${SPEC_MAP_JSON}; run \`specguard spec consolidate\` first`);
      return result;
    }
    check = await checkMap(saved);
  } else {
    const material = [
      CLUSTER_SYSTEM_NOTE,
      `Existing specs (${entries.length}):`,
      ...entries.map((e) => `- ${e.spec.specKey} — ${e.spec.title}; module ${e.spec.meta.module ?? '?'}; ${e.claims.length} claims; ${e.spec.overview.slice(0, 160).replace(/\s+/g, ' ')}`),
      `\nSource files (${files.length}):`,
      ...sourceRels,
      `\nTest files:\n${(await collectTestFiles(config)).slice(0, 300).join('\n')}`,
    ].join('\n');
    check = await proposeSpecMap(config, material, target, checkMap, opts.guidance);
    await writeSpecMap(root, check);
    log(`[info] wrote capability map: ${check.map.capabilities.length} capabilities absorbing ${v1Keys.length - check.unassignedSpecs.length} of ${v1Keys.length} specs`);
    for (const w of check.warnings) log(`[warn] ${w}`);
    if (!opts.yes) {
      log('Review .specguard/spec-map.md, edit .specguard/spec-map.json if needed, then run `specguard spec consolidate --from-map`.');
      return result;
    }
  }

  if (check.unassignedSpecs.length > 0 || check.doubleAssignedSpecs.length > 0) {
    result.failed = 1;
    result.exitCode = ExitCode.ValidationFailed;
    if (check.unassignedSpecs.length > 0) result.messages.push(`specs not assigned to a capability: ${check.unassignedSpecs.join(', ')}`);
    if (check.doubleAssignedSpecs.length > 0) result.messages.push(`specs assigned to several capabilities: ${check.doubleAssignedSpecs.join(', ')}`);
    result.messages.push(`Fix ${SPEC_MAP_JSON} and rerun with --from-map.`);
    return result;
  }

  const byRel = new Map<string, SourceFile>(files.map((f) => [f.rel, f]));
  const migration: ClaimMigration = emptyMigration();
  const capsDir = path.join(specsRoot, 'capabilities');
  const history = opts.history ?? [];
  const entryByKey = new Map(entries.map((e) => [e.spec.specKey, e]));
  const absorbed: string[] = [];

  for (const plan of check.map.capabilities) {
    const out = path.join(capsDir, `${plan.id}.md`);
    if (!opts.force && (await fileExists(out))) {
      result.skipped += 1;
      result.items.push({ key: plan.id, status: 'skipped', path: out, message: 'exists; use --force to overwrite' });
      continue;
    }
    try {
      const mine = plan.specs.map((k) => entryByKey.get(k)).filter((e): e is V1Entry => Boolean(e));
      const owned = new Map<string, SourceFile>();
      for (const abs of await expandGlobs(plan.sources, root)) {
        const r = path.relative(root, abs).split(path.sep).join('/');
        const hit = byRel.get(r);
        if (hit) owned.set(r, hit);
      }
      const summaries = Object.fromEntries(mine.map((e) => [e.spec.specKey, e.spec.overview.slice(0, 160)]));
      const synth = await synthesizeCapability(config, {
        plan,
        ownedFiles: [...owned.values()],
        summaries: { ...Object.fromEntries([...owned.keys()].map((k) => [k, ''])), ...summaries },
        testFiles: plan.tests,
        v1Material: materialFor(mine),
        systemTitle: check.map.system.title,
      });

      // Requirements the model wrote, then every old claim *with an id* it did not absorb, carried over
      // verbatim so its tags and proofs keep a home. A bullet with no id has no reference to preserve,
      // and the model's functional requirements supersede it: carrying those over would turn a
      // capability back into a list of per-file details.
      const known = new Set(mine.flatMap((e) => e.claims.map((c) => c.ref)));
      const replaced = new Set(synth.requirements.flatMap((r) => r.replaces ?? []).filter((ref) => known.has(ref)));
      const carried = mine
        .map((e) => ({ specKey: e.spec.specKey, claims: e.claims.filter((c) => c.id && !replaced.has(c.ref)).map((c) => ({ id: c.id, text: c.text })) }))
        .filter((s) => s.claims.length > 0);
      const merged = mergeClaims([{ specKey: plan.id, claims: synth.requirements.map((r) => ({ text: r.text, suggestedId: r.id })) }, ...carried]);

      const newKey = `capabilities/${plan.id}`;
      const idByText = new Map(merged.claims.map((c) => [c.text.replace(/\s+/g, ' ').trim().toLowerCase(), c.id]));
      for (const req of synth.requirements) {
        const id = idByText.get(req.text.replace(/\s+/g, ' ').trim().toLowerCase());
        if (!id) continue;
        for (const ref of req.replaces ?? []) if (known.has(ref) && !/#c\d+$/.test(ref)) migration.aliases[ref] = `${newKey}#${id}`;
      }
      for (const [old, id] of Object.entries(merged.aliases)) migration.aliases[old] = `${newKey}#${id}`;
      for (const e of mine) {
        migration.specs[e.spec.specKey] = newKey;
        absorbed.push(e.spec.specKey);
      }

      await writeFile(out, renderCapabilitySpec(toCapabilityDoc(plan, synth, merged.claims, { kind: 'capability', parent: 'system', history })));
      result.created += 1;
      result.items.push({ key: plan.id, status: 'created', path: out });
      log(`[gen] ${plan.id}: ${mine.length} specs -> ${merged.claims.length} requirements (${carried.reduce((n, s) => n + s.claims.length, 0)} carried over)`);
    } catch (err) {
      result.failed += 1;
      result.items.push({ key: plan.id, status: 'failed', message: err instanceof Error ? err.message : String(err) });
      log(`[fail] ${plan.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await writeSystemSpec(config, check.map, { force: opts.force, history, log });
  if (result.failed > 0) {
    result.exitCode = ExitCode.ValidationFailed;
    log('Some capabilities failed; nothing was archived or rewritten. Fix the cause and rerun with --from-map --force.');
    return result;
  }
  if (opts.noArchive) return result;
  // A capability that was skipped (it already exists) was not synthesised now, so its old claims have no
  // recorded new home. Archiving the rest would leave old and new specs side by side with half the aliases.
  if (result.skipped > 0 && !opts.force) {
    log(`${result.skipped} capability spec(s) already exist; nothing was archived or rewritten. Rerun with --force to regenerate them and migrate everything together, or --no-archive to keep the old specs.`);
    return result;
  }

  const filePaths = new Map(entries.map((e) => [e.spec.specKey, e.spec.filePath]));
  const archived = await migrateState(config, migration, absorbed, filePaths, opts, log);
  result.messages.push(`archived ${archived} of ${absorbed.length} v1 spec(s) under specs/${ARCHIVE_DIR}; alias map in ${MIGRATION_FILE}`);
  return result;
}

/** Everything keyed by old refs: tags, ledger, registry, source comments, then the specs themselves. */
async function migrateState(
  config: SpecGuardConfig,
  migration: ClaimMigration,
  absorbed: string[],
  filePaths: Map<string, string>,
  opts: SpecConsolidateOpts,
  log: (line: string) => void,
): Promise<number> {
  const root = rootOf(config);
  const specsRoot = specsRootDir(config);
  // Refs that name this repo may be written with its key as a prefix; refs naming another repo are not ours.
  const ownKeys = [path.basename(root)];

  // Test tags.
  let tagged = 0;
  for (const rel of await collectTestFiles(config)) {
    const abs = path.join(root, rel);
    const before = await readFile(abs);
    const { text, changed } = rewriteClaimRefs(before, (ref) => aliasRef(ref, migration, ownKeys));
    if (changed > 0) {
      await writeFile(abs, text);
      tagged += changed;
    }
  }
  log(`[info] rewrote ${tagged} claim tag(s) in test files`);

  // Proof ledger.
  const ledgerFile = ledgerPath(root, config.paths?.proofLedger);
  if (await fileExists(ledgerFile)) {
    try {
      const ledger = JSON.parse(await readFile(ledgerFile)) as ProofLedger;
      const { ledger: next, moved } = rekeyLedger(ledger.proofs ? ledger : emptyLedger(), migration, ownKeys);
      await writeFile(ledgerFile, JSON.stringify(next, null, 2) + '\n');
      log(`[info] rekeyed ${moved} proof row(s); they stay stale until re-ingested`);
    } catch {
      log('[warn] proof ledger unreadable; left as is');
    }
  }

  // Drift registry.
  const registry = loadRegistry(root);
  const { registry: nextRegistry, moved } = rekeyRegistry(registry, migration.specs);
  if (moved > 0) saveRegistry(root, nextRegistry);

  // `Spec:` comments in source files.
  if (opts.rewriteSourceRefs) {
    let rewritten = 0;
    for (const f of await collectSourceFiles(config)) {
      const text = await readFile(f.abs);
      const next = text.replace(/(Spec:\s*specs\/)([^\s*]+?)\.md/g, (all, lead: string, key: string) => {
        const to = migration.specs[key];
        return to ? `${lead}${to}.md` : all;
      });
      if (next !== text) {
        await writeFile(f.abs, next);
        rewritten += 1;
      }
    }
    log(`[info] updated Spec: comments in ${rewritten} source file(s)`);
  }

  await writeFile(path.join(root, MIGRATION_FILE), JSON.stringify(migration, null, 2) + '\n');

  // Archive last, so a failure above leaves the v1 specs in place.
  let archived = 0;
  for (const key of absorbed) {
    // Archive the file that was read, wherever it lives, not where a default layout would have put it.
    const from = filePaths.get(key) ?? path.join(specsRoot, `${key}.md`);
    if (!fs.existsSync(from)) {
      log(`[warn] ${key}: spec file not found at ${path.relative(root, from)}; not archived`);
      continue;
    }
    const to = path.join(specsRoot, ARCHIVE_DIR, `${key}.md`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    archived += 1;
  }
  return archived;
}
