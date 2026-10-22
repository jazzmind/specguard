#!/usr/bin/env node
/**
 * Gate runner for the SpecGuard GitHub Action.
 *
 * Runs the requested `specguard` gates, saves each JSON result under
 * `.specguard/ci/`, writes a job summary, and decides the exit code from
 * `fail-on`. The decision logic is exported so it can be unit tested.
 *
 * Environment (set by action.yml):
 *   SG_GATES       comma list: status, drift, proof, align, results, validate, security, deps, check, test, verify, scan, publish
 *   SG_FAIL_ON     comma list: missing-specs, drift, proof-failed, proof-stale, proof-unexercised,
 *                  proof-unproven, proof-incomplete, align-below:<pct>, results, validate, security, deps, check, test, verify, scan, publish, none
 *   SG_RESULTS     reporter files or globs for `results ingest`, comma or newline separated
 *   SG_RUN_ID      ledger run id for `results ingest`
 *   SG_DRIFT_SINCE git ref for `drift --since`
 *   SG_VALIDATE_URL base URL for `validate --all --url`
 *   SG_AFFECTED    "true": the `test` gate runs only changed workspace units and their dependents
 *   SG_AFFECTED_SINCE git ref the changed units are measured against (a pull request's base, for example origin/main);
 *                  default: SG_BASE_REF when set, else the working tree against HEAD
 *   SG_SARIF       "true": the `scan` gate also writes .specguard/security/scan.sarif
 *   SG_COMMENT     "true": on a pull request, post or update one comment with the results (needs SG_GITHUB_TOKEN)
 *   SG_GITHUB_TOKEN token that may write pull request comments
 *   SG_BIN         specguard binary (default: specguard)
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATES = ['status', 'drift', 'proof', 'align', 'results', 'validate', 'security', 'deps', 'check', 'test', 'verify', 'scan', 'publish'];
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
  const counts = { proven: 0, failed: 0, error: 0, unexercised: 0, stale: 0, unproven: 0, incomplete: 0, ledger: Boolean(line) };
  if (!line) return counts;
  // `[proof-incomplete] <claim> (missing: ...)` lines: claims not proven in every layer they require. An older CLI prints none.
  counts.incomplete = (messages ?? []).filter((m) => typeof m === 'string' && m.includes('[proof-incomplete]')).length;
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
      case 'proof-unproven':
      case 'proof-incomplete': {
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
      case 'check':
      case 'test':
      case 'verify':
      case 'scan':
      case 'publish':
        if (runs[rule]?.ran && runs[rule].exitCode !== 0) tripped.push(rule);
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
    case 'deps': // retired with the `deps` command; `security scan` covers dependency advisories
      return ['security', 'scan'];
    case 'check':
      return ['check'];
    case 'test': {
      // Without a ref `--affected` compares the working tree with HEAD, which on a clean checkout is nothing.
      const since = env.SG_AFFECTED_SINCE || env.SG_BASE_REF;
      return ['test', 'run', ...(env.SG_AFFECTED === 'true' ? ['--affected', ...(since ? ['--since', since] : [])] : []), ...(env.SG_RUN_ID ? ['--run-id', env.SG_RUN_ID] : [])];
    }
    case 'verify':
      return ['verify', '--all', ...(env.SG_VALIDATE_URL ? ['--url', env.SG_VALIDATE_URL] : [])];
    case 'scan':
      // With SG_SARIF the unresolved findings are also written as SARIF, which action.yml uploads to code scanning.
      return ['security', 'scan', ...(env.SG_SARIF === 'true' ? ['--sarif'] : [])];
    case 'publish': // writes the snapshot a team server pulls from the uploaded evidence
      return ['publish', '--out', '.specguard/publish/snapshot.json', ...(env.SG_SERVER_URL ? ['--server', env.SG_SERVER_URL] : [])];
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

export const COMMENT_MARKER = '<!-- specguard-pr-comment -->';
const METRICS_RE = /<!-- specguard-metrics: (\{.*?\}) -->/;

/** Numbers worth showing for a run: what `check`, `proof` and `scan` printed. Absent when the gate did not run. */
export function metricsOf(runs) {
  const m = {};
  const check = (runs.check?.messages ?? []).find((l) => typeof l === 'string' && l.startsWith('TOTAL:'));
  const t = check && /TOTAL: (\d+) source files, (\d+) specs \((\d+)%\), (\d+) tests \((\d+)%\), (\d+) missing specs/.exec(check);
  if (t) Object.assign(m, { sourceFiles: Number(t[1]), specPct: Number(t[3]), testedPct: Number(t[5]), missingSpecs: Number(t[6]) });
  if (runs.proof?.ran) {
    const p = parseProofCounts(runs.proof.messages);
    if (p.ledger) Object.assign(m, { proven: p.proven, failed: p.failed + p.error, stale: p.stale, unproven: p.unproven, incomplete: p.incomplete });
    const layers = (runs.proof.messages ?? []).find((l) => typeof l === 'string' && l.startsWith('LAYERS:'));
    if (layers) m.layers = Object.fromEntries([...layers.matchAll(/(unit|integration|e2e|security|functional) (\d+)\/(\d+)/g)].map((x) => [x[1], [Number(x[2]), Number(x[3])]]));
  }
  const scan = (runs.scan?.messages ?? []).find((l) => typeof l === 'string' && l.startsWith('security scan:'));
  const s = scan && /(\d+) item\(s\), (\d+) unresolved/.exec(scan);
  if (s) Object.assign(m, { findings: Number(s[1]), unresolved: Number(s[2]) });
  return m;
}

const LABELS = { sourceFiles: 'Source files', specPct: 'Owned by a spec (%)', testedPct: 'Claims cited by a test (%)', missingSpecs: 'Files with no spec', proven: 'Claims proven', failed: 'Claims failed', stale: 'Claims stale', unproven: 'Claims unproven', incomplete: 'Missing a required layer', findings: 'Security findings', unresolved: 'Unresolved findings' };
/** For these, a lower number is better, so the arrow means the opposite. */
const LOWER_IS_BETTER = new Set(['missingSpecs', 'failed', 'stale', 'unproven', 'incomplete', 'findings', 'unresolved']);

/** The pull request comment: results, numbers, and how each number moved since the last run on this pull request. */
export function buildComment(runs, tripped, notes, previous) {
  const metrics = metricsOf(runs);
  const rows = Object.entries(LABELS).filter(([k]) => metrics[k] !== undefined).map(([k, label]) => {
    const now = metrics[k];
    const before = previous?.[k];
    let change = '';
    if (typeof before === 'number' && before !== now) {
      const better = LOWER_IS_BETTER.has(k) ? now < before : now > before;
      change = `${better ? '▲ better' : '▼ worse'} (${before} → ${now})`;
    }
    return `| ${label} | ${now} | ${change} |`;
  });
  const layers = Object.entries(metrics.layers ?? {}).map(([l, [p, r]]) => `${l} ${p}/${r}`).join(' · ');
  const failedGates = Object.entries(runs).filter(([, r]) => r.ran && r.exitCode !== 0).map(([g]) => g);
  return [
    COMMENT_MARKER,
    `## SpecGuard ${tripped.length > 0 ? '❌' : '✅'}`,
    '',
    tripped.length > 0 ? `**Failed on:** ${tripped.join(', ')}` : '**All configured thresholds passed.**',
    failedGates.length > 0 ? `Gates with a non-zero exit: ${failedGates.join(', ')}` : '',
    '',
    ...(rows.length > 0 ? ['| | Now | Since the last run on this pull request |', '|---|---|---|', ...rows, ''] : []),
    layers ? `Proof by layer: ${layers}` : '',
    ...notes.map((n) => `- ${n}`),
    '',
    `<!-- specguard-metrics: ${JSON.stringify(metrics)} -->`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

/** Post the comment, or update the one this action left earlier. Never throws: a comment is a convenience. */
export async function postComment(env, makeBody, fetchImpl = globalThis.fetch) {
  try {
    const token = env.SG_GITHUB_TOKEN;
    if (!token || !env.GITHUB_EVENT_PATH || env.GITHUB_EVENT_NAME !== 'pull_request' || !env.GITHUB_REPOSITORY) return { posted: false, reason: 'not a pull request run with a token' };
    const number = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))?.pull_request?.number;
    if (!number) return { posted: false, reason: 'no pull request number' };
    const api = `${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/issues`;
    const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' };
    const listed = await fetchImpl(`${api}/${number}/comments?per_page=100`, { headers });
    if (!listed.ok) return { posted: false, reason: `listing comments: HTTP ${listed.status}` };
    const existing = (await listed.json()).find((c) => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER));
    const body = makeBody(previousMetrics(existing?.body));
    const res = existing
      ? await fetchImpl(`${api}/comments/${existing.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body }) })
      : await fetchImpl(`${api}/${number}/comments`, { method: 'POST', headers, body: JSON.stringify({ body }) });
    return res.ok ? { posted: true, updated: Boolean(existing) } : { posted: false, reason: `HTTP ${res.status}` };
  } catch (err) {
    return { posted: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The metrics of the previous comment on this pull request, for the "since the last run" column. */
export function previousMetrics(body) {
  const m = METRICS_RE.exec(body ?? '');
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}

let last;
/** What the most recent `main` call decided, for the code that runs after it (the pull request comment). */
export function lastRun() {
  return last;
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
  last = { runs, tripped, notes };
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
  const code = main();
  if (process.env.SG_COMMENT === 'true' && last) {
    const { runs, tripped, notes } = last;
    const res = await postComment(process.env, (previous) => buildComment(runs, tripped, notes, previous));
    console.log(res.posted ? `pull request comment ${res.updated ? 'updated' : 'posted'}` : `no pull request comment: ${res.reason}`);
  }
  process.exit(code);
}
