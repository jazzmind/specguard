/**
 * `specguard check --workspace`: the combined picture of every repo in a workspace.
 *
 * Reads what each repo has already recorded. With `--refresh` it first runs `check` in each
 * repo so the numbers are current; ignored repos are listed and never run.
 *
 * Spec: specs/capabilities/workspaces.md
 */
import path from 'node:path';

import { ExitCode } from '../../core/exit-codes.js';
import { loadConfig } from '../../core/config.js';
import { loadWorkspace, workspaceHint, type WorkspaceManifest } from '../../core/workspace.js';
import { ROLLUP_FILE, rollupManifest, type RepoRollup, type WorkspaceRollup } from '../../core/workspace-rollup.js';
import { writeFile } from '../../core/writer.js';
import { isV2Repo, runCheck } from '../../pipelines/check.js';

export interface WorkspaceCheckOpts {
  /** `--workspace [path]`; an empty string means "the manifest above the current directory". */
  workspace?: string | true;
  refresh?: boolean;
  json?: boolean;
  cwd?: string;
}

/** The worst exit code among the repos, in the order check itself uses. */
export function worstExit(codes: number[]): number {
  for (const c of [ExitCode.ValidationFailed, ExitCode.DriftDetected, ExitCode.MissingSpecs]) if (codes.includes(c)) return c;
  return ExitCode.Success;
}

/** Run `check` in every active repo; the result of each, by key. */
export async function refreshRepos(manifest: WorkspaceManifest, log: (line: string) => void): Promise<Record<string, number>> {
  const exits: Record<string, number> = {};
  for (const [key, repo] of Object.entries(manifest.repos)) {
    const abs = path.resolve(manifest.rootDir, repo.path);
    try {
      const config = await loadConfig(abs);
      if (!(await isV2Repo(config))) {
        log(`  ${key}: per-file specs (v1), not refreshed`);
        continue;
      }
      exits[key] = (await runCheck(config, {})).exitCode;
    } catch (err) {
      log(`  ${key}: not refreshed (${(err as Error).message.split('\n')[0]})`);
    }
  }
  return exits;
}

const cell = (v: string | number, w: number): string => String(v).padEnd(w);

function renderRow(r: RepoRollup): string {
  const c = r.coverage;
  if (r.ignored) return `  ${cell(r.key, 22)}ignored${r.ignoreReason ? ` (${r.ignoreReason})` : ''}`;
  if (r.state !== 'ok') return `  ${cell(r.key, 22)}${r.state === 'no-config' ? 'no SpecGuard config' : r.state === 'no-trace' ? 'no trace yet: run `specguard check` there' : 'unreadable state files'}`;
  const sev = r.security.open;
  const sec = r.security.total === 0 ? '-' : `${sev.critical}c ${sev.high}h ${sev.moderate}m ${sev.low}l`;
  return (
    `  ${cell(r.key, 22)}${cell(`${c.sourcePct}%`, 8)}${cell(`${c.proven}/${c.claims}`, 10)}${cell(c.failed, 7)}${cell(c.stale, 7)}` +
    `${cell(c.incomplete, 8)}${cell(sec, 14)}${cell(r.docs.stale.length, 6)}${r.intentGaps.length}${r.freshness.stale ? '  (lags the ledger)' : ''}`
  );
}

export function renderRollup(rollup: WorkspaceRollup): string[] {
  const t = rollup.totals;
  const lines = [
    `Workspace: ${rollup.workspace}  ·  ${t.repos} repos${t.ignored ? ` (+${t.ignored} ignored)` : ''}  ·  ${t.coverage.claims} claims, ${t.coverage.provenPct}% proven`,
    '',
    `  ${cell('Repo', 22)}${cell('Owned', 8)}${cell('Proven', 10)}${cell('Failed', 7)}${cell('Stale', 7)}${cell('Missing', 8)}${cell('Security', 14)}${cell('Docs', 6)}Gaps`,
    `  ${'─'.repeat(88)}`,
    ...rollup.repos.map(renderRow),
  ];
  const layers = Object.entries(t.layers).filter(([, v]) => v && v.required > 0);
  if (layers.length > 0) {
    lines.push('', 'LAYERS: ' + layers.map(([k, v]) => `${k} ${v!.proven}/${v!.required}`).join('  '));
  }
  return lines;
}

export async function workspaceCheckCommand(opts: WorkspaceCheckOpts): Promise<void> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const hint = workspaceHint(typeof opts.workspace === 'string' && opts.workspace !== '' ? opts.workspace : undefined);
  let manifest: WorkspaceManifest;
  try {
    manifest = await loadWorkspace(cwd, hint);
  } catch {
    process.stderr.write('[check --workspace] No workspace.json found. Run `specguard workspace init` first, or pass --workspace <path>.\n');
    process.exit(ExitCode.InternalError);
  }
  const notes: string[] = [];
  const exits = opts.refresh ? await refreshRepos(manifest, (l) => notes.push(l)) : {};
  const rollup = rollupManifest(manifest);
  await writeFile(path.join(manifest.rootDir, ROLLUP_FILE), JSON.stringify(rollup, null, 2) + '\n');

  if (opts.json) {
    process.stdout.write(JSON.stringify(rollup, null, 2) + '\n');
  } else {
    for (const l of [...notes, ...renderRollup(rollup)]) process.stdout.write(`${l}\n`);
  }

  // Refreshed repos report their own exit code; otherwise judge from what was recorded.
  const recorded = rollup.repos.filter((r) => !r.ignored).map((r) => (r.issues.errors > 0 ? ExitCode.ValidationFailed : r.coverage.unowned > 0 ? ExitCode.MissingSpecs : ExitCode.Success));
  process.exit(worstExit(opts.refresh ? Object.values(exits) : recorded));
}
