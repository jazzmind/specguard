#!/usr/bin/env node
/**
 * Gate runner for the SpecGuard GitHub Action.
 *
 * Runs the requested `specguard` gates, saves each JSON result under
 * `.specguard/ci/`, writes a job summary, and decides the exit code from
 * `fail-on`. The decision logic is exported so it can be unit tested.
 *
 * Environment (set by action.yml):
 *   SG_GATES       comma list: status, drift, proof, align, results, validate, security, deps
 *   SG_FAIL_ON     comma list: missing-specs, drift, proof-failed, proof-stale, proof-unexercised,
 *                  proof-unproven, align-below:<pct>, results, validate, security, deps, none
 *   SG_RESULTS     reporter files or globs for `results ingest`, comma or newline separated
 *   SG_RUN_ID      ledger run id for `results ingest`
 *   SG_DRIFT_SINCE git ref for `drift --since`
 *   SG_VALIDATE_URL base URL for `validate --all --url`
 *   SG_BIN         specguard binary (default: specguard)
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATES = ['status', 'drift', 'proof', 'align', 'results', 'validate', 'security', 'deps'];
export const DEFAULT_FAIL_ON = 'missing-specs,drift,proof-failed,proof-stale,results';

/** Exit codes the CLI uses (src/core/exit-codes.ts). */
const EXIT = { InternalError: 1, ValidationFailed: 2, DriftDetected: 3, MissingSpecs: 4, SecurityIssues: 5, HealFailed: 7, BudgetExceeded: 8 };

export function splitList(value) {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** `PROOFS: 3 proven, 1 failed, 0 error, 2 unexercised, 1 stale, 4 unproven` into counts. */
export function parseProofCounts(messages) {
  const line = (messages ?? []).find((m) => typeof m === 'string' && m.startsWith('PROOFS:'));
  const counts = { proven: 0, failed: 0, error: 0, unexercised: 0, stale: 0, unproven: 0, ledger: Boolean(line) };
  if (!line) return counts;
  for (const match of line.matchAll(/(\d+)\s+(proven|failed|error|unexercised|stale|unproven)/g)) {
    counts[match[2]] = Number(match[1]);
  }
  return counts;
}

/** Average alignment score from `.specguard/alignment.json`-shaped data, or null. */
export function averageAlignment(report) {
  const entries = report?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return Math.round(entries.reduce((sum, e) => sum + (Number(e.alignmentScore) || 0), 0) / entries.length);
}

/**
 * Decide which fail-on conditions tripped.
 * @param {Record<string, {exitCode:number, messages?:string[], ran:boolean, alignAverage?:number|null}>} runs
 * @param {string[]} failOn
 * @returns {{ tripped: string[], notes: string[] }}
 */
export function evaluate(runs, failOn) {
  const tripped = [];
  const notes = [];
  const rules = failOn.includes('none') ? [] : failOn;
  for (const rule of rules) {
    switch (rule) {
      case 'missing-specs':
        if (runs.status?.ran && runs.status.exitCode === EXIT.MissingSpecs) tripped.push(rule);
        break;
      case 'drift':
        if (runs.drift?.ran && runs.drift.exitCode === EXIT.DriftDetected) tripped.push(rule);
        break;
      case 'proof-failed':
      case 'proof-stale':
      case 'proof-unexercised':
      case 'proof-unproven': {
        const run = runs.proof;
        if (!run?.ran) break;
        const counts = parseProofCounts(run.messages);
        if (!counts.ledger) {
          notes.push(`${rule}: no proof ledger found, nothing to check`);
          break;
        }
        const key = rule.slice('proof-'.length);
        const n = key === 'failed' ? counts.failed + counts.error : counts[key];
        if (n > 0) tripped.push(rule);
        break;
      }
      case 'results':
        if (runs.results?.ran && runs.results.exitCode !== 0) tripped.push(rule);
        break;
      case 'validate':
        if (runs.validate?.ran && runs.validate.exitCode !== 0) tripped.push(rule);
        break;
      case 'security':
        if (runs.security?.ran && runs.security.exitCode !== 0) tripped.push(rule);
        break;
      case 'deps':
        if (runs.deps?.ran && runs.deps.exitCode !== 0) tripped.push(rule);
        break;
      default: {
        const m = /^align-below:(\d+)$/.exec(rule);
        if (m) {
          const avg = runs.align?.alignAverage;
          if (runs.align?.ran && typeof avg === 'number' && avg < Number(m[1])) {
            tripped.push(`${rule} (average ${avg}%)`);
          }
        } else {
          notes.push(`unknown fail-on rule '${rule}' ignored`);
        }
      }
    }
  }
  return { tripped, notes };
}

/** CLI argument list for one gate. */
export function argsFor(gate, env) {
  switch (gate) {
    case 'status':
      return ['status'];
    case 'drift':
      return ['drift', ...(env.SG_DRIFT_SINCE ? ['--since', env.SG_DRIFT_SINCE] : [])];
    case 'proof':
      return ['proof', 'status'];
    case 'align':
      return ['align', '--all'];
    case 'results': {
      const files = splitList(env.SG_RESULTS);
      return files.length === 0
        ? null
        : ['results', 'ingest', ...files, ...(env.SG_RUN_ID ? ['--run-id', env.SG_RUN_ID] : [])];
    }
    case 'validate':
      return ['validate', '--all', ...(env.SG_VALIDATE_URL ? ['--url', env.SG_VALIDATE_URL] : [])];
    case 'security':
      return ['security', '--all', '--with-sast'];
    case 'deps':
      return ['deps'];
    default:
      return null;
  }
}

function parseJsonResult(stdout) {
  for (const line of String(stdout).split('\n').reverse()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function summaryLine(gate, run) {
  const icon = !run.ran ? 'skipped' : run.exitCode === 0 ? 'pass' : `exit ${run.exitCode}`;
  return `| ${gate} | ${icon} | ${run.note ?? ''} |`;
}

export function main(env = process.env) {
  const gates = splitList(env.SG_GATES || 'status,proof');
  const unknown = gates.filter((g) => !GATES.includes(g));
  if (unknown.length > 0) {
    console.error(`unknown gate(s): ${unknown.join(', ')}. Known: ${GATES.join(', ')}`);
    return 2;
  }
  const failOn = splitList(env.SG_FAIL_ON || DEFAULT_FAIL_ON);
  const bin = env.SG_BIN || 'specguard';
  const outDir = path.join('.specguard', 'ci');
  mkdirSync(outDir, { recursive: true });

  const runs = {};
  for (const gate of GATES) {
    if (!gates.includes(gate)) continue;
    const args = argsFor(gate, env);
    if (!args) {
      runs[gate] = { ran: false, exitCode: 0, note: 'nothing to run (no inputs)' };
      continue;
    }
    console.log(`::group::specguard ${args.join(' ')}`);
    const res = spawnSync(bin, ['--json', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false });
    console.log(res.stdout?.slice(0, 20000) ?? '');
    if (res.stderr) console.error(res.stderr.slice(0, 20000));
    console.log('::endgroup::');
    const parsed = parseJsonResult(res.stdout);
    const exitCode = res.status ?? 1;
    runs[gate] = { ran: true, exitCode, messages: parsed?.messages ?? [], note: `${parsed ? `${parsed.failed ?? 0} failed` : 'no JSON'}` };
    writeFileSync(path.join(outDir, `${gate}.json`), `${JSON.stringify({ gate, args, exitCode, result: parsed }, null, 2)}\n`);
    if (gate === 'align') {
      try {
        runs.align.alignAverage = averageAlignment(JSON.parse(readFileSync(path.join('.specguard', 'alignment.json'), 'utf8')));
        runs.align.note += `, average ${runs.align.alignAverage ?? 'n/a'}%`;
      } catch {
        runs.align.alignAverage = null;
      }
    }
    if (exitCode === EXIT.BudgetExceeded) runs[gate].note += ', LLM budget exceeded';
  }

  const { tripped, notes } = evaluate(runs, failOn);
  const summary = [
    '## SpecGuard',
    '',
    '| Gate | Result | Note |',
    '|---|---|---|',
    ...Object.entries(runs).map(([gate, run]) => summaryLine(gate, run)),
    '',
    tripped.length > 0 ? `**Failed on:** ${tripped.join(', ')}` : '**All configured thresholds passed.**',
    ...notes.map((n) => `- ${n}`),
    '',
  ].join('\n');
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `failed=${tripped.length > 0}\ntripped=${tripped.join(',')}\n`);
  }
  return tripped.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(main());
}
