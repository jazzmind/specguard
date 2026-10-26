/**
 * `specguard change red <id>` and `change green <id>`: run exactly the tests tagged to the change's requirements and
 * leave the evidence the stage detection reads.
 *
 * Both are thin wrappers over `test run --claims <refs> --record <changeId>-red|green`. What a run proves is read
 * from the run record the runner's report produced, never from anything the command says about itself: a small
 * pointer (`.specguard/cache/changes/<id>/red.json`) only names that record and the hashes of the spec, tests and
 * owned code the run saw, and `change status` re-judges them against the files as they are now.
 *
 * Red must run against the base's owned code. With no owned code differing from base that is the working tree. Once
 * code exists, the tests run in a constructed tree: a detached worktree of HEAD holding the current specs and tests
 * and the owned files as they were at base (new owned files removed). The user's working tree is not touched. A red
 * run never ingests its verdicts into the proof ledger: failing results against old code would pollute it.
 *
 * Local red is provisional: CI re-derives it by construction and never reads these records.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { judgeGreen, judgeRed, requiredRefs, type StageBlock, type StageBlockCode } from '../core/change-stage.js';
import { loadConfig } from '../core/config.js';
import { hashFile } from '../core/drift-registry.js';
import { ExitCode } from '../core/exit-codes.js';
import { emptyResult, type PipelineResult, type SpecGuardConfig } from '../core/types.js';
import { writeFile } from '../core/writer.js';
import { openRepo, posixRel, selectOneChange, statusLines, statusOf, treeHash, type ChangeFacts, type RepoView } from './change.js';
import { gitOut, writePointer, type RunKind } from './change-store.js';
import { runTestRun } from './test-run.js';

export interface ChangeRunOpts {
  id?: string;
  base?: string;
}

const LOCK_CODES: ReadonlySet<StageBlockCode> = new Set(['RED_INVALID_TESTS_EDITED', 'RED_INVALID_SPEC_EDITED']);
const CONFIG_FILE = '.specguard/config.json';
const GIT_PATHS_PER_CALL = 200;

function fail(result: PipelineResult, message: string, exitCode: number = ExitCode.InternalError): PipelineResult {
  result.failed += 1;
  result.exitCode = exitCode;
  result.messages.push(message);
  return result;
}

const blockLines = (blocks: StageBlock[]): string[] => blocks.flatMap((b) => [`  [${b.code}] ${b.message}`, `      fix: ${b.fix}`]);

function copyInto(fromRoot: string, toRoot: string, rel: string): void {
  const from = path.join(fromRoot, rel);
  if (!existsSync(from)) return;
  mkdirSync(path.dirname(path.join(toRoot, rel)), { recursive: true });
  copyFileSync(from, path.join(toRoot, rel));
}

/** Dependency directories linked into the constructed tree so the tests can run there. */
function linkDependencies(config: SpecGuardConfig, root: string, tmpRoot: string): void {
  for (const name of config.change?.worktreeLinks ?? ['node_modules', '.venv', 'vendor']) {
    const from = path.resolve(root, name);
    const to = path.resolve(tmpRoot, name);
    if (!to.startsWith(`${path.resolve(tmpRoot)}${path.sep}`) || !existsSync(from) || existsSync(to)) continue;
    mkdirSync(path.dirname(to), { recursive: true });
    symlinkSync(from, to, 'dir');
  }
}

/**
 * Run the tests in a constructed tree (owned code at base), copy the run record back, remove the tree. Returns the hash
 * of the owned files as the tests saw them, or an error.
 */
async function constructedRun(view: RepoView, facts: ChangeFacts, refs: string[], recordId: string, log: (line: string) => void): Promise<{ ok: true; run: PipelineResult; ownedHash: string } | { ok: false; error: string }> {
  const { root, config } = view;
  const prefix = gitOut(root, ['rev-parse', '--show-prefix'])?.trim() ?? '';
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specguard-red-'));
  const git = (cwd: string, args: string[]): void => void execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
  let added = false;
  try {
    try {
      git(root, ['worktree', 'add', '--detach', tmp, 'HEAD']);
      added = true;
    } catch (err) {
      return { ok: false, error: `could not build the constructed tree (git worktree add failed): ${(err as Error).message.split('\n')[0]}` };
    }
    const tmpRoot = path.join(tmp, prefix);

    // The current specs, tests and config, then the owned files as they were at base.
    for (const cap of facts.record.capabilities) {
      const node = view.graph.nodes.get(cap);
      if (node) copyInto(root, tmpRoot, posixRel(root, node.spec.filePath));
    }
    for (const file of view.sources.keys()) copyInto(root, tmpRoot, file);
    copyInto(root, tmpRoot, CONFIG_FILE);
    const { files, presentAtBase } = facts.owned;
    for (let i = 0; i < presentAtBase.length; i += GIT_PATHS_PER_CALL) git(tmpRoot, ['checkout', facts.base.sha, '--', ...presentAtBase.slice(i, i + GIT_PATHS_PER_CALL)]);
    for (const file of files) if (!presentAtBase.includes(file)) rmSync(path.join(tmpRoot, file), { force: true });
    linkDependencies(config, root, tmpRoot);

    const ownedHash = treeHash(files.map((f): [string, string | null] => [f, hashFile(path.join(tmpRoot, f))]));
    if (ownedHash !== facts.input.current.baseOwnedHash) return { ok: false, error: 'the constructed tree does not hold the owned code as it was at base; red was not recorded' };

    log(`[red] constructed tree: owned code at ${facts.base.sha.slice(0, 7)}, current specs and tests (${tmp})`);
    const run = await runTestRun(await loadConfig(tmpRoot), { claims: refs, record: recordId, ingest: false });
    const record = path.join(tmpRoot, '.specguard', 'runs', `${recordId}.json`);
    if (existsSync(record)) await writeFile(path.join(root, '.specguard', 'runs', `${recordId}.json`), readFileSync(record, 'utf8'));
    return { ok: true, run, ownedHash };
  } finally {
    if (added) {
      try {
        git(root, ['worktree', 'remove', '--force', tmp]);
      } catch {
        /* removed below */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
    try {
      git(root, ['worktree', 'prune']);
    } catch {
      /* nothing to prune */
    }
  }
}

async function runStage(config: SpecGuardConfig, kind: RunKind, opts: ChangeRunOpts): Promise<PipelineResult> {
  const result = emptyResult('change');
  const log = (line: string): void => void result.messages.push(line);
  const root = config.rootDir ?? process.cwd();
  const one = selectOneChange(root, opts.id);
  if (!one.ok) return fail(result, one.error);
  const record = one.record;
  if (record.closed) return fail(result, `change ${record.id} is closed (${record.closed.reason}): a closed record is never edited`);
  if (kind === 'red' && record.kind === 'refactor') return fail(result, `change ${record.id} is a refactor: no requirement changes, so there is nothing to see failing; run \`specguard change green ${record.id}\` when the code is done`, ExitCode.ValidationFailed);

  const view = await openRepo(config);
  const before = await statusOf(view, record, { base: opts.base });
  if (!before.ok) return fail(result, before.error);
  const { entry, facts } = before;
  const required = requiredRefs(facts.input.changed);

  // Red needs an approved spec and tagged tests; the stage-lock blocks are exactly what red is for. Green needs code and a valid red.
  if (kind === 'red') {
    const blocking = entry.stage === 'spec' ? entry.blocks : entry.stage === 'tests' ? entry.blocks.filter((b) => !LOCK_CODES.has(b.code)) : [];
    if (blocking.length > 0) {
      result.messages.push(...statusLines(entry));
      return fail(result, `change ${record.id} is not ready for red (stage ${entry.stage}): next ${entry.next}`, ExitCode.ValidationFailed);
    }
    if (required.length === 0) return fail(result, `change ${record.id} adds or modifies no requirement, so there is no test to see failing`, ExitCode.ValidationFailed);
  } else if (entry.stage !== 'green' && entry.stage !== 'validated') {
    result.messages.push(...statusLines(entry));
    return fail(result, `change ${record.id} is not ready for green (stage ${entry.stage}): next ${entry.next}`, ExitCode.ValidationFailed);
  }

  const refs = kind === 'red' ? required.map((c) => c.ref) : record.kind === 'refactor' || required.length === 0 ? facts.trackedRefs : required.map((c) => c.ref);
  if (refs.length === 0) return fail(result, `change ${record.id} has no requirement to run tests for`, ExitCode.ValidationFailed);
  const recordId = `${record.id}-${kind}`;
  const mode: 'working-tree' | 'constructed' = kind === 'red' && facts.input.codeFiles.length > 0 ? 'constructed' : 'working-tree';

  let run: PipelineResult;
  let ownedHash = facts.input.current.ownedHash;
  if (mode === 'constructed') {
    const built = await constructedRun(view, facts, refs, recordId, log);
    if (!built.ok) return fail(result, built.error);
    run = built.run;
    ownedHash = built.ownedHash;
  } else {
    // Red runs against the code as it stands (still base), so its failing verdicts stay out of the ledger.
    run = await runTestRun(config, { claims: refs, record: recordId, ingest: kind === 'green' });
  }
  for (const line of run.messages) log(line);
  if (!existsSync(path.join(root, '.specguard', 'runs', `${recordId}.json`))) return fail(result, `${kind} was not recorded: the run produced no record (see above)`, run.exitCode || ExitCode.ValidationFailed);

  await writePointer(root, {
    version: 1,
    changeId: record.id,
    kind,
    runRecord: recordId,
    mode,
    claimsHash: facts.input.current.claimsHash,
    testsHash: facts.input.current.testsHash,
    ownedHash,
    baseOwnedHash: facts.input.current.baseOwnedHash,
    at: new Date().toISOString(),
  });

  // Judge what was recorded, from the record, as `change status` will.
  const after = await statusOf(view, record, { base: opts.base });
  if (!after.ok) return fail(result, after.error);
  const verdict = kind === 'red' ? judgeRed(after.facts.input) : judgeGreen(after.facts.input);
  result.created = 1;
  if (verdict.state === 'valid') {
    result.items.push({ key: record.id, status: 'ok', message: `${kind} recorded` });
    log(kind === 'red'
      ? `red recorded for ${record.id} (${mode}): ${required.length} changed requirement(s) each have a failing test; next: ${after.entry.next}`
      : `green recorded for ${record.id}: the tagged tests pass; next: ${after.entry.next}`);
    return result;
  }
  result.items.push({ key: record.id, status: 'failed', message: `${kind} recorded but not ${kind === 'red' ? 'red' : 'green'}` });
  log(`${kind} was recorded for ${record.id}, but it does not hold:`);
  for (const line of blockLines(verdict.blocks)) log(line);
  result.failed = 1;
  result.exitCode = ExitCode.ValidationFailed;
  return result;
}

export const runChangeRed = (config: SpecGuardConfig, opts: ChangeRunOpts = {}): Promise<PipelineResult> => runStage(config, 'red', opts);
export const runChangeGreen = (config: SpecGuardConfig, opts: ChangeRunOpts = {}): Promise<PipelineResult> => runStage(config, 'green', opts);
