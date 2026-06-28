#!/usr/bin/env node
/**
 * SpecGuard MCP server.
 *
 * Exposes every SpecGuard pipeline as an MCP tool over a stdio transport. Each
 * tool loads config via `loadConfig` and calls the SAME pipeline function the
 * CLI dispatches to (see specs/core/cli.md), then returns the resulting
 * `PipelineResult` formatted as text content.
 *
 * Importing this module only builds and configures the server; the stdio
 * transport is started only when the file is run as the main module, so the
 * smoke test (and the optional vitest) can import it without hanging.
 *
 * See specs/core/mcp-server.md.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadConfig } from '../core/config.js';
import { parseSpecContent } from '../core/spec-parser.js';
import { readFile } from '../core/reader.js';
import { writeFile } from '../core/writer.js';

import { runReverseGenerate } from '../pipelines/reverse-generate.js';
import { runForwardGenerate } from '../pipelines/forward-generate.js';
import { runHeal } from '../pipelines/heal.js';
import { runStatus } from '../pipelines/status.js';
import { runDrift } from '../pipelines/drift.js';
import { runSecurity } from '../pipelines/security.js';
import { runDocGenerate } from '../pipelines/doc-generate.js';
import { runValidate } from '../pipelines/validate.js';
import { runMatrix } from '../pipelines/matrix.js';
import { runImport } from '../pipelines/import.js';
import { runCodeQuality } from '../pipelines/code-quality.js';
import { runDepCheck } from '../pipelines/dep-check.js';
import { runGitOps } from '../pipelines/git-ops.js';
import { runAnalyze } from '../pipelines/analyze.js';
import { runPlanFix } from '../pipelines/plan-fix.js';

import { errorResult, textResult, toolResult, type ToolResult } from './format.js';
import { appendActivityLogEntry } from './activity-hook.js';

const SERVER_NAME = 'specguard-mcp';
const SERVER_VERSION = '0.1.0';

/** Resolve the working directory a tool should load config from. */
function resolveCwd(cwd?: string): string {
  return cwd ? path.resolve(cwd) : process.cwd();
}

/**
 * Wrap a pipeline call with activity logging.
 * Writes start/end entries to .specguard/activity-log.json so the VS Code
 * dashboard can show real-time agent activity without the extension needing to
 * directly observe MCP calls.
 */
async function withActivityLog(
  pipeline: string,
  cwd: string,
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const startMs = Date.now();
  appendActivityLogEntry(cwd, { pipeline, status: 'running', source: 'mcp' });
  try {
    const result = await fn();
    appendActivityLogEntry(cwd, {
      pipeline,
      status: result.isError ? 'fail' : 'pass',
      source: 'mcp',
      durationMs: Date.now() - startMs,
    });
    return result;
  } catch (err) {
    appendActivityLogEntry(cwd, {
      pipeline,
      status: 'error',
      source: 'mcp',
      durationMs: Date.now() - startMs,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Build and configure the MCP server, registering every tool. Does NOT connect
 * a transport — see {@link main}.
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // --- Pipeline tools ------------------------------------------------------

  server.registerTool(
    'specguard_reverse',
    {
      description:
        'Reverse-generate Living Specs from an app\'s source files (CLI: specguard reverse).',
      inputSchema: {
        app: z.string().describe('App name from config to target.'),
        file: z.string().optional().describe('Single source file (relative to app repo).'),
        force: z.boolean().optional().describe('Overwrite existing specs.'),
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    ({ app, file, force, cwd }): Promise<ToolResult> =>
      withActivityLog('reverse', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runReverseGenerate(config, { app, file, force });
        return toolResult(result);
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_generate',
    {
      description:
        'Forward-generate tests from specs (CLI: specguard generate). Pass --spec or --all.',
      inputSchema: {
        spec: z.string().optional().describe('Spec key (e.g. core/spec-parser) or path to a .md spec.'),
        all: z.boolean().optional().describe('Process every spec under each app specDir.'),
        framework: z.string().optional().describe('Target framework override (vitest|playwright|jest).'),
        app: z.string().optional().describe('Restrict to a single app by name.'),
        force: z.boolean().optional().describe('Overwrite existing test files.'),
        type: z.enum(['unit', 'integration', 'e2e']).optional().describe('Test type: unit (mock deps), integration (real deps), e2e (Playwright).'),
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    ({ spec, all, framework, app, force, type, cwd }): Promise<ToolResult> =>
      withActivityLog('generate', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runForwardGenerate(config, { spec, all, framework, app, force, type });
        return toolResult(result);
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_heal',
    {
      description:
        'Run the self-healing test loop (CLI: specguard heal).',
      inputSchema: {
        spec: z.string().optional().describe('Target a single spec\'s tests (best-effort).'),
        all: z.boolean().optional().describe('Heal across all apps.'),
        maxRetries: z.number().optional().describe('Override the retry budget from config.'),
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    ({ spec, all, maxRetries, cwd }): Promise<ToolResult> =>
      withActivityLog('heal', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runHeal(config, { spec, all, maxRetries });
        return toolResult(result);
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_status',
    {
      description: 'Report spec/test coverage across configured apps (CLI: specguard status).',
      inputSchema: {
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    ({ cwd }): Promise<ToolResult> =>
      withActivityLog('status', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runStatus(config);
        return toolResult(result);
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_drift',
    {
      description: 'Detect specs gone stale relative to changed source (CLI: specguard drift).',
      inputSchema: {
        since: z.string().optional().describe('Git ref to diff against; range becomes <since>..HEAD.'),
        spec: z.string().optional().describe('Restrict the report to a single spec key.'),
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    ({ since, spec, cwd }): Promise<ToolResult> =>
      withActivityLog('drift', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runDrift(config, { since, spec });
        return toolResult(result);
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_security',
    {
      description: 'Run requirement-driven security analysis (CLI: specguard security).',
      inputSchema: {
        spec: z.string().optional().describe('Spec key or path to a .md spec.'),
        all: z.boolean().optional().describe('Analyze every spec.'),
        withSast: z.boolean().optional().describe('Also run SAST (semgrep/bandit).'),
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    ({ spec, all, withSast, cwd }): Promise<ToolResult> =>
      withActivityLog('security', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runSecurity(config, { spec, all, withSast });
        return toolResult(result);
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_docs',
    {
      description: 'Generate documentation from specs (CLI: specguard docs).',
      inputSchema: {
        spec: z.string().optional().describe('Spec key or path to a .md spec.'),
        all: z.boolean().optional().describe('Generate docs for every spec.'),
        out: z.string().optional().describe('Output directory.'),
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    ({ spec, all, out, cwd }): Promise<ToolResult> =>
      withActivityLog('docs', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runDocGenerate(config, { spec, all, out });
        return toolResult(result);
      }).catch(errorResult),
  );

  // --- Validate -------------------------------------------------------------

  server.registerTool(
    'specguard_validate',
    {
      description:
        'Validate specs against the running app using PERCEIVE-PLAN-ACT-VERIFY browser loop (CLI: specguard validate). Requires @playwright/test installed and a running app.',
      inputSchema: {
        spec: z.string().optional().describe('Spec key to validate.'),
        all: z.boolean().optional().describe('Validate all specs with url: metadata.'),
        baseUrl: z.string().optional().describe('Base URL of the running app.'),
        app: z.string().optional().describe('Limit to a single app.'),
        cwd: z.string().optional(),
      },
    },
    ({ spec, all, baseUrl, app, cwd }): Promise<ToolResult> =>
      withActivityLog('validate', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runValidate(config, { spec, all, baseUrl, app });
        return toolResult(result);
      }).catch(errorResult),
  );

  // --- Matrix ---------------------------------------------------------------

  server.registerTool(
    'specguard_matrix',
    {
      description:
        'Build the requirement-to-test traceability matrix (CLI: specguard matrix). Outputs traceability.json.',
      inputSchema: {
        out: z.string().optional().describe('Output file path.'),
        format: z.string().optional().describe('json or csv.'),
        app: z.string().optional().describe('Limit to a single app.'),
        cwd: z.string().optional(),
      },
    },
    ({ out, format, app, cwd }): Promise<ToolResult> =>
      withActivityLog('matrix', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runMatrix(config, {
          out,
          format: (format as 'json' | 'csv') ?? 'json',
          app,
        });
        return toolResult(result);
      }).catch(errorResult),
  );

  // --- Import ---------------------------------------------------------------

  server.registerTool(
    'specguard_import',
    {
      description:
        'Import an external requirements document (Markdown file or URL) and convert it to a Living Spec (CLI: specguard import).',
      inputSchema: {
        source: z.string().describe('File path or https:// URL to import.'),
        app: z.string().optional().describe('Target app from config.'),
        out: z.string().optional().describe('Override output spec path.'),
        force: z.boolean().optional().describe('Overwrite existing spec.'),
        cwd: z.string().optional(),
      },
    },
    ({ source, app, out, force, cwd }): Promise<ToolResult> =>
      withActivityLog('import', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runImport(config, { source, app, out, force });
        return toolResult(result);
      }).catch(errorResult),
  );

  // --- Code quality ---------------------------------------------------------

  server.registerTool(
    'specguard_quality',
    {
      description: 'Run ESLint + Knip code quality checks and write .specguard/code-quality.json (CLI: specguard quality).',
      inputSchema: {
        app: z.string().optional().describe('Limit to a single app by name.'),
        fix: z.boolean().optional().describe('Auto-fix ESLint fixable issues.'),
        cwd: z.string().optional(),
      },
    },
    ({ app, fix, cwd }): Promise<ToolResult> =>
      withActivityLog('quality', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runCodeQuality(config, { app, fix });
        return toolResult(result);
      }).catch(errorResult),
  );

  // --- Dep-check ------------------------------------------------------------

  server.registerTool(
    'specguard_deps',
    {
      description: 'Run npm-audit + depcheck dependency health checks and write .specguard/dep-check.json (CLI: specguard deps).',
      inputSchema: {
        app: z.string().optional().describe('Limit to a single app by name.'),
        cwd: z.string().optional(),
      },
    },
    ({ app, cwd }): Promise<ToolResult> =>
      withActivityLog('deps', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runDepCheck(config, { app });
        return toolResult(result);
      }).catch(errorResult),
  );

  // --- Git-ops --------------------------------------------------------------

  server.registerTool(
    'specguard_commit',
    {
      description: 'Stage and commit SpecGuard-generated files (tests, docs, specs, .specguard/ reports) only. Never commits source code (CLI: specguard commit).',
      inputSchema: {
        dryRun: z.boolean().optional().describe('Preview without staging/committing.'),
        message: z.string().optional().describe('Custom commit message suffix.'),
        app: z.string().optional().describe('Restrict to a single app.'),
        cwd: z.string().optional(),
      },
    },
    ({ dryRun, message, app, cwd }): Promise<ToolResult> =>
      withActivityLog('commit', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runGitOps(config, { dryRun, message, app });
        return toolResult(result);
      }).catch(errorResult),
  );

  // --- Analyze & Plan Fix ---------------------------------------------------

  server.registerTool(
    'specguard_analyze',
    {
      description:
        'Run all diagnostic checks (status, drift, quality, deps) and return prioritised recommendations for which pipelines to run next. Call this first when you are unsure what needs to be done.',
      inputSchema: {
        autoFix: z.boolean().optional().describe('Automatically run recommended pipelines after analysis.'),
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    ({ autoFix, cwd }): Promise<ToolResult> =>
      withActivityLog('analyze', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runAnalyze(config, { autoFix });
        const recs = result.analysisReport?.recommendations ?? [];
        const summary =
          recs.length === 0
            ? 'Workspace is healthy — nothing to do.'
            : `${recs.length} recommendation(s):\n` +
              recs.map((r) => `  [${r.priority}] ${r.pipeline}: ${r.reason}`).join('\n');
        return toolResult({ ...result, messages: [...result.messages, summary] });
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_plan_fix',
    {
      description:
        'Given a summary of pipeline failures, use the LLM to produce a structured, step-by-step fix plan. The plan is written to .specguard/fix-plan.json and returned as text. Present the plan to the user for approval before executing.',
      inputSchema: {
        pipeline: z.string().describe('The pipeline that produced the failures (e.g. "validate", "security").'),
        issues: z.string().describe('Human-readable summary of the issues found.'),
        logLines: z.array(z.string()).optional().describe('Optional: last N log lines from the failing pipeline for extra context.'),
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    ({ pipeline, issues, logLines, cwd }): Promise<ToolResult> =>
      withActivityLog('plan-fix', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runPlanFix(config, {
          sourcePipeline: pipeline,
          issuesSummary: issues,
          logLines,
        });
        const planText = result.plan
          ? [
              `Fix Plan: ${result.plan.title}`,
              result.plan.summary,
              '',
              ...result.plan.steps.map((s) => `  ${s.id}: ${s.description}`),
              '',
              'Plan saved to .specguard/fix-plan.json — present to user for approval before executing.',
            ].join('\n')
          : 'Failed to generate fix plan.';
        return toolResult({ ...result, messages: [planText] });
      }).catch(errorResult),
  );

  // --- Utility tools -------------------------------------------------------

  server.registerTool(
    'specguard_read_spec',
    {
      description:
        'Read a spec file and return its raw content plus a parsed summary. Provide either specKey (resolved against the first app\'s specDir) or an explicit path.',
      inputSchema: {
        specKey: z.string().optional().describe('Spec key, e.g. core/spec-parser.'),
        path: z.string().optional().describe('Explicit path to a .md spec file.'),
        cwd: z.string().optional().describe('Directory to load config / resolve relative paths from.'),
      },
    },
    async ({ specKey, path: specPath, cwd }): Promise<ToolResult> => {
      try {
        const baseCwd = resolveCwd(cwd);
        let filePath: string;
        let specsRoot: string;

        if (specPath) {
          filePath = path.resolve(baseCwd, specPath);
          // Best-effort specs root: the spec file's directory's nearest ancestor
          // is unknown here, so use the file's directory for specKey derivation.
          specsRoot = path.dirname(filePath);
        } else if (specKey) {
          const config = await loadConfig(baseCwd);
          const app = config.apps[0];
          if (!app) {
            return errorResult(new Error('Config has no apps; cannot resolve specKey.'));
          }
          specsRoot = path.resolve(config.rootDir ?? baseCwd, app.specDir);
          const rel = specKey.endsWith('.md') ? specKey : `${specKey}.md`;
          filePath = path.join(specsRoot, rel);
        } else {
          return errorResult(new Error('Provide either specKey or path.'));
        }

        const content = await readFile(filePath);
        const parsed = parseSpecContent(content, filePath, specsRoot);
        const summary = [
          `title: ${parsed.title}`,
          `specKey: ${parsed.specKey}`,
          `type: ${parsed.meta.type ?? '(none)'}`,
          `status: ${parsed.meta.status ?? '(none)'}`,
          `scenarios: ${parsed.scenarios.length}`,
          '',
          '--- content ---',
          content,
        ].join('\n');
        return textResult(summary);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'specguard_write_spec',
    {
      description: 'Write content to a spec file (creates parent directories).',
      inputSchema: {
        path: z.string().describe('Path to the spec file to write.'),
        content: z.string().describe('Full file content.'),
        cwd: z.string().optional().describe('Base directory for resolving a relative path.'),
      },
    },
    async ({ path: specPath, content, cwd }): Promise<ToolResult> => {
      try {
        const filePath = path.resolve(resolveCwd(cwd), specPath);
        await writeFile(filePath, content);
        return textResult(`Wrote ${content.length} bytes to ${filePath}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

/** Start the server on a stdio transport. Only called when run as main. */
async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** True when this module is the process entrypoint. */
function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(argv1);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[specguard-mcp] fatal:', err);
    process.exit(1);
  });
}
