/**
 * `specguard check`: the one spec-health command.
 *
 * It builds the trace model (system -> capability -> claim) once and renders
 * views of it: the default summary (what `status` reported), coverage, gaps,
 * the traceability matrix, drift and alignment. `status`, `gap-analysis`,
 * `matrix` and `drift` keep their names and exit codes and delegate here when a
 * repo uses v2 specs.
 *
 * Spec: specs/capabilities/traceability-and-drift.md
 */
import path from 'node:path';

import { parseClaimRef } from '../core/claims.js';
import { ExitCode } from '../core/exit-codes.js';
import { listHistory } from '../core/history.js';
import { intentGaps, staleDocs } from '../core/intent-gap.js';
import { buildSpecGraph } from '../core/spec-graph.js';
import { specsRootDir } from '../core/spec-key.js';
import { buildTraceModel, TRACE_FILE, type TraceModel, type TraceNode } from '../core/trace.js';
import type { EffectiveVerdict } from '../core/proof-ledger.js';
import { computeStatement, explainCapability, headlineLines, type SystemStatement } from '../core/proof-statement.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { writeFile } from '../core/writer.js';
import { runAlign } from './align.js';
import { runCapabilityDrift } from './drift-capability.js';
import { appendProofCoverage, walkClaimVerdicts } from './proof.js';
import { evidenceSourceLabel, loadEffectiveLedger, noteApprovalsAsApprovals, readOnlyStore, type EffectiveLedger } from './proof-sources.js';
import { buildStatementInput } from './statement-input.js';
import type { LedgerStore } from '../core/state/ledger-store.js';
import { collectSourceFiles } from './spec-synth.js';
import { versionInfo } from '../core/version.js';

export type CheckView = 'summary' | 'coverage' | 'gaps' | 'matrix' | 'drift' | 'align';

export interface CheckOpts {
  view?: CheckView;
  /** Matrix as CSV instead of JSON. */
  csv?: boolean;
  /** Matrix output path, relative to the repo root. */
  out?: string;
  /** With `drift`: the git ref to diff against. With the summary: the base the proof statement judges change against. */
  since?: string;
  spec?: string;
  /** Summary only: explain one capability's proof statement (its blocking reasons first) instead of the whole summary. */
  explain?: string;
  /** Summary only: judge the proof statement as if every `proof.require*` gate were on. */
  strict?: boolean;
  /** Pipeline name to report under, so `status` and friends keep their `--json` identity. */
  as?: string;
  /** Read the local proof cache alone: ignore the CI proof notes in git (`--no-notes`). */
  noNotes?: boolean;
}

/** True when the repo has at least one spec that declares a `kind` (v2). */
export async function isV2Repo(config: SpecGuardConfig): Promise<boolean> {
  const graph = await buildSpecGraph(config);
  return [...graph.nodes.values()].some((n) => n.kind !== undefined);
}

const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 100));

/**
 * The effective ledger `check` reads, or undefined when the local file ledger is all there is: with no note to read the
 * file is used as it always was, so a repo without notes behaves exactly as before.
 */
async function effectiveFor(config: SpecGuardConfig, opts: CheckOpts): Promise<{ eff?: EffectiveLedger; warnings: string[] }> {
  if (opts.noNotes) return { warnings: [] };
  try {
    const eff = await loadEffectiveLedger(config);
    return { ...(eff.note ? { eff } : {}), warnings: eff.warnings };
  } catch (err) {
    return { warnings: [`proof notes could not be read: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/** The trace model with proof verdicts from the ledger (or the given store) and the repo's source files. */
export async function loadTrace(config: SpecGuardConfig, opts: { store?: LedgerStore } = {}): Promise<{ model: TraceModel; verdicts: Map<string, EffectiveVerdict>; sourceFiles: string[] }> {
  const verdicts = new Map<string, EffectiveVerdict>();
  const details: NonNullable<Parameters<typeof buildTraceModel>[1]>['details'] = new Map();
  await walkClaimVerdicts(config, (ref, verdict, detail) => {
    const parsed = parseClaimRef(ref);
    if (!parsed) return;
    const key = `${parsed.specKey}#${parsed.claimId}`;
    verdicts.set(key, verdict);
    if (detail) details.set(key, { layers: detail.layers, required: detail.required, missing: detail.missing });
  }, opts.store ? { store: opts.store } : {});
  const sourceFiles = (await collectSourceFiles(config)).map((f) => f.rel);
  return { model: await buildTraceModel(config, { verdicts, details, sourceFiles }), verdicts, sourceFiles };
}

/** `STATEMENT:` lines with the evidence source after each capability, and the note the proofs came from after the system line. */
function withSources(lines: string[], statement: SystemStatement, eff: EffectiveLedger | undefined): string[] {
  if (!eff?.note) return lines;
  return lines.map((line, i) => {
    const cap = statement.capabilities[i];
    if (cap) return cap.evidence.source ? `${line} · ${cap.evidence.source}` : line;
    return `${line} · proofs from note @${eff.note!.commit.slice(0, 7)}`;
  });
}

const specNodes = (m: TraceModel): TraceNode[] => m.nodes.filter((n) => n.kind === 'capability' || n.kind === 'component');

export async function runCheck(config: SpecGuardConfig, opts: CheckOpts = {}): Promise<PipelineResult> {
  const view = opts.view ?? 'summary';
  if (view === 'drift') return { ...(await runCapabilityDrift(config, { since: opts.since, spec: opts.spec })), pipeline: opts.as ?? 'check' };
  if (view === 'align') return runAlign(config, { spec: opts.spec });

  let intentFailures = 0;
  const result = emptyResult(opts.as ?? 'check');
  const log = (line: string): void => void result.messages.push(line);
  const root = config.rootDir ?? process.cwd();
  const { eff, warnings: noteWarnings } = await effectiveFor(config, opts);
  const store = eff ? readOnlyStore(eff) : undefined;
  const { model, sourceFiles } = await loadTrace(config, store ? { store } : {});
  if (view === 'summary' && opts.explain !== undefined && !specNodes(model).some((n) => n.id === opts.explain || n.specKey === opts.explain)) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    log(`no capability "${opts.explain}"; known: ${specNodes(model).map((n) => n.id).join(', ') || 'none'}`);
    return result;
  }
  // Git-derived gaps go into the trace so readers without the repo's history can report them.
  const gaps = view === 'summary' ? intentGaps(root, model.nodes, listHistory(config), path.relative(root, specsRootDir(config)).split(path.sep).join('/')) : [];
  if (view === 'summary') model.gaps = { intent: gaps, docsStale: staleDocs(root, model.nodes) };
  // The proof statement judges each capability on four pillars from the evidence in the repo; it leads the summary.
  let statement: SystemStatement | undefined;
  let statementWarnings: string[] = [];
  if (view === 'summary') {
    const assembled = await buildStatementInput(config, { model, gaps }, { strict: opts.strict, base: opts.since, ...(eff && store ? { store, extraApprovals: noteApprovalsAsApprovals(eff) } : {}) });
    statementWarnings = [...assembled.warnings, ...noteWarnings];
    statement = computeStatement(assembled.input);
    // Where each capability's evidence came from, when a CI note is part of it.
    if (eff) {
      const specKeys = new Map(model.nodes.map((n) => [n.id, n.specKey]));
      for (const cap of statement.capabilities) {
        const source = evidenceSourceLabel(eff, specKeys.get(cap.capability) ?? cap.capability);
        if (source !== undefined) cap.evidence.source = source;
      }
    }
    model.statement = statement;
    result.statement = statement;
  }
  await writeFile(path.join(root, TRACE_FILE), JSON.stringify({ ...model, tool: versionInfo() }, null, 2) + '\n');

  const errors = model.issues.filter((i) => i.level === 'error');
  const orphans = specNodes(model).filter((n) => n.ownedFiles.length === 0 && n.status !== 'planned');
  if (statement && opts.explain === undefined) result.messages.push(...withSources(headlineLines(statement), statement, eff));
  for (const w of statementWarnings) log(`  [warn] ${w}`);
  for (const issue of model.issues) log(`  [${issue.level === 'error' ? 'error' : 'warn'}] ${issue.code}: ${issue.message}`);

  if (statement && opts.explain !== undefined) {
    const cap = statement.capabilities.find((c) => c.capability === opts.explain || model.nodes.some((n) => n.id === c.capability && n.specKey === opts.explain))!;
    result.messages.push(...explainCapability(cap, { head: statement.head, policy: statement.policy }));
    if (cap.evidence.source) result.messages.push(`Evidence source: ${cap.evidence.source}`);
    // Scoped to the one capability: its own level, counts and exit code.
    const counts = { certified: 0, provisional: 0, 'not-certified': 0, planned: 0 };
    counts[cap.level] += 1;
    result.statement = {
      ...statement,
      level: cap.level,
      certifiedAt: cap.certifiedAt,
      capabilities: [cap],
      system: { reasons: [] },
      counts,
      exitCode: cap.blocking.length > 0 ? ExitCode.NotCertified : ExitCode.Success,
    };
    if (cap.certifiedAt === undefined) delete result.statement.certifiedAt;
    result.created = 1;
    result.failed = cap.blocking.length;
    result.exitCode = errors.length > 0 ? ExitCode.ValidationFailed : result.statement.exitCode;
    return result;
  }

  switch (view) {
    case 'coverage':
      for (const n of specNodes(model)) {
        log(
          `${n.id} [${n.kind}]: ${n.ownedFiles.length} files, ${n.tests.length} tests, ${n.counts.claims} claims ` +
            `(${pct(n.counts.withTests, n.counts.claims)}% cited by a test, ${n.counts.proven} proven)`,
        );
        result.items.push({ key: n.id, status: n.tests.length > 0 ? 'ok' : 'failed', message: n.tests.length > 0 ? undefined : 'no tests' });
      }
      break;

    case 'gaps': {
      for (const f of model.unowned) {
        log(`  [unowned] ${f}`);
        result.items.push({ key: f, status: 'failed', message: 'owned by no spec' });
      }
      for (const n of specNodes(model)) {
        if (n.ownedFiles.length === 0) log(`  [no-sources] ${n.id}${n.status === 'planned' ? ' (planned)' : ''}`);
        if (n.tests.length === 0) log(`  [no-tests] ${n.id}`);
        for (const c of n.claims) {
          if (c.tests.length === 0) log(`  [untested-claim] ${c.ref}`);
          if (c.proof !== 'proven' && c.proof !== 'unproven') log(`  [proof-${c.proof}] ${c.ref}`);
        }
      }
      result.failed = model.unowned.length;
      break;
    }

    case 'matrix': {
      const rows = specNodes(model).flatMap((n) =>
        n.claims.map((c) => ({
          capability: n.id,
          claim: c.ref,
          text: c.text,
          proof: c.proof,
          tests: [...new Set(c.tests.map((t) => t.file))],
          docs: n.docs,
          sources: n.ownedFiles.length,
          history: n.history,
        })),
      );
      const out = opts.out ?? (opts.csv ? '.specguard/traceability.csv' : '.specguard/traceability.json');
      const body = opts.csv
        ? ['capability,claim,proof,tests,docs,sources', ...rows.map((r) => [r.capability, r.claim, r.proof, r.tests.join(' '), r.docs.join(' '), r.sources].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n') + '\n'
        : JSON.stringify({ generated: model.generated, rows }, null, 2) + '\n';
      await writeFile(path.join(root, out), body);
      log(`matrix: ${rows.length} claim(s) across ${specNodes(model).length} capabilities written to ${out}`);
      result.created = rows.length;
      break;
    }

    default: {
      for (const n of specNodes(model)) {
        const c = n.counts;
        log(`# ${n.id} [${n.kind}] ${n.ownedFiles.length} files, ${n.tests.length} tests, ${c.claims} claims (${c.proven} proven, ${c.stale} stale, ${c.failed} failed, ${c.unproven} unproven)`);
        result.items.push({ key: n.id, status: n.ownedFiles.length > 0 ? 'ok' : 'failed', message: n.ownedFiles.length > 0 ? undefined : 'no owned files' });
      }
      for (const u of model.units ?? []) {
        log(`# unit ${u.unit} [${u.kind}] ${u.sourceFiles} source files, ${u.unowned.length} unowned, ${u.capabilities.length} capabilities${u.capabilities.length ? ` (${u.capabilities.join(', ')})` : ''}`);
      }
      // Only configured source files count: a capability may also own docs or other files.
      const sourceSet = new Set(sourceFiles);
      const tested = new Set<string>();
      for (const n of specNodes(model)) if (n.tests.length > 0) for (const f of n.ownedFiles) if (sourceSet.has(f)) tested.add(f);
      const total = model.totals.sourceFiles;
      const ownedSource = total - model.unowned.length;
      for (const f of model.unowned.slice(0, 40)) log(`  [missing-spec] ${f}`);
      log(
        `TOTAL: ${total} source files, ${ownedSource} specs (${pct(ownedSource, total)}%), ` +
          `${tested.size} tests (${pct(tested.size, total)}%), ${model.unowned.length} missing specs`,
      );
      if (orphans.length > 0) {
        log(`ORPHANS: ${orphans.length} spec(s) have no matching source file:`);
        for (const n of orphans) log(`  [orphan] ${n.id}`);
      } else {
        log('ORPHANS: 0');
      }
      await appendProofCoverage(config, log, store ? { store } : {});
      for (const gap of gaps) {
        log(`  [intent-gap] ${gap.id}: code changed ${gap.codeDate}; last recorded intent ${gap.intentDate || 'none'}`);
      }
      // Advisory unless the project opts in.
      if (gaps.length > 0 && config.history?.failOnIntentGap) intentFailures = gaps.length;
      result.created = model.totals.capabilities;
      result.failed = model.unowned.length + orphans.length;
    }
  }

  if (errors.length > 0) {
    result.failed += errors.length;
    result.exitCode = ExitCode.ValidationFailed;
  } else if (intentFailures > 0 && !(view === 'summary' && result.failed > 0)) {
    result.failed += intentFailures;
    result.exitCode = ExitCode.DriftDetected;
  } else if (view === 'summary' && result.failed > 0) {
    result.exitCode = ExitCode.MissingSpecs;
  } else if (view === 'gaps' && result.failed > 0) {
    result.exitCode = ExitCode.MissingSpecs;
  } else if (statement && statement.exitCode !== ExitCode.Success) {
    // Last in precedence, and only when a `proof` gate is on: with every gate off nothing blocks.
    const blocking = statement.capabilities.reduce((n, c) => n + c.blocking.length, 0);
    result.failed += blocking;
    result.exitCode = statement.exitCode;
    log(`NOT CERTIFIED: ${blocking} blocking reason(s) in ${statement.capabilities.filter((c) => c.blocking.length > 0).map((c) => c.capability).join(', ')}; run \`specguard check --explain <capability>\``);
  }
  return result;
}
