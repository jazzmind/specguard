/**
 * Assembles the evidence the proof statement judges, from the repository. This is the impure half of the
 * statement: it reads specs, the approval history, test sources, the proof ledger, ingested coverage and
 * mutation evidence and (with a base ref) git, and hands plain data to `computeStatement`.
 *
 * Whatever is not available is passed as absent, so its pillar says `unknown` and never `fail`: no coverage
 * ingested, no mutation report, no base ref, not a git checkout. Each test file is read once and serves the
 * strength analysis, the claim tags, the layer and the weakening diff. The ledger is walked in deterministic
 * mode, so no drift assessment keeps a proof fresh.
 *
 * Spec: specs/capabilities/traceability-and-drift.md
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { approvalsFrom, indexApprovals } from '../core/approvals.js';
import { claimHashOf } from '../core/claim-hash.js';
import { scanSourceForClaimTags, type ClaimTestEntry, type ClaimTestIndex } from '../core/claim-tags.js';
import { parseClaimRef } from '../core/claims.js';
import { capabilityCoverage, selectCapabilityTests, type CoverageEvidence } from '../core/coverage.js';
import { parseUnifiedDiff, type ChangedFile } from '../core/diff-lines.js';
import { parsePorcelain } from '../core/git-scope.js';
import { listHistory } from '../core/history.js';
import type { IntentGap } from '../core/intent-gap.js';
import { buildTestKeyIndex, resolveMutationPolicy, scoreMutation, type ClaimMutationScore } from '../core/mutation.js';
import type { ClaimProof, LayerProof } from '../core/proof-ledger.js';
import { layersOf } from '../core/proof-ledger.js';
import {
  resolveProofPolicy,
  type CapabilityInput,
  type ClaimInput,
  type CapabilityMutationInput,
  type ExampleInput,
  type LayerEvidenceKind,
  type Origin,
  type StatementInput,
  type WeakeningInput,
} from '../core/proof-statement.js';
import { expandGlobs, readFile } from '../core/reader.js';
import { buildSpecGraph, type SpecNode } from '../core/spec-graph.js';
import { parseSpecContent } from '../core/spec-parser.js';
import { specsRootDir } from '../core/spec-key.js';
import { lintCapability, resolveTestabilityConfig, type CapabilityTestability, type ClaimTestability } from '../core/testability.js';
import {
  analyzeTestFile,
  applyResultStatus,
  claimStrength,
  diffTestFile,
  resolveStrengthConfig,
  type TestStrength,
  type TestStrengthConfig,
} from '../core/test-strength.js';
import { classifyTest, fileLayerComment, layerGlobIndex, requiredLayersFor, type EvidenceLayer, type TestLayer } from '../core/test-layers.js';
import type { TestStatus } from '../core/test-results.js';
import type { TraceModel, TraceNode } from '../core/trace.js';
import type { SpecGuardConfig } from '../core/types.js';
import { diffConfigPolicy, diffSpecPolicy, scanAddedSource, snapshotRewrites, type WeakeningFinding } from '../core/weakening.js';
import { readCoverageEvidence, hashFiles, gitHead } from './coverage-ingest.js';
import { readMutationEvidence, type MutationEvidence } from './mutation-ingest.js';
import { walkClaimVerdicts, type ClaimDetail } from './proof.js';

export interface StatementInputOpts {
  /** Turn every `proof.require*` gate on (`check --strict`). */
  strict?: boolean;
  /** Git ref to compare the working tree with: the statement is then in change mode. Without it no change is judged. */
  base?: string;
  /** Result of each test in the proving run, keyed `file::title`, when known. Nothing in the repo stores them today. */
  testStatuses?: ReadonlyMap<string, TestStatus>;
  /** Injected for determinism. Default: now. */
  generated?: string;
}

export interface AssembledStatementInput {
  input: StatementInput;
  /** Problems with the evidence that are worth saying and do not stop the statement (for example an unusable base ref). */
  warnings: string[];
}

const CONFIG_FILE = '.specguard/config.json';
const GIT_BUFFER = 64 * 1024 * 1024;

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_BUFFER });
  } catch {
    return undefined;
  }
}

/** A ref name git can resolve to a commit; anything that could be read as an option is refused. */
function resolveBase(root: string, base: string): string | undefined {
  if (!/^[\w][\w./@^~{}:+-]*$/.test(base)) return undefined;
  return git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])?.trim() || undefined;
}

const posix = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');
const localKey = (ref: string): string | undefined => {
  const p = parseClaimRef(ref);
  return p ? `${p.specKey}#${p.claimId}${p.exampleId ? `/${p.exampleId}` : ''}` : undefined;
};

interface AnalysedTest {
  strength: TestStrength;
  layer: TestLayer;
}

/** Everything read from the test files, once. */
interface TestEvidence {
  /** Per local claim key (`specKey#claim`, and `specKey#claim/row` for a row), the tests tagged to it. A row's tests also count for its claim. */
  byClaim: Map<string, AnalysedTest[]>;
  /** The tag index coverage selection hashes (every claim ref as written, with the test title beside it). */
  index: ClaimTestIndex;
  decls: Array<{ file: string; title: string; claims: string[] }>;
  sources: Map<string, string>;
}

async function readTests(config: SpecGuardConfig, root: string, files: string[], opts: StatementInputOpts): Promise<TestEvidence> {
  const baseCfg = resolveStrengthConfig(config.testStrength);
  // An app's `test.conditional` gates apply to that app's test files only.
  const perFile = new Map<string, TestStrengthConfig>();
  for (const app of config.apps) {
    if (!app.test?.conditional?.length) continue;
    const cfg = resolveStrengthConfig(config.testStrength, app.test);
    for (const abs of await expandGlobs([...(app.sources.tests ?? []), ...(app.extraTestSources ?? [])], root)) perFile.set(posix(root, abs), cfg);
  }
  const merged: Partial<Record<TestLayer, string[]>> = {};
  for (const app of config.apps) for (const [layer, globs] of Object.entries(app.test?.layers ?? {})) merged[layer as TestLayer] = [...(merged[layer as TestLayer] ?? []), ...(globs ?? [])];
  const configured = Object.keys(merged).length > 0 ? await layerGlobIndex(merged, root) : new Map<string, TestLayer>();

  const ev: TestEvidence = { byClaim: new Map(), index: new Map(), decls: [], sources: new Map() };
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V): void => void m.set(k, [...(m.get(k) ?? []), v]);
  for (const file of files) {
    let source: string;
    try {
      source = await readFile(path.join(root, file));
    } catch {
      continue;
    }
    ev.sources.set(file, source);
    for (const hit of scanSourceForClaimTags(source, file)) {
      const entry: ClaimTestEntry = { file, line: hit.line, title: hit.title, origin: 'source' };
      push(ev.index, hit.ref, entry);
    }
    const fileComment = fileLayerComment(source);
    for (const raw of analyzeTestFile(source, file, perFile.get(file) ?? baseCfg)) {
      const strength = applyResultStatus(raw, opts.testStatuses?.get(`${file}::${raw.test.title}`));
      const layer = classifyTest({ file, title: raw.test.title, fileComment, configured: configured.get(file) });
      ev.decls.push({ file, title: raw.test.title, claims: strength.claims });
      const keys = new Set<string>();
      for (const ref of strength.claims) {
        const p = parseClaimRef(ref);
        if (!p) continue;
        keys.add(`${p.specKey}#${p.claimId}`);
        if (p.exampleId) keys.add(`${p.specKey}#${p.claimId}/${p.exampleId}`);
      }
      for (const k of keys) push(ev.byClaim, k, { strength, layer });
    }
  }
  return ev;
}

// ---------------------------------------------------------------------------
// Change mode: the diff, and what the base says
// ---------------------------------------------------------------------------

interface BaseEvidence {
  ref: string;
  changed: ChangedFile[];
  show(rel: string): string | undefined;
}

function baseEvidence(root: string, base: string, warnings: string[]): BaseEvidence | undefined {
  const sha = resolveBase(root, base);
  if (!sha) {
    warnings.push(`base ref "${base}" does not resolve to a commit: no change was judged`);
    return undefined;
  }
  const diff = git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--find-renames', '--relative', sha, '--']);
  if (diff === undefined) {
    warnings.push(`git diff against ${base} failed: no change was judged`);
    return undefined;
  }
  return { ref: base, changed: parseUnifiedDiff(diff), show: (rel) => git(root, ['show', `${sha}:./${rel}`]) };
}

function weakeningOf(
  root: string,
  specsRoot: string,
  nodes: SpecNode[],
  base: BaseEvidence,
  tests: TestEvidence,
  strengthCfg: TestStrengthConfig,
  projectLayers: TestLayer[],
  liveClaims: Set<string>,
  currentConfig: unknown,
): WeakeningFinding[] {
  const out: WeakeningFinding[] = [];
  for (const n of nodes) {
    const rel = posix(root, n.spec.filePath);
    const was = base.show(rel);
    if (was === undefined) continue;
    out.push(...diffSpecPolicy(parseSpecContent(was, n.spec.filePath, specsRoot), n.spec, projectLayers));
  }
  const before = base.show(CONFIG_FILE);
  if (before !== undefined) {
    try {
      out.push(...diffConfigPolicy(JSON.parse(before), currentConfig));
    } catch {
      /* an unreadable config on either side is not a weakening we can name */
    }
  }
  const changed = new Set(base.changed.filter((c) => c.status !== 'added').map((c) => c.file));
  for (const [file, source] of tests.sources) {
    if (!changed.has(file)) continue;
    out.push(...diffTestFile(base.show(file), source, file, strengthCfg, liveClaims));
  }
  const isTest = (f: string): boolean => tests.sources.has(f);
  out.push(...scanAddedSource(base.changed, isTest), ...snapshotRewrites(base.changed));
  return out;
}

// ---------------------------------------------------------------------------
// Ledger evidence of one claim or example row
// ---------------------------------------------------------------------------

interface LedgerEvidence {
  proof: ClaimProof;
  layerEvidence: Partial<Record<string, LayerEvidenceKind>>;
  origins: Origin[];
  shas: string[];
}

function ledgerEvidence(detail: ClaimDetail | undefined, required: TestLayer[]): LedgerEvidence {
  if (!detail) return { proof: { verdict: 'unproven', layers: {}, missing: [...required], complete: false }, layerEvidence: {}, origins: [], shas: [] };
  const { record } = detail;
  const proof: ClaimProof = { verdict: detail.verdict, layers: detail.layers, missing: detail.missing, complete: detail.complete };
  const layerEvidence: Partial<Record<string, LayerEvidenceKind>> = {};
  const origins = new Set<Origin>();
  const shas = new Set<string>();
  if (record) {
    for (const [layer, row] of Object.entries(layersOf(record)) as Array<[EvidenceLayer, LayerProof]>) {
      layerEvidence[layer] = row.evidence ?? 'test';
      const effective = detail.layers[layer];
      if (effective === undefined || effective === 'stale') continue;
      // A row written before provenance was recorded is read as local, as everywhere else.
      origins.add(row.origin ?? 'local');
      if (row.repoSha) shas.add(row.repoSha);
    }
  }
  return { proof, layerEvidence, origins: [...origins].sort(), shas: [...shas].sort() };
}

const exampleStrength = (tests: AnalysedTest[] | undefined): ExampleInput['strength'] => {
  if (!tests || tests.length === 0) return undefined;
  if (tests.some((t) => t.strength.class === 'strong')) return 'meaningful';
  return tests.every((t) => t.strength.class === 'unknown') ? 'unknown' : 'not-meaningful';
};

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * The statement's input for every capability and component of the repo. `model` and `gaps` come from the
 * trace `check` has just built, so ownership and the test list are not computed twice.
 */
export async function buildStatementInput(
  config: SpecGuardConfig,
  ctx: { model: TraceModel; gaps?: IntentGap[] },
  opts: StatementInputOpts = {},
): Promise<AssembledStatementInput> {
  const root = config.rootDir ?? process.cwd();
  const warnings: string[] = [];
  const policy = resolveProofPolicy({ proof: config.proof, mutation: config.mutation }, opts.strict ? { strict: true } : undefined);
  const traceNodes = ctx.model.nodes.filter((n): n is TraceNode => n.kind === 'capability' || n.kind === 'component');
  const graph = await buildSpecGraph(config);
  const specNodes = new Map<string, SpecNode>();
  for (const n of graph.nodes.values()) if (n.kind === 'capability' || n.kind === 'component') specNodes.set(n.specKey, n);

  // Approvals.
  const approvalList = approvalsFrom(listHistory(config));
  const approvals = indexApprovals(approvalList);

  // Ledger, judged by hashes alone.
  const ledger = new Map<string, ClaimDetail>();
  await walkClaimVerdicts(
    config,
    (ref, _verdict, detail) => {
      const key = localKey(ref);
      if (key && detail) ledger.set(key, detail);
    },
    { deterministic: true },
  );

  // Test files, once.
  const testFiles = [...new Set(traceNodes.flatMap((n) => n.tests))].sort();
  const tests = await readTests(config, root, testFiles, opts);

  // Change mode.
  const base = opts.base ? baseEvidence(root, opts.base, warnings) : undefined;
  const projectLayers = config.proof?.requiredLayers ?? [];
  const liveClaims = new Set(traceNodes.flatMap((n) => n.claims.map((c) => c.ref)));
  let currentConfig: unknown;
  try {
    currentConfig = JSON.parse(await readFile(path.join(root, CONFIG_FILE)));
  } catch {
    currentConfig = {};
  }
  const weakening: WeakeningFinding[] = base
    ? weakeningOf(root, specsRootDir(config), [...specNodes.values()], base, tests, resolveStrengthConfig(config.testStrength), projectLayers, liveClaims, currentConfig)
    : [];
  const configWeakened = weakening.some((w) => w.file === CONFIG_FILE);

  // Evidence ingested from outside: read only when present.
  const suiteCoverage = new Map<string, CoverageEvidence | undefined>();
  const coverageOf = async (id: string): Promise<CoverageEvidence | undefined> => {
    const own = await readCoverageEvidence(root, id);
    if (own) return own;
    if (!suiteCoverage.has('suite')) suiteCoverage.set('suite', await readCoverageEvidence(root));
    return suiteCoverage.get('suite');
  };
  const mutationEvidence: MutationEvidence | undefined = await readMutationEvidence(root);
  const testKeys = mutationEvidence ? buildTestKeyIndex(tests.decls) : undefined;

  const testabilityCfg = resolveTestabilityConfig(config.testability);
  const gapOf = new Map((ctx.gaps ?? []).map((g) => [g.id, g]));
  const capabilities: CapabilityInput[] = [];

  for (const node of traceNodes) {
    const sn = specNodes.get(node.specKey);
    if (!sn) continue;
    const spec = sn.spec;
    const specFile = posix(root, spec.filePath);
    const lint: CapabilityTestability = lintCapability(spec, testabilityCfg, projectLayers);
    const lintOf = new Map<string, ClaimTestability>(lint.claims.map((c) => [c.ref, c]));
    const baseSpec = base ? base.show(specFile) : undefined;
    const baseParsed = baseSpec !== undefined ? parseSpecContent(baseSpec, spec.filePath, path.join(root, 'specs')) : undefined;

    const claims: ClaimInput[] = [];
    for (const c of spec.claims) {
      if (!c.id) continue;
      const id = c.id;
      const ref = `${node.specKey}#${id}`;
      const claimHash = claimHashOf(spec, id);
      if (!claimHash) continue;
      const required = requiredLayersFor(id, spec.meta.layers, projectLayers);
      const rowTests = (c.examples?.rows ?? []).map((r) => ({ row: r, tests: tests.byClaim.get(`${ref}/${r.id}`) }));
      const taggedTests = tests.byClaim.get(ref) ?? [];
      const own = ledgerEvidence(ledger.get(ref), required);
      const declared = spec.meta.evidence?.[id];

      let change: ClaimInput['change'];
      if (base) {
        const was = baseParsed?.claims.find((b) => b.id === id);
        const rowsOf = (cl: typeof c | undefined): string => JSON.stringify((cl?.examples?.rows ?? []).map((r) => [r.id, r.hash]));
        if (!baseParsed || !was) change = 'added';
        else change = claimHashOf(baseParsed, id) !== claimHash || rowsOf(was) !== rowsOf(c) ? 'modified' : 'unchanged';
      }

      const approval = approvals.find(ref, claimHash);
      const latest = approvals.latest(ref);
      const examples: ExampleInput[] = rowTests.map(({ row, tests: rt }) => {
        const rowRef = `${ref}/${row.id}`;
        const ex = ledgerEvidence(ledger.get(rowRef), required);
        return {
          ref: rowRef,
          id: row.id,
          hash: row.hash,
          ...(approvals.find(rowRef, row.hash) ? { approval: approvals.find(rowRef, row.hash) } : {}),
          proof: ex.proof.verdict,
          proofOrigins: ex.origins,
          ...(exampleStrength(rt) ? { strength: exampleStrength(rt) } : {}),
        };
      });

      claims.push({
        ref,
        id,
        text: c.text,
        claimHash,
        ...(approval ? { approval } : {}),
        ...(!approval && latest ? { lastApprovedHash: latest.hash } : {}),
        ...(change ? { change } : {}),
        required,
        assurance: spec.meta.assurance?.claims[id] ?? spec.meta.assurance?.default ?? 'tested',
        evidence: declared?.kind ?? 'test',
        ...(declared?.verifier ? { verifier: declared.verifier } : {}),
        proof: own.proof,
        layerEvidence: own.layerEvidence,
        proofOrigins: own.origins,
        proofShas: own.shas,
        testability: lintOf.get(ref) ?? { ref, testable: true, findings: [] },
        strength: claimStrength(ref, taggedTests, required),
        examples,
      });
    }

    // Coverage, scoped to the capability's tests when that evidence exists.
    const ownedFiles = node.ownedFiles;
    const cov = await coverageOf(node.id);
    let coverage: CapabilityInput['coverage'];
    if (cov) {
      const claimRefs = [...tests.index.keys()].filter((k) => {
        const p = parseClaimRef(k);
        return p !== null && p.specKey === node.specKey && claims.some((cl) => cl.id === p.claimId);
      });
      coverage = capabilityCoverage({
        capability: node.id,
        ownedFiles,
        evidence: cov,
        currentHashes: hashFiles(root, ownedFiles),
        ...(base ? { changed: base.changed } : {}),
        currentTestsHash: selectCapabilityTests(claimRefs, tests.index).testsHash,
      });
    }

    // Mutation, scored from the owned code and the tests tagged to each claim.
    let mutation: CapabilityMutationInput | undefined;
    if (mutationEvidence && testKeys) {
      const claimTests = new Map<string, Set<string>>();
      for (const cl of claims) {
        for (const key of [cl.ref, ...cl.examples.map((e) => e.ref)]) {
          const set = new Set<string>();
          for (const t of tests.byClaim.get(key) ?? []) set.add(`${t.strength.test.file}::${t.strength.test.title}`);
          claimTests.set(key, set);
        }
      }
      const scored = scoreMutation({
        report: mutationEvidence.report,
        capability: node.id,
        ownedFiles,
        ...(base ? { changed: base.changed } : {}),
        claimTests,
        keys: testKeys,
        currentHashes: hashFiles(root, ownedFiles),
        policy: resolveMutationPolicy({ minScore: policy.mutation.minScore, minKilled: policy.mutation.minKilled, timeoutAsKilled: policy.mutation.timeoutAsKilled }),
      });
      const byRef = new Map<string, ClaimMutationScore>(scored.claims.map((s) => [s.ref, s]));
      for (const cl of claims) {
        const s = byRef.get(cl.ref);
        if (s) cl.mutation = s;
      }
      mutation = { score: scored.capability.score, origin: mutationEvidence.origin, tool: mutationEvidence.report.tool };
    }

    const inputs = [...new Set([specFile, ...node.tests, ...ownedFiles, ...(configWeakened ? [CONFIG_FILE] : [])])].sort();
    capabilities.push({
      id: node.id,
      specKey: node.specKey,
      title: node.title,
      status: node.status,
      inputs,
      ownedFiles,
      claims,
      testability: lint,
      ...(coverage ? { coverage } : {}),
      ...(mutation ? { mutation } : {}),
      weakening: weakening as WeakeningInput[],
      approvalsInUse: approvalList.length > 0,
      ...(gapOf.get(node.id) ? { intentGap: { codeDate: gapOf.get(node.id)!.codeDate, intentDate: gapOf.get(node.id)!.intentDate } } : {}),
      changeMode: base !== undefined,
    });
  }

  // The commit and the uncommitted files that matter to some capability.
  const sha = gitHead(root);
  let dirty: string[] = [];
  if (sha !== undefined) {
    const matter = new Set(capabilities.flatMap((c) => c.inputs));
    const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
    dirty = status === undefined ? [] : [...new Set(parsePorcelain(status).filter((f) => matter.has(f)))].sort();
  }

  return {
    input: {
      generated: opts.generated ?? new Date().toISOString(),
      head: { ...(sha !== undefined ? { sha } : {}), dirty, ...(base ? { base: base.ref } : {}) },
      policy,
      unowned: ctx.model.unowned,
      capabilities,
    },
    warnings,
  };
}
