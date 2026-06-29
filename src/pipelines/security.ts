/**
 * Security pipeline.
 *
 * Generates OWASP-annotated security test stubs from a spec's `## Security
 * Notes` section and its source module, and optionally runs a Semgrep SAST
 * scan over the source tree.
 *
 * Spec: specs/pipelines/security.md
 *
 * Spec -> app -> output-path mapping
 * ----------------------------------
 * Every spec lives under exactly one app's `specDir`. We map a spec back to its
 * owning app by matching the resolved spec file path against each app's resolved
 * `specDir`. Security tests are always written to:
 *
 *   <rootDir>/tests/security/<feature>.test.ts
 *
 * where `feature` is the spec file path relative to the owning app's `specDir`,
 * with the `.md` extension dropped. Unlike forward-generate, the output is NOT
 * derived from the app's `testOutput` — security tests are collected under a
 * single `tests/security/` tree.
 *
 * The PipelineItem key / log key is `<app.name>/<feature>`.
 *
 * Exit-code policy
 * ----------------
 * Generating security test STUBS is never itself a failure — stubs are starting
 * points for a human to flesh out, so the default exit code is 0 even when many
 * stubs are written. The pipeline only signals `ExitCode.SecurityIssues` (5)
 * when `--with-sast` is requested AND the SAST scan returns real findings, i.e.
 * a concrete, machine-detected problem in the source.
 */
import path from 'node:path';

import type {
  SpecGuardConfig,
  AppConfig,
  ParsedSpec,
  PipelineResult,
  PipelineItem,
} from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import { readFile, fileExists } from '../core/reader.js';
import { writeFile } from '../core/writer.js';
import { parseSpecContent, loadAllSpecs, extractSection } from '../core/spec-parser.js';
import { llmGenerateText } from '../core/llm.js';
import { runContainer } from '../adapters/docker.js';
import { runNpmAudit } from '../adapters/npm-audit.js';

export interface SecurityOpts {
  /** A spec key (e.g. `core/spec-parser`) or a direct path to a `.md` spec. */
  spec?: string;
  /** Process every spec under each app's specDir. */
  all?: boolean;
  /** Run a Semgrep SAST scan over the owning app's repo. */
  withSast?: boolean;
  /** Restrict resolution / `--all` to a single app by name. */
  app?: string;
  /** Overwrite existing security test files (default: skip existing). */
  force?: boolean;
}

/** A single SAST finding, normalized from Semgrep's JSON output. */
export interface SastFinding {
  /** Rule / check id that produced the finding. */
  ruleId: string;
  /** Source file path the finding refers to. */
  path: string;
  /** Line number, if known. */
  line?: number;
  /** Short human-readable message. */
  message: string;
  /** Severity as reported by the tool, if known. */
  severity?: string;
}

/** Result of a SAST run. `ok` is false when the tool could not run at all. */
export interface SastResult {
  findings: SastFinding[];
  ok: boolean;
}

/** A spec file paired with the app whose specDir owns it. */
interface OwnedSpec {
  absSpecPath: string;
  app: AppConfig;
  specDirAbs: string;
}

/** System prompt instructing the model how to write security test stubs. */
const SYSTEM_PROMPT = [
  'You are SpecGuard, generating OWASP-annotated security test stubs from a Living Specification.',
  '',
  'Rules:',
  '- Emit ONE complete vitest test file containing security test stubs.',
  '- Annotate EACH test with the relevant OWASP Top 10 category as a leading comment,',
  '  e.g. `// OWASP A01: Broken Access Control` above the it()/test() block.',
  '- Derive tests from the spec\'s Security Notes and the source module\'s surface area.',
  '- If SAST findings are provided, add a concrete regression test targeting each one.',
  '- Use vitest idioms: import { describe, it, expect } from "vitest".',
  '- Output ONLY valid test code. No Markdown code fences, no prose, no explanation.',
].join('\n');

/** Resolve a possibly-relative path against the config root dir. */
function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

/** The apps in scope, optionally narrowed to `opts.app`. */
function appsInScope(config: SpecGuardConfig, opts: SecurityOpts): AppConfig[] {
  if (!opts.app) return config.apps;
  const app = config.apps.find((a) => a.name === opts.app);
  if (!app) {
    const known = config.apps.map((a) => a.name).join(', ') || '(none)';
    throw new SpecGuardError(
      `Unknown app \`${opts.app}\`. Known apps: ${known}.`,
      ExitCode.InternalError,
    );
  }
  return [app];
}

/** Return the app whose resolved specDir contains `absSpecPath`, if any. */
function findOwningApp(
  config: SpecGuardConfig,
  apps: AppConfig[],
  absSpecPath: string,
): { app: AppConfig; specDirAbs: string } | null {
  for (const app of apps) {
    const specDirAbs = resolveFromRoot(config, app.specDir);
    const rel = path.relative(specDirAbs, absSpecPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { app, specDirAbs };
    }
  }
  return null;
}

/**
 * Resolve `opts.spec` (a spec key like `core/spec-parser` or a direct `.md`
 * path) to an absolute spec file path, if one can be found.
 */
function resolveSingleSpecPath(
  config: SpecGuardConfig,
  apps: AppConfig[],
  spec: string,
): string | null {
  if (/\.md$/i.test(spec)) {
    return resolveFromRoot(config, spec);
  }

  const parts = spec.split('/');
  const byArea = apps.find(
    (a) => path.basename(resolveFromRoot(config, a.specDir)) === parts[0],
  );
  const chosen = byArea ?? apps[0];
  if (chosen) {
    const specDirAbs = resolveFromRoot(config, chosen.specDir);
    const base = path.basename(specDirAbs);
    const remainder = parts[0] === base ? parts.slice(1).join('/') : spec;
    return path.join(specDirAbs, `${remainder}.md`);
  }

  return resolveFromRoot(config, `${spec}.md`);
}

/** Derive the feature path (no extension) for a spec relative to its specDir. */
function deriveFeature(absSpecPath: string, specDirAbs: string): string {
  let rel = path.relative(specDirAbs, absSpecPath).split(path.sep).join('/');
  rel = rel.replace(/\.md$/i, '');
  return rel;
}

/**
 * Strip an accidental Markdown code fence wrapping the LLM output. Handles a
 * leading ```ts / ```typescript / ``` line and a trailing closing fence.
 */
function stripFences(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```[^\n]*\n/);
  if (fence) {
    t = t.slice(fence[0].length);
    t = t.replace(/\n?```[ \t]*$/, '');
  }
  return `${t.trim()}\n`;
}

/**
 * SAST seam — exported so tests can mock `sast.run`. Invokes Semgrep via the
 * Docker adapter over `targetDir`. Never throws: if Docker/Semgrep is
 * unavailable, or the invocation fails, it returns `{ findings: [], ok: false }`.
 */
export const sast = {
  async run(targetDir: string, rulesDir?: string): Promise<SastResult> {
    try {
      const args: string[] = ['semgrep', '--json'];
      if (rulesDir) {
        args.push('--config', '/rules', '--config', 'p/owasp-top-ten');
      } else {
        args.push('--config', 'auto');
      }
      args.push('/src');

      const volumes = [{ host: targetDir, container: '/src', mode: 'ro' as const }];
      if (rulesDir) {
        volumes.push({ host: rulesDir, container: '/rules', mode: 'ro' as const });
      }

      const result = await runContainer({
        image: 'semgrep/semgrep',
        tag: '1.78.0',
        volumes,
        args,
      });

      if (!result.ok && result.stdout.trim() === '') {
        return { findings: [], ok: false };
      }

      const parsed = JSON.parse(result.stdout) as {
        results?: Array<{
          check_id?: string;
          path?: string;
          start?: { line?: number };
          extra?: { message?: string; severity?: string };
        }>;
      };
      const findings: SastFinding[] = (parsed.results ?? []).map((r) => ({
        ruleId: r.check_id ?? 'unknown',
        path: r.path ?? '(unknown)',
        line: r.start?.line,
        message: r.extra?.message ?? '',
        severity: r.extra?.severity,
      }));
      return { findings, ok: true };
    } catch {
      return { findings: [], ok: false };
    }
  },
};

/** Format SAST findings into a compact block for the LLM prompt. */
function sastBlock(findings: SastFinding[]): string {
  if (findings.length === 0) return '(none)';
  return findings
    .slice(0, 50)
    .map((f) => {
      const loc = f.line ? `${f.path}:${f.line}` : f.path;
      const sev = f.severity ? `[${f.severity}] ` : '';
      return `- ${sev}${f.ruleId} @ ${loc} — ${f.message}`;
    })
    .join('\n');
}

/**
 * Generate OWASP-annotated security test stubs from Living Specs, optionally
 * running a Semgrep SAST scan.
 */
export async function runSecurity(
  config: SpecGuardConfig,
  opts: SecurityOpts,
): Promise<PipelineResult> {
  const result = emptyResult('security');

  if (!opts.spec && !opts.all) {
    throw new SpecGuardError(
      'Nothing to do: pass either --spec <key|path> or --all.',
      ExitCode.InternalError,
    );
  }

  const apps = appsInScope(config, opts);

  // Build the list of owned spec files to process.
  const owned: OwnedSpec[] = [];

  if (opts.spec) {
    const absSpecPath = resolveSingleSpecPath(config, apps, opts.spec);
    if (absSpecPath) {
      const ownerByDir = findOwningApp(config, apps, absSpecPath);
      const app = ownerByDir?.app ?? apps[0];
      const specDirAbs = ownerByDir?.specDirAbs ?? resolveFromRoot(config, app.specDir);
      owned.push({ absSpecPath, app, specDirAbs });
    }
  }

  if (opts.all) {
    for (const app of apps) {
      const specDirAbs = resolveFromRoot(config, app.specDir);
      for (const parsed of loadAllSpecs(specDirAbs)) {
        owned.push({ absSpecPath: parsed.filePath, app, specDirAbs });
      }
    }
  }

  const log = (line: string): void => {
    result.messages.push(line);
  };

  // Run SAST + npm-audit once per owning-app repo (cached) when requested.
  // Real findings drive the final exit code; unavailable tools degrade to zero findings.
  const sastByRepo = new Map<string, SastResult>();
  const npmAuditByRepo = new Map<string, SastFinding[]>();
  let sawRealFindings = false;

  const runSastForApp = async (app: AppConfig, rulesDir?: string): Promise<SastResult> => {
    const repoAbs = resolveFromRoot(config, app.repo);
    const cacheKey = `${repoAbs}:${rulesDir ?? ''}`;
    const cached = sastByRepo.get(cacheKey);
    if (cached) return cached;
    let res: SastResult;
    try {
      res = await sast.run(repoAbs, rulesDir);
    } catch {
      res = { findings: [], ok: false };
    }
    if (!res.ok) {
      log(`[warn] SAST unavailable for ${app.name} (${repoAbs}) — skipping scan`);
    } else if (res.findings.length > 0) {
      sawRealFindings = true;
      log(`[sast] ${app.name}: ${res.findings.length} finding(s)`);
      for (const f of res.findings) {
        const loc = f.line ? `${f.path}:${f.line}` : f.path;
        log(`  - ${f.ruleId} @ ${loc}`);
      }
    } else {
      log(`[sast] ${app.name}: no findings`);
    }
    sastByRepo.set(cacheKey, res);
    return res;
  };

  const runNpmAuditForApp = async (app: AppConfig): Promise<SastFinding[]> => {
    const repoAbs = resolveFromRoot(config, app.repo);
    const cached = npmAuditByRepo.get(repoAbs);
    if (cached) return cached;
    const auditResult = await runNpmAudit(repoAbs);
    if (!auditResult.ok) {
      log(`[warn] npm audit unavailable for ${app.name} — skipping dep scan`);
      npmAuditByRepo.set(repoAbs, []);
      return [];
    }
    if (auditResult.findings.length > 0) {
      sawRealFindings = true;
      log(`[npm-audit] ${app.name}: ${auditResult.findings.length} vulnerable dep(s)`);
      for (const f of auditResult.findings.slice(0, 10)) {
        log(`  - ${f.ruleId}: ${f.message}`);
      }
    } else {
      log(`[npm-audit] ${app.name}: no vulnerabilities`);
    }
    npmAuditByRepo.set(repoAbs, auditResult.findings);
    return auditResult.findings;
  };

  /** Count of specs that reached the LLM stage (created + failed). */
  let attempted = 0;

  for (const { absSpecPath, app, specDirAbs } of owned) {
    const feature = deriveFeature(absSpecPath, specDirAbs);
    const key = `${app.name}/${feature}`;

    if (!(await fileExists(absSpecPath))) {
      log(`[warn] ${key} — spec file not found: ${absSpecPath}`);
      continue;
    }

    // Security tests are collected under a single tests/security/ tree.
    const targetTest = resolveFromRoot(
      config,
      path.join('tests', 'security', `${feature}.test.ts`),
    );

    if (!opts.force && (await fileExists(targetTest))) {
      log(`[skip] ${key} — security test already exists`);
      result.items.push({
        key,
        status: 'skipped',
        path: targetTest,
        message: 'security test already exists',
      });
      result.skipped += 1;
      continue;
    }

    let spec: ParsedSpec;
    try {
      const content = await readFile(absSpecPath);
      spec = parseSpecContent(content, absSpecPath, specDirAbs);
    } catch (err) {
      log(`[warn] ${key} — could not read spec: ${(err as Error).message}`);
      continue;
    }

    const securityNotes = extractSection(await readFile(absSpecPath), 'Security Notes')
      || spec.securityNotes
      || '(no Security Notes section in spec)';

    // Read the source module named in the spec metadata (best-effort).
    let sourceModule = '(no module declared in spec metadata)';
    if (spec.meta.module) {
      const moduleAbs = resolveFromRoot(config, spec.meta.module);
      try {
        sourceModule = await readFile(moduleAbs);
      } catch {
        sourceModule = `(module \`${spec.meta.module}\` declared but could not be read)`;
      }
    }

    // Run SAST + npm-audit per owning app when requested, and feed findings into the prompt.
    let sastFindings: SastFinding[] = [];
    if (opts.withSast) {
      const rulesDir = resolveFromRoot(config, '.specguard/rules/semgrep');
      const { fileExists: fe } = await import('../core/reader.js');
      const hasRules = await fe(rulesDir);
      const [sastResult, auditFindings] = await Promise.all([
        runSastForApp(app, hasRules ? rulesDir : undefined),
        runNpmAuditForApp(app),
      ]);
      sastFindings = [...sastResult.findings, ...auditFindings];
    }

    const prompt = [
      `Generate OWASP-annotated security test stubs (vitest) for this Living Specification.`,
      `Spec key: ${key}`,
      `Spec title: ${spec.title}`,
      `Module under test: ${spec.meta.module ?? '(unknown)'}`,
      '',
      'Security Notes:',
      securityNotes,
      '',
      'Source module (for surface-area reference):',
      sourceModule,
      '',
      'SAST findings to target with regression tests:',
      sastBlock(sastFindings),
    ].join('\n');

    attempted += 1;
    try {
      const raw = await llmGenerateText({
        provider: config.llm.provider,
        model: config.llm.model,
        apiKeyEnv: config.llm.apiKeyEnv,
        system: SYSTEM_PROMPT,
        prompt,
      });
      const testCode = stripFences(raw);
      await writeFile(targetTest, testCode);
      log(`[gen] ${key}`);
      result.items.push({ key, status: 'created', path: targetTest });
      result.created += 1;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      log(`[fail] ${key} — ${message}`);
      result.items.push({ key, status: 'failed', path: targetTest, message });
      result.failed += 1;
    }
  }

  // Exit-code policy: generating stubs is not a failure. Only real SAST findings
  // (when --with-sast is set) escalate the exit code to SecurityIssues.
  if (opts.withSast && sawRealFindings) {
    result.exitCode = ExitCode.SecurityIssues;
  } else if (attempted > 0 && result.created === 0 && result.failed === attempted) {
    result.exitCode = ExitCode.InternalError;
  }

  // Write a fix plan when there are SAST findings or generation failures.
  const planWorthy = (opts.withSast && sawRealFindings) || result.failed > 0;
  if (planWorthy) {
    try {
      const { writePlan } = await import('../core/plan-writer.js');
      const failedItems = result.items.filter((i) => i.status === 'failed');
      const cwd = config.rootDir ?? process.cwd();
      const sastLines = result.messages.filter((m) => m.includes('[sast]') || m.includes('[finding]'));
      writePlan({
        pipeline: 'security',
        title: `Fix Security Issues — ${failedItems.length} failure(s)${sawRealFindings ? ', SAST findings present' : ''}`,
        summary: `The security pipeline detected ${result.failed} issue(s). ` +
          (sawRealFindings ? 'SAST analysis found real security vulnerabilities that require immediate attention. ' : '') +
          'Review the findings and apply the fixes below.',
        sections: [
          {
            heading: 'SAST Findings',
            items: sastLines.slice(0, 20).map((l) => l.replace(/^\[.*?\]\s*/, '')),
          },
          {
            heading: 'Failed Test Generation',
            items: failedItems.map((i) => `\`${i.key}\` — ${i.message ?? 'generation failed'}`),
          },
          {
            heading: 'Fix Steps',
            ordered: true,
            items: [
              'Review each SAST finding and determine if it is a true positive.',
              'Apply security patches: input validation, output encoding, auth checks as appropriate.',
              'For failed test generation, check that the spec file exists and has valid scenarios.',
              'Run `specguard security --with-sast` to verify all findings are resolved.',
            ],
          },
        ],
        rootDir: cwd,
      });
    } catch { /* best-effort */ }
  }

  return result;
}
