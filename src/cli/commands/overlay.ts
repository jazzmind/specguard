/**
 * `specguard overlay add|list|remove|refresh|resolve`: specs kept in a separate "overlay" repository.
 *
 * An overlay holds the SpecGuard config, specs and results of one or more application repositories, so nothing is
 * written into them. These commands manage the per-user registry (`overlays.json`, the only file `add` and `refresh`
 * write) and answer which config a directory resolves to. The scanning, matching and resolving live in
 * `src/core/overlay.ts`; this file is wiring and output.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { Command } from 'commander';

import { ConfigAmbiguousError, ConfigInvalidError } from '../../core/errors.js';
import {
  CONFIG_ENV,
  OVERLAY_ENV,
  OVERLAY_SCAN_DEPTH,
  describeResolution,
  distinctConfigs,
  dropOverlay,
  enclosingGitRoot,
  parseOverlayRoots,
  readOverlayRegistry,
  realPathLoose,
  resolveConfigDirDetailed,
  scanOverlay,
  upsertOverlay,
  writeOverlayRegistry,
  type ConfigResolution,
  type OverlayEntry,
  type OverlayRecord,
  type OverlayScan,
} from '../../core/overlay.js';
import type { GlobalOpts } from './helpers.js';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const err = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

const globalsOf = (cmd: Command): GlobalOpts => {
  const g = cmd.optsWithGlobals() as GlobalOpts;
  return { config: g.config, json: g.json };
};

/** The entry's config path relative to the overlay root, for output. */
const relConfig = (root: string, config: string): string => path.relative(root, config).split(path.sep).join('/') || config;

/** `  (git root <dir>)` when the git repository that holds the entry's folder is a different, enclosing folder. */
function gitRootNote(repo: string): string {
  const root = enclosingGitRoot(repo);
  return root !== null && root !== repo ? `  (git root ${root})` : '';
}

function printScan(scan: OverlayScan): void {
  for (const e of scan.entries) out(`  ${e.app.padEnd(16)} ${e.repo}${gitRootNote(e.repo)}  <-  ${relConfig(scan.root, e.config)}`);
  for (const s of scan.skipped) out(`  skipped  ${relConfig(scan.root, s.config)}${s.app ? ` (app ${s.app})` : ''}: ${s.reason}`);
}

/** Repositories that two or more distinct configs of the given overlays name: SpecGuard would refuse to pick one. */
function ambiguousRepos(overlays: OverlayRecord[]): Array<{ repo: string; configs: string[] }> {
  const byRepo = new Map<string, OverlayEntry[]>();
  for (const o of overlays) for (const e of o.entries) byRepo.set(e.repo, [...(byRepo.get(e.repo) ?? []), e]);
  return [...byRepo.entries()]
    .map(([repo, entries]) => ({ repo, configs: distinctConfigs(entries).map((e) => e.config) }))
    .filter((r) => r.configs.length > 1);
}

function warnAmbiguity(overlays: OverlayRecord[]): void {
  for (const a of ambiguousRepos(overlays)) {
    err(`warning: ${a.repo} is named by more than one overlay config (${a.configs.join(', ')}); commands there will refuse to guess: pick one with --config or ${CONFIG_ENV}`);
  }
}

function overlayAdd(dir: string, globals: GlobalOpts): void {
  const abs = path.resolve(dir);
  if (!existsSync(abs)) {
    err(`${abs} does not exist`);
    process.exitCode = 1;
    return;
  }
  const scan = scanOverlay(abs);
  if (scan.entries.length === 0) {
    const why = scan.skipped.length > 0 ? ` Every config it found was skipped:\n${scan.skipped.map((s) => `  ${relConfig(scan.root, s.config)}${s.app ? ` (app ${s.app})` : ''}: ${s.reason}`).join('\n')}` : ` No .specguard/config.json within ${OVERLAY_SCAN_DEPTH} levels of it.`;
    err(`Not an overlay: ${scan.root} has no config that points at another repository.${why}`);
    process.exitCode = 1;
    return;
  }
  const { registry } = readOverlayRegistry();
  const record: OverlayRecord = { root: scan.root, addedAt: registry.overlays.find((o) => o.root === scan.root)?.addedAt || new Date().toISOString(), entries: scan.entries };
  const next = upsertOverlay(registry, record);
  const file = writeOverlayRegistry(next);
  if (globals.json) {
    out(JSON.stringify({ root: scan.root, registry: file, entries: scan.entries, skipped: scan.skipped }));
  } else {
    out(`overlay ${scan.root}: ${scan.entries.length} repo(s) covered`);
    printScan(scan);
    out(`registered in ${file}. Nothing was written into the application repos.`);
  }
  warnAmbiguity(next.overlays);
}

function overlayList(globals: GlobalOpts): void {
  const { file, registry, problem } = readOverlayRegistry();
  const stale = (e: OverlayEntry): boolean => !existsSync(e.config);
  const envRoots = parseOverlayRoots(process.env[OVERLAY_ENV]);
  const envScans = envRoots.map(scanOverlay);
  if (globals.json) {
    out(JSON.stringify({
      registry: file ?? null,
      ...(problem ? { problem } : {}),
      overlays: registry.overlays.map((o) => ({ ...o, entries: o.entries.map((e) => ({ ...e, stale: stale(e) })) })),
      env: envScans.map((s) => ({ root: s.root, entries: s.entries, skipped: s.skipped })),
    }));
    return;
  }
  if (problem) err(`warning: ${problem}`);
  if (registry.overlays.length === 0 && envScans.length === 0) {
    out(`no overlays registered${file ? ` (${file})` : ''}. Register one with: specguard overlay add <dir>`);
    return;
  }
  for (const o of registry.overlays) {
    out(`${o.root}  (added ${o.addedAt || 'unknown'})`);
    for (const e of o.entries) out(`  ${e.app.padEnd(16)} ${e.repo}${gitRootNote(e.repo)}  <-  ${relConfig(o.root, e.config)}${stale(e) ? '  [stale: config is gone, run overlay refresh]' : ''}`);
  }
  for (const s of envScans) {
    out(`${s.root}  (from ${OVERLAY_ENV})`);
    printScan(s);
  }
}

function overlayRemove(dir: string, globals: GlobalOpts): void {
  const { registry } = readOverlayRegistry();
  const candidates = new Set([path.resolve(dir), realPathLoose(dir)]);
  const target = registry.overlays.find((o) => candidates.has(o.root) || candidates.has(realPathLoose(o.root)));
  if (!target) {
    err(`${path.resolve(dir)} is not a registered overlay (see: specguard overlay list)`);
    process.exitCode = 1;
    return;
  }
  const { registry: next } = dropOverlay(registry, target.root);
  const file = writeOverlayRegistry(next);
  if (globals.json) out(JSON.stringify({ removed: target.root, registry: file }));
  else out(`removed ${target.root} from ${file}. Its files were not touched.`);
}

function overlayRefresh(dir: string | undefined, globals: GlobalOpts): void {
  const { registry } = readOverlayRegistry();
  const wanted = dir ? [path.resolve(dir), realPathLoose(dir)] : undefined;
  const targets = registry.overlays.filter((o) => !wanted || wanted.includes(o.root) || wanted.includes(realPathLoose(o.root)));
  if (targets.length === 0) {
    err(dir ? `${path.resolve(dir)} is not a registered overlay (see: specguard overlay list)` : 'no overlays registered');
    process.exitCode = 1;
    return;
  }
  let next = registry;
  const report: Array<{ root: string; added: string[]; removed: string[]; skipped: OverlayScan['skipped']; missing?: true }> = [];
  for (const o of targets) {
    if (!existsSync(o.root)) {
      report.push({ root: o.root, added: [], removed: [], skipped: [], missing: true });
      continue;
    }
    const scan = scanOverlay(o.root);
    const key = (e: OverlayEntry): string => `${e.repo} <- ${e.config}`;
    const before = new Set(o.entries.map(key));
    const after = new Set(scan.entries.map(key));
    report.push({ root: o.root, added: [...after].filter((k) => !before.has(k)), removed: [...before].filter((k) => !after.has(k)), skipped: scan.skipped });
    next = upsertOverlay(next, { root: o.root, addedAt: o.addedAt, entries: scan.entries });
  }
  const file = writeOverlayRegistry(next);
  if (globals.json) {
    out(JSON.stringify({ registry: file, overlays: report }));
  } else {
    for (const r of report) {
      if (r.missing) {
        out(`${r.root}: the directory is gone; left as it was (remove it with: specguard overlay remove ${r.root})`);
        continue;
      }
      out(`${r.root}: ${r.added.length} added, ${r.removed.length} removed`);
      for (const a of r.added) out(`  + ${a}`);
      for (const x of r.removed) out(`  - ${x}`);
      for (const s of r.skipped) out(`  skipped  ${relConfig(r.root, s.config)}${s.app ? ` (app ${s.app})` : ''}: ${s.reason}`);
    }
  }
  warnAmbiguity(next.overlays);
}

function overlayResolve(dir: string | undefined, globals: GlobalOpts): void {
  const start = path.resolve(dir ?? process.cwd());
  let body: Record<string, unknown>;
  let resolution: ConfigResolution | undefined;
  try {
    const detail = resolveConfigDirDetailed(start);
    const r = detail.resolved;
    if (r) {
      resolution = r;
      body = { dir: start, configured: true, via: r.via, configDir: r.dir, config: path.join(r.dir, '.specguard', 'config.json'), ...(r.overlayRoot ? { overlayRoot: r.overlayRoot } : {}), ...(r.repo ? { repo: r.repo } : {}), ...(r.app ? { app: r.app } : {}), ...(detail.gitRoot ? { gitRoot: detail.gitRoot } : {}), warnings: detail.warnings };
    } else {
      const why = detail.overlaysKnown
        ? 'it has no .specguard/config.json of its own and no registered overlay (or SPECGUARD_OVERLAY root) names a repository containing it'
        : `it has no .specguard/config.json of its own, and no overlay is registered (specguard overlay add <dir>) or named by ${OVERLAY_ENV}`;
      body = { dir: start, configured: false, reason: why, warnings: detail.warnings };
    }
  } catch (e) {
    if (!(e instanceof ConfigAmbiguousError) && !(e instanceof ConfigInvalidError)) throw e;
    body = { dir: start, configured: false, reason: e.message, ...(e instanceof ConfigAmbiguousError ? { ambiguous: true, candidates: e.candidates } : {}), warnings: [] };
  }
  const ok = body.configured === true;
  if (globals.json) out(JSON.stringify(body));
  else if (ok) {
    out(`${start}: ${describeResolution(resolution) || `its own config (${String(body.configDir)})`}`);
    out(`  config: ${String(body.config)}`);
    if (body.repo) out(`  repo:   ${String(body.repo)}${body.gitRoot ? ` (covers the git repository ${String(body.gitRoot)})` : ''}`);
    for (const w of body.warnings as string[]) err(`warning: ${w}`);
  } else {
    out(`${start}: not configured, ${String(body.reason)}`);
    for (const w of body.warnings as string[]) err(`warning: ${w}`);
  }
  // 0 when a config was found, 1 when not (the JSON says why): shell callers can branch on the status alone.
  process.exitCode = ok ? 0 : 1;
}

export function registerOverlayCommands(program: Command): void {
  const overlay = program
    .command('overlay')
    .description('specs kept in a separate repository (an overlay): register one, list them, and see what a directory resolves to');

  overlay
    .command('add')
    .description('scan an overlay directory, show the repos it covers and what it skipped, and register it (writes only the per-user registry)')
    .argument('<dir>', 'the overlay repository (it holds one .specguard/config.json per application)')
    .action((dir: string, _opts: Record<string, never>, cmd: Command) => overlayAdd(dir, globalsOf(cmd)));

  overlay
    .command('list')
    .description('the registered overlays, the repos each covers, and any stale entries')
    .action((_opts: Record<string, never>, cmd: Command) => overlayList(globalsOf(cmd)));

  overlay
    .command('remove')
    .description('forget a registered overlay (its files are not touched)')
    .argument('<dir>', 'the overlay directory')
    .action((dir: string, _opts: Record<string, never>, cmd: Command) => overlayRemove(dir, globalsOf(cmd)));

  overlay
    .command('refresh')
    .description('rescan registered overlays (all, or one) after configs were added, moved or deleted')
    .argument('[dir]', 'one overlay directory (default: every registered overlay)')
    .action((dir: string | undefined, _opts: Record<string, never>, cmd: Command) => overlayRefresh(dir, globalsOf(cmd)));

  overlay
    .command('resolve')
    .description('which config, overlay and app a directory resolves to, or why none; read-only. Exit 0 when configured, 1 when not')
    .argument('[dir]', 'the directory (default: the current one)')
    .action((dir: string | undefined, _opts: Record<string, never>, cmd: Command) => overlayResolve(dir, globalsOf(cmd)));
}
