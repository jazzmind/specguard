/**
 * `specguard publish`: build a snapshot of this project at this commit, for a team server.
 *
 * It reads the spec and history files, the trace model, the proof rows and the newest remediation plan, redacts
 * credentials from every file, and writes one JSON file. Working-tree source code and uncaptured prompts are
 * never included.
 *
 * Spec: specs/capabilities/team-server.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { SpecGuardClient, ServerRequestError, serverTarget } from '../client/index.js';
import { HASH_VERSION } from '../core/claim-hash.js';
import { loadContractGraph } from '../core/contracts.js';
import { ExitCode } from '../core/exit-codes.js';
import { detectProvenance } from '../core/provenance.js';
import { createSecretRedactor } from '../core/redact.js';
import { SNAPSHOT_VERSION, MAX_SNAPSHOT_BYTES, parseSnapshot, type Snapshot } from '../core/snapshot.js';
import { specsRootDir } from '../core/spec-key.js';
import { fileLedgerStore } from '../core/state/ledger-store.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { cliVersion } from '../core/version.js';
import { writeFile } from '../core/writer.js';
import { loadTrace } from './check.js';
import { ledgerPath } from './proof.js';
import { loadEffectiveLedger, proofSourceKind, readOnlyStore } from './proof-sources.js';
import { readPlan } from './security-plan.js';

export const DEFAULT_SNAPSHOT_FILE = '.specguard/publish/snapshot.json';

export interface PublishOpts {
  /** Where to write the snapshot. Default `.specguard/publish/snapshot.json`. */
  out?: string;
  /** Project name on the server. Default: `server.project` from config, else the repository name, else the directory name. */
  project?: string;
  /** Also send the snapshot to the project's team server. A refusal or an unreachable server fails the command. */
  push?: boolean;
  /** Server to push to, overriding config and `SPECGUARD_SERVER`. */
  server?: string;
  /** Token for the push, overriding `SPECGUARD_TOKEN` and a saved login. */
  token?: string;
}

const posix = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

/** Markdown under `dir`, skipping the v1 archive and anything hidden. */
function markdownUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '_archive' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

export async function buildSnapshot(config: SpecGuardConfig, opts: PublishOpts = {}): Promise<Snapshot> {
  const root = config.rootDir ?? process.cwd();
  const redact = createSecretRedactor();
  const provenance = detectProvenance(root);
  const specsDir = specsRootDir(config);

  const files: Record<string, string> = {};
  for (const file of markdownUnder(specsDir)) files[posix(root, file)] = redact.text(fs.readFileSync(file, 'utf8'));

  // With a CI proof note the snapshot carries the effective ledger (note rows plus local ones); without one, the local file as before.
  const effective = await loadEffectiveLedger(config).catch(() => undefined);
  const store = effective?.note ? readOnlyStore(effective) : undefined;
  const { model } = await loadTrace(config, store ? { store } : {});
  const ledger = effective?.note ? effective.ledger : await fileLedgerStore(ledgerPath(root, config.paths?.proofLedger)).read();
  const plan = readPlan(config, 'latest');
  const contracts = await loadContractGraph(root).catch(() => null);

  const project = opts.project ?? config.server?.project ?? provenance.repo?.split('/')[1] ?? path.basename(root);
  return {
    version: SNAPSHOT_VERSION,
    project,
    ...(provenance.repo ? { repo: provenance.repo } : {}),
    ...(provenance.branch ? { branch: provenance.branch } : {}),
    ...(provenance.commit ? { commit: provenance.commit } : {}),
    createdAt: new Date().toISOString(),
    engineVersion: cliVersion(),
    hashVersion: HASH_VERSION,
    origin: provenance.origin,
    specsRoot: posix(root, specsDir) || 'specs',
    files,
    trace: model as unknown as Snapshot['trace'],
    ledger: ledger.proofs as unknown as Snapshot['ledger'],
    ...(effective?.note ? { proofSource: { kind: proofSourceKind(effective), noteCommit: effective.note.commit, verified: effective.note.verified } } : { proofSource: { kind: 'local' as const } }),
    plans: plan ? [plan as Snapshot['plans'][number]] : [],
    ...(contracts ? { contracts: contracts as unknown as Snapshot['contracts'] } : {}),
  };
}

export async function runPublish(config: SpecGuardConfig, opts: PublishOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('publish');
  const root = config.rootDir ?? process.cwd();
  const snapshot = await buildSnapshot(config, opts);
  const text = `${JSON.stringify(snapshot)}\n`;

  // What is written must be what a server will accept.
  const check = parseSnapshot(text);
  if (!check.ok) {
    result.failed = 1;
    result.exitCode = ExitCode.ValidationFailed;
    result.messages.push(`the snapshot would be rejected by a server: ${check.error}`);
    return result;
  }
  if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) {
    result.failed = 1;
    result.exitCode = ExitCode.ValidationFailed;
    result.messages.push(`snapshot is ${Buffer.byteLength(text)} bytes; servers accept up to ${MAX_SNAPSHOT_BYTES}`);
    return result;
  }

  const out = path.resolve(root, opts.out ?? DEFAULT_SNAPSHOT_FILE);
  await writeFile(out, text);
  if (opts.push || opts.server) {
    const target = serverTarget(config, { ...process.env, ...(opts.server ? { SPECGUARD_SERVER: opts.server } : {}), ...(opts.token ? { SPECGUARD_TOKEN: opts.token } : {}), SPECGUARD_PROJECT: snapshot.project });
    if (!target) {
      result.failed = 1;
      result.exitCode = ExitCode.ValidationFailed;
      result.messages.push('--push needs a server: set "server.url" in .specguard/config.json, SPECGUARD_SERVER, or --server');
      return result;
    }
    try {
      const sent = await new SpecGuardClient(target).request<{ snapshotId: string }>('POST', new SpecGuardClient(target).projectPath('/snapshots'), { body: JSON.parse(text), timeoutMs: 60_000 });
      result.messages.push(`pushed to ${target.url} as project ${target.project} (snapshot ${sent.snapshotId})`);
    } catch (err) {
      result.failed = 1;
      result.exitCode = ExitCode.InternalError;
      result.messages.push(err instanceof ServerRequestError ? `the server refused the snapshot (${err.status}): ${err.message}` : `could not push to ${target.url}: ${(err as Error).message}`);
      return result;
    }
  }
  result.created = 1;
  result.messages.push(
    `snapshot of ${snapshot.project}${snapshot.commit ? ` @ ${snapshot.commit.slice(0, 8)}` : ''}${snapshot.branch ? ` (${snapshot.branch})` : ''}: ` +
      `${Object.keys(snapshot.files).length} spec/history file(s), ${snapshot.trace.nodes.length} spec(s), ${Object.keys(snapshot.ledger).length} proof row(s), ${snapshot.plans.length} plan(s)`,
  );
  result.messages.push(`written to ${path.relative(root, out) || out} (${Buffer.byteLength(text)} bytes, origin ${snapshot.origin})`);
  return result;
}
