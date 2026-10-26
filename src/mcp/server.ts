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
import { loadSpecGuardEnv } from '../core/env.js';
import { parseSpecContent } from '../core/spec-parser.js';
import { readFile } from '../core/reader.js';
import { writeFile } from '../core/writer.js';
import { isInside, OutsideRootError } from '../core/safe-path.js';
import { emptyResult } from '../core/types.js';
import { resolveProfile } from '../core/language-profiles.js';
import { scaffoldHarnessFiles } from '../core/scaffold.js';

import { runReverseGenerate } from '../pipelines/reverse-generate.js';
import { runForwardGenerate } from '../pipelines/forward-generate.js';
import { runGapAnalysis } from '../pipelines/gap-analysis.js';
import { runInit } from '../pipelines/init.js';
import { runHeal } from '../pipelines/heal.js';
import { runStatus } from '../pipelines/status.js';
import { runDrift } from '../pipelines/drift.js';
import { runSecurity } from '../pipelines/security.js';
import { runDocGenerate } from '../pipelines/doc-generate.js';
import { runValidate } from '../pipelines/validate.js';
import { runMatrix } from '../pipelines/matrix.js';
import { runImport } from '../pipelines/import.js';
import { runContracts } from '../pipelines/contracts.js';
import { runImpact } from '../pipelines/impact.js';
import { runRemediate } from '../pipelines/remediate/index.js';
import { runCheck } from '../pipelines/check.js';
import { runHistoryAdd, runHistoryLog } from '../pipelines/history.js';
import { runSecurityScan } from '../pipelines/security-scan.js';
import { planList, planSetStatus, planShow, teamLines } from '../pipelines/team.js';
import { runSpecGraph } from '../pipelines/spec-graph-report.js';
import { runTestRun } from '../pipelines/test-run.js';
import { runWorkspaceDrift } from '../pipelines/workspace-drift.js';
import { loadWorkspaceWithConfigs } from '../core/workspace.js';
import { loadContractGraph } from '../core/contracts.js';
import { runClaimsAssign, runClaimsList } from '../pipelines/claims.js';
import { appendProofCoverage, runProofIngest } from '../pipelines/proof.js';
import { isResultFormat, runResultsIngest } from '../pipelines/results.js';

import { runWithPipeline } from '../core/llm-runtime.js';
import { answerAgentRequest, listAgentRequests, readAgentRequest, resolveRequestHash } from '../core/agent-work.js';
import { cliVersion } from '../core/version.js';
import { enabledPluginCommands } from '../plugins/commands.js';
import { errorResult, textResult, toolResult, type ToolResult } from './format.js';
import { formatPluginRows, listPlugins } from '../pipelines/plugin-manage.js';
import { appendActivityLogEntry } from './activity-hook.js';
import { mcpLimiter, mcpReadOnly, WRITE_TOOLS } from './limits.js';
import { registerChangeTools } from './tools/change.js';
import { registerProofStoreTools } from './tools/proof-store.js';

const SERVER_NAME = 'specguard-mcp';
const SERVER_VERSION = cliVersion();

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
  const limited = mcpLimiter.check(pipeline);
  if (limited) {
    appendActivityLogEntry(cwd, { pipeline, status: 'error', source: 'mcp', message: limited });
    return errorResult(new Error(limited));
  }
  // The CLI loads `.specguard/.env` at start-up; an MCP server has no start-up directory, so each call loads its own project's.
  loadSpecGuardEnv(cwd);
  appendActivityLogEntry(cwd, { pipeline, status: 'running', source: 'mcp' });
  try {
    const result = await runWithPipeline(pipeline, fn);
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
 * Register one tool per enabled plugin command, as `specguard_<name>`. A command
 * with `mcpParams` takes those typed inputs; otherwise free-form `args` and
 * `options`. Core tools win a name clash.
 */
export async function registerPluginTools(server: McpServer, cwd: string = process.cwd()): Promise<string[]> {
  const registered: string[] = [];
  for (const command of await enabledPluginCommands(cwd, (m) => console.error(`[specguard-mcp] ${m}`))) {
    if (command.mcp === false) continue;
    const name = `specguard_${command.name}`;
    const typed = command.mcpParams;
    try {
      server.registerTool(
        name,
        {
          description: `${command.description} (CLI: specguard ${command.name}; provided by a plugin).`,
          inputSchema: {
            ...(typed ?? { args: z.array(z.string()).optional(), options: z.record(z.string(), z.unknown()).optional() }),
            cwd: z.string().optional(),
          },
        },
        (input: Record<string, unknown>): Promise<ToolResult> => {
          const { cwd: inCwd, ...rest } = input;
          const dir = resolveCwd(inCwd as string | undefined);
          return withActivityLog(command.name, dir, async () => {
            const config = command.needsConfig === false ? await loadConfig(dir).catch(() => null) : await loadConfig(dir);
            // Typed inputs are the options as declared (one may itself be named `args` or `options`);
            // free-form tools carry `args` and `options` as separate fields.
            const free = rest as { args?: string[]; options?: Record<string, unknown> };
            const result = await command.run({
              config,
              opts: typed ? rest : (free.options ?? {}),
              args: typed ? [] : (free.args ?? []),
            });
            return toolResult(result);
          }).catch(errorResult);
        },
      );
      registered.push(name);
    } catch {
      /* a core tool already has this name */
    }
  }
  return registered;
}

/**
 * The tools an agent sees by default: one per core capability, mirroring the core CLI.
 * Everything else is a legacy name from before 0.2, registered only on request
 * (`SPECGUARD_MCP_LEGACY=1` or `buildServer({ legacy: true })`) so the default
 * tool list stays small. Plugin tools are always registered.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  'specguard_check',
  'specguard_spec_graph',
  'specguard_read_spec',
  'specguard_write_spec',
  'specguard_history_add',
  'specguard_history_log',
  'specguard_agent_work',
  'specguard_change_start',
  'specguard_change_red',
  'specguard_change_green',
  'specguard_change_status',
  'specguard_change_report',
  'specguard_proof_fetch',
  'specguard_test_run',
  'specguard_verify',
  'specguard_security_scan',
  'specguard_security_plan',
  'specguard_proof_status',
  'specguard_results_ingest',
  'specguard_impact',
  'specguard_contracts',
  'specguard_workspace_status',
  'specguard_init',
]);


/**
 * The directories a spec may be read from or written to through the MCP server: the specs root and each app's spec
 * directory of the project at `base`, or `<base>/specs` when there is no config. An agent that has read a hostile page
 * can be told to write any path with any content, so a file outside these (or one that is not Markdown) is refused.
 */
async function specRootsFor(base: string): Promise<string[]> {
  try {
    const config = await loadConfig(base);
    const root = config.rootDir ?? base;
    return [...new Set([config.paths?.specsRoot ?? 'specs', ...config.apps.map((a) => a.specDir)].map((d) => path.resolve(root, d)))];
  } catch {
    return [path.resolve(base, 'specs')];
  }
}

export async function specFileInside(base: string, file: string): Promise<string> {
  const abs = path.resolve(base, file);
  if (!abs.endsWith('.md')) throw new Error(`${file} is not a Markdown spec file`);
  const roots = await specRootsFor(base);
  if (!roots.some((r) => isInside(r, abs))) throw new OutsideRootError(file, roots.join(' or '));
  return abs;
}

/**
 * Build and configure the MCP server, registering the core tools (and the legacy
 * ones when asked). Does NOT connect a transport — see {@link main}.
 */
export function buildServer(opts: { legacy?: boolean } = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const legacy = opts.legacy ?? process.env.SPECGUARD_MCP_LEGACY === '1';
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  // Filter while the built-in tools register; plugin tools are added afterwards through the original method.
  // A read-only server never offers a tool that changes files.
  const readOnly = mcpReadOnly();
  (server as { registerTool: unknown }).registerTool = (name: string, ...rest: unknown[]) =>
    (legacy || CORE_TOOLS.has(name)) && !(readOnly && WRITE_TOOLS.has(name)) ? register(name, ...rest) : undefined;

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
        spec: z.string().optional().describe('Run only the app that owns this spec, and only its tests.'),
        all: z.boolean().optional().describe('Heal every app (the default).'),
        app: z.string().optional().describe('Heal a single app by name.'),
        maxRetries: z.number().optional().describe('Override the retry budget from config.'),
        classifyOnly: z.boolean().optional().describe('Classify failures only: never rewrite a test or re-run.'),
        lenient: z.boolean().optional().describe('Treat an unreadable report as passing when the runner exited 0.'),
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    ({ spec, all, app, maxRetries, classifyOnly, lenient, cwd }): Promise<ToolResult> =>
      withActivityLog('heal', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runHeal(config, { spec, all, app, maxRetries, classifyOnly, lenient });
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
        withSast: z.boolean().optional().describe('Also run SAST (Semgrep) and the dependency audit for the app language.'),
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

  for (const toolName of ['specguard_validate', 'specguard_verify']) {
  server.registerTool(
    toolName,
    {
      description:
        toolName === 'specguard_verify'
          ? 'Verify the running app against each capability: walk its journeys, judge it against its stated problem and value, and record agentic proof (CLI: specguard verify). Needs @playwright/test and a running app; pass baseUrl and all.'
          : 'Validate specs against the running app using PERCEIVE-PLAN-ACT-VERIFY browser loop (CLI: specguard validate). Requires @playwright/test installed and a running app.',
      inputSchema: {
        spec: z.string().optional().describe('Spec key to validate.'),
        all: z.boolean().optional().describe('Validate all specs with url: metadata.'),
        baseUrl: z.string().optional().describe('Base URL of the running app. Loopback, or a host listed in validate.allowedHosts.'),
        app: z.string().optional().describe('Limit to a single app.'),
        allowOutbound: z.boolean().optional().describe('Let outbound actions run (staging). Destructive actions stay blocked.'),
        headed: z.boolean().optional().describe('Show the browser window.'),
        cwd: z.string().optional(),
      },
    },
    ({ spec, all, baseUrl, app, allowOutbound, headed, cwd }): Promise<ToolResult> =>
      withActivityLog(toolName === 'specguard_verify' ? 'verify' : 'validate', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        // An agent started this: it may only check loopback and the hosts the project lists in validate.allowedHosts.
        const result = await runValidate(config, { spec, all, baseUrl, app, allowOutbound, headed, restrictHosts: true });
        return toolResult(result);
      }).catch(errorResult),
  );
  }

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
        source: z.string().describe('File path (inside the project) or public https:// URL to import.'),
        app: z.string().optional().describe('Target app from config.'),
        out: z.string().optional().describe('Override output spec path.'),
        force: z.boolean().optional().describe('Overwrite existing spec.'),
        cwd: z.string().optional(),
      },
    },
    ({ source, app, out, force, cwd }): Promise<ToolResult> =>
      withActivityLog('import', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        // An agent names the source: a URL may not reach private addresses and a file must be inside the project.
        const result = await runImport(config, { source, app, out, force, restrictToProject: true });
        return toolResult(result);
      }).catch(errorResult),
  );

  // --- Gap Analysis ---------------------------------------------------------

  server.registerTool(
    'specguard_gap_analysis',
    {
      description:
        'Detect unimplemented or partially-implemented specs and generate LLM implementation plans for each gap (CLI: specguard gap-analysis). Call this when you want to know what features still need to be built.',
      inputSchema: {
        spec: z.string().optional().describe('Restrict to a single spec key (e.g. app/feature).'),
        all: z.boolean().optional().describe('Check all apps (default behaviour).'),
        plan: z.boolean().optional().describe('Generate LLM implementation plans for unimplemented specs (default: true).'),
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    ({ spec, all: _all, plan, cwd }): Promise<ToolResult> =>
      withActivityLog('gap-analysis', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runGapAnalysis(config, { spec, plan });
        return toolResult(result);
      }).catch(errorResult),
  );

  // --- Init -----------------------------------------------------------------

  server.registerTool(
    'specguard_init',
    {
      description:
        'Scaffold .specguard/config.json, specs/README.md, and agent-harness files (CLAUDE.md, skills, MCP wiring, /goal command) in the target directory. Language is auto-detected. Existing files are never clobbered (CLI: specguard init).',
      inputSchema: {
        language: z.enum(['typescript', 'python', 'go', 'rust', 'java']).optional().describe('Target language. Auto-detected from the project when omitted.'),
        harness: z.enum(['claude', 'cursor', 'both']).optional().describe('Which agent harness files to generate (default: both).'),
        framework: z.string().optional().describe('Test framework override. Defaults to the language profile (e.g. vitest, pytest).'),
        cwd: z.string().optional().describe('Target directory to initialise (default: process.cwd()).'),
      },
    },
    ({ language, harness, framework, cwd }): Promise<ToolResult> =>
      withActivityLog('init', resolveCwd(cwd), async () => {
        const result = await runInit({ language, harness, framework, cwd: resolveCwd(cwd) });
        return toolResult(result);
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_scaffold',
    {
      description:
        'Regenerate or add agent-harness files (CLAUDE.md, skills, MCP wiring, /goal command) for an already-initialised project, language-aware from its config. Idempotent and non-clobbering (managed files + sentinels + JSON merge).',
      inputSchema: {
        harness: z.enum(['claude', 'cursor', 'both']).optional().describe('Which agent harness files to generate (default: both).'),
        cwd: z.string().optional().describe('Project directory containing .specguard/config.json (default: process.cwd()).'),
      },
    },
    ({ harness, cwd }): Promise<ToolResult> =>
      withActivityLog('scaffold', resolveCwd(cwd), async () => {
        const root = resolveCwd(cwd);
        const config = await loadConfig(root);
        const profile = resolveProfile(config.apps[0] ?? {});
        const scaffold = await scaffoldHarnessFiles({ cwd: root, profile, harness });
        const result = emptyResult('scaffold');
        result.created = scaffold.created.length;
        result.updated = scaffold.updated.length;
        result.skipped = scaffold.skipped.length;
        result.messages = scaffold.messages;
        return toolResult(result);
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
      const limited = mcpLimiter.check('read-spec');
      if (limited) return errorResult(new Error(limited));
      try {
        const baseCwd = resolveCwd(cwd);
        let filePath: string;
        let specsRoot: string;

        if (specPath) {
          filePath = await specFileInside(baseCwd, specPath);
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
          filePath = await specFileInside(specsRoot, rel);
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
      description: 'Write content to a spec file (creates parent directories). Only Markdown files inside the project\'s spec directories can be written.',
      inputSchema: {
        path: z.string().describe('Path to the spec file to write.'),
        content: z.string().describe('Full file content.'),
        cwd: z.string().optional().describe('Base directory for resolving a relative path.'),
      },
    },
    async ({ path: specPath, content, cwd }): Promise<ToolResult> => {
      const limited = mcpLimiter.check('write-spec');
      if (limited) return errorResult(new Error(limited));
      try {
        const filePath = await specFileInside(resolveCwd(cwd), specPath);
        await writeFile(filePath, content);
        return textResult(`Wrote ${content.length} bytes to ${filePath}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Workspace + contracts tools -----------------------------------------

  server.registerTool(
    'specguard_contracts',
    {
      description:
        'Build or refresh the workspace contract graph (contracts.json) from cross-repo spec dependencies. ' +
        'Run from the workspace root directory. (CLI: specguard contracts)',
      inputSchema: {
        force: z.boolean().optional().describe('Force re-parse all specs, ignoring existing contracts.json.'),
        withLlm: z.boolean().optional().describe('Use LLM to extract contracts from free-text Dependencies sections.'),
        repo: z.string().optional().describe('Restrict to a single repo key from workspace.json.'),
        cwd: z.string().optional().describe('Workspace root directory (containing .specguard/workspace.json).'),
      },
    },
    ({ force, withLlm, repo, cwd }): Promise<ToolResult> =>
      withActivityLog('contracts', resolveCwd(cwd), async () => {
        try {
          const { manifest, repos } = await loadWorkspaceWithConfigs(resolveCwd(cwd));
          const llmConfig = repos.find((r) => r.specGuardConfig != null)?.specGuardConfig ?? undefined;
          const result = await runContracts(manifest, repos, { force, withLlm, repo }, llmConfig);
          return toolResult(result);
        } catch (err) {
          return errorResult(err);
        }
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_impact',
    {
      description:
        'Show blast radius of a changed spec or file: which other repos/specs are affected, ' +
        'and which drift/sync actions are needed. (CLI: specguard impact <target>)',
      inputSchema: {
        target: z
          .string()
          .describe(
            'Spec to analyze. Can be a node ID (e.g. graphql-api::specs/mutations/designer.md), ' +
            'a path relative to workspace root (e.g. provider-api/specs/mutations/designer.md), ' +
            'or an absolute path.',
          ),
        maxDepth: z.number().optional().describe('Maximum traversal depth (default: 6).'),
        upstream: z.boolean().optional().describe('Also show upstream dependencies (what this node depends on).'),
        cwd: z.string().optional().describe('Workspace root directory (containing .specguard/workspace.json).'),
      },
    },
    ({ target, maxDepth, upstream, cwd }): Promise<ToolResult> =>
      withActivityLog('impact', resolveCwd(cwd), async () => {
        try {
          const { manifest } = await loadWorkspaceWithConfigs(resolveCwd(cwd));
          const { result } = await runImpact(manifest, {
            target,
            maxDepth,
            showUpstream: upstream,
          });
          return toolResult(result);
        } catch (err) {
          return errorResult(err);
        }
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_plugin_list',
    {
      description:
        'List the plugins available to this repo and whether each is enabled, with the commands it adds. ' +
        'Read-only; change them with the CLI: specguard plugin enable|disable|add|remove. (CLI: specguard plugin list)',
      inputSchema: {
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    ({ cwd }): Promise<ToolResult> =>
      withActivityLog('plugin-list', resolveCwd(cwd), async () => {
        try {
          const { plugins } = await listPlugins(resolveCwd(cwd));
          return textResult(formatPluginRows(plugins).join('\n'));
        } catch (err) {
          return errorResult(err);
        }
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_workspace_status',
    {
      description:
        'Show a cross-repo health dashboard: spec counts, contract edge counts, and traceability status per repo. ' +
        '(CLI: specguard workspace status)',
      inputSchema: {
        cwd: z.string().optional().describe('Workspace root directory (containing .specguard/workspace.json).'),
      },
    },
    ({ cwd }): Promise<ToolResult> =>
      withActivityLog('workspace-status', resolveCwd(cwd), async () => {
        try {
          const { manifest, repos } = await loadWorkspaceWithConfigs(resolveCwd(cwd));
          const graph = await loadContractGraph(manifest.rootDir);

          const lines: string[] = [];
          lines.push(`Workspace: ${manifest.name}`);
          lines.push(`  ${repos.length} repos  ·  ${graph?.nodes.length ?? 0} nodes  ·  ${graph?.edges.length ?? 0} contract edges`);
          lines.push('');

          for (const repo of repos) {
            const hasConfig = repo.specGuardConfig != null;
            const outEdges = graph?.edges.filter((e) => e.consumer.startsWith(repo.key + '::')).length ?? 0;
            const inEdges = graph?.edges.filter((e) => e.provider.startsWith(repo.key + '::')).length ?? 0;
            const status = !hasConfig ? '✗ no specguard config' : '✓ configured';
            lines.push(`  ${repo.key.padEnd(24)}${repo.role.padEnd(12)}out:${outEdges}  in:${inEdges}  ${status}`);
          }

          if (!graph) {
            lines.push('');
            lines.push('  ✗ No contracts.json — run `specguard contracts` to build the graph');
          } else {
            const stale = graph.edges.filter((e) => {
              if (!e.lastVerified) return true;
              return Date.now() - new Date(e.lastVerified).getTime() > 30 * 24 * 60 * 60 * 1000;
            });
            lines.push('');
            lines.push(`  Contract health: ${graph.edges.length - stale.length}/${graph.edges.length} verified (last 30 days)`);
            if (stale.length > 0) lines.push(`  ${stale.length} stale edge(s)`);
          }

          return textResult(lines.join('\n'));
        } catch (err) {
          return errorResult(err);
        }
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_workspace_drift',
    {
      description:
        'Run cross-repo drift detection: identifies repos with recent changes, finds affected contract edges, ' +
        'and runs `specguard drift` in each consumer repo. (CLI: specguard workspace drift)',
      inputSchema: {
        since: z.string().optional().describe('Git ref to diff against (default: HEAD~1).'),
        force: z.boolean().optional().describe('Force re-check all contracts regardless of git changes.'),
        repo: z.string().optional().describe('Restrict to a single repo key.'),
        cwd: z.string().optional().describe('Workspace root directory (containing .specguard/workspace.json).'),
      },
    },
    ({ since, force, repo, cwd }): Promise<ToolResult> =>
      withActivityLog('workspace-drift', resolveCwd(cwd), async () => {
        try {
          const { manifest, repos } = await loadWorkspaceWithConfigs(resolveCwd(cwd));
          const result = await runWorkspaceDrift(manifest, repos, { since, force, repo });
          return toolResult(result);
        } catch (err) {
          return errorResult(err);
        }
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_claims',
    {
      description:
        'Assign stable claim ids to acceptance criteria, or list the claim catalog. ' +
        'list with workspace checks that every journey invariant cites a real claim. (CLI: specguard claims)',
      inputSchema: {
        action: z.enum(['assign', 'list']).describe('assign writes missing ids; list prints the catalog.'),
        workspace: z.boolean().optional().describe('Walk .specguard/workspace.json. Used by list.'),
        dir: z.string().optional().describe('Spec directory for assign. Defaults to the repo specs/ tree.'),
        dryRun: z.boolean().optional().describe('assign only: report ids without writing.'),
        cwd: z.string().optional().describe('Working directory.'),
      },
    },
    ({ action, workspace, dir, dryRun, cwd }): Promise<ToolResult> =>
      withActivityLog('claims', resolveCwd(cwd), async () => {
        try {
          const dirPath = resolveCwd(cwd);
          if (action === 'assign') {
            const config = dir ? undefined : await loadConfig(dirPath);
            const result = await runClaimsAssign({ dir, dryRun, config });
            return toolResult(result);
          }
          if (workspace) {
            return toolResult(await runClaimsList({ cwd: dirPath, workspace: true }));
          }
          const config = await loadConfig(dirPath);
          return toolResult(await runClaimsList({
            cwd: config.rootDir ?? dirPath,
            workspace: false,
            config,
          }));
        } catch (err) {
          return errorResult(err);
        }
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_proof_status',
    {
      description:
        'Report proof coverage for the claims in this repo: proven, failed, unexercised, stale, unproven. ' +
        '(CLI: specguard proof status)',
      inputSchema: {
        ledger: z.string().optional().describe('Proof ledger file override.'),
        cwd: z.string().optional().describe('Repo directory containing .specguard/config.json.'),
      },
    },
    ({ cwd, ledger }): Promise<ToolResult> =>
      withActivityLog('proof-status', resolveCwd(cwd), async () => {
        try {
          const config = await loadConfig(resolveCwd(cwd));
          const lines: string[] = [];
          await appendProofCoverage(config, (line) => lines.push(line), { ledger });
          return textResult(lines.join('\n'));
        } catch (err) {
          return errorResult(err);
        }
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_results_ingest',
    {
      description:
        'Ingest test-runner reports (Vitest/Jest JSON, Playwright JSON, JUnit XML, pytest-json-report, go test -json, ' +
        'cargo JSON) as proof verdicts. Tests map to claims by @claim:<specKey>#<claimId> tags. ' +
        '(CLI: specguard results ingest)',
      inputSchema: {
        files: z.array(z.string()).min(1).describe('Result file paths or globs, relative to cwd.'),
        format: z.string().optional().describe('auto (default), vitest, jest, playwright, junit, pytest, go, cargo.'),
        runId: z.string().optional().describe('Ledger run id.'),
        unexercised: z.boolean().optional().describe('Also store unexercised for claims absent from all files; only on a full run.'),
        fullRun: z.boolean().optional().describe('The files are the complete run; lets unexercised apply.'),
        ledger: z.string().optional().describe('Proof ledger file override.'),
        cwd: z.string().optional().describe('Repo directory containing .specguard/config.json.'),
      },
    },
    ({ files, format, runId, unexercised, fullRun, ledger, cwd }): Promise<ToolResult> =>
      withActivityLog('results-ingest', resolveCwd(cwd), async () => {
        try {
          const fmt = format ?? 'auto';
          if (!isResultFormat(fmt)) return errorResult(new Error(`unknown format '${fmt}'`));
          return toolResult(
            await runResultsIngest(files, resolveCwd(cwd), { format: fmt, runId, unexercised, fullRun, ledger }),
          );
        } catch (err) {
          return errorResult(err);
        }
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_proof_ingest',
    {
      description:
        'Merge a verdicts file ({runId, verdicts:[{claim, verdict, exercised?, counterexamples?, evidencePath?}]}) ' +
        'into the proof ledger. (CLI: specguard proof ingest)',
      inputSchema: {
        verdicts: z.string().describe('Path to verdicts.json, relative to cwd.'),
        ledger: z.string().optional().describe('Proof ledger file override.'),
        cwd: z.string().optional().describe('Repo directory containing .specguard/config.json.'),
      },
    },
    ({ verdicts, ledger, cwd }): Promise<ToolResult> =>
      withActivityLog('proof-ingest', resolveCwd(cwd), async () => {
        try {
          return toolResult(await runProofIngest(verdicts, resolveCwd(cwd), { ledger }));
        } catch (err) {
          return errorResult(err);
        }
      }).catch(errorResult),
  );

  // Remediation is deliberately read-only over MCP: an agent may scan and dry-run, never branch,
  // push or open a PR. Those side effects need a human running the CLI (or the CI workflow).
  server.registerTool(
    'specguard_remediate',
    {
      description:
        'Scan for vulnerabilities (scan-only) or run the whole remediation loop in a throwaway worktree without committing, ' +
        'pushing or opening a PR (dry-run). Creating branches and PRs is only available from the CLI. (CLI: specguard remediate)',
      inputSchema: {
        mode: z.enum(['scan-only', 'dry-run']).optional().describe('scan-only (default) or dry-run. Nothing else is allowed over MCP.'),
        minSeverity: z.enum(['critical', 'high', 'moderate', 'low']).optional().describe('Lowest severity to report. Default high.'),
        advisory: z.string().optional().describe('Limit to one advisory id (GHSA/CVE/OSV).'),
        allowMajor: z.boolean().optional().describe('Allow a major version bump.'),
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    ({ mode, minSeverity, advisory, allowMajor, cwd }): Promise<ToolResult> =>
      withActivityLog('remediate', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runRemediate(config, {
          scanOnly: (mode ?? 'scan-only') === 'scan-only',
          dryRun: mode === 'dry-run',
          pr: false,
          minSeverity,
          advisory,
          allowMajor,
        });
        return toolResult(result);
      }).catch(errorResult),
  );

  // --- Functional specs, history, tests and security ------------------------

  server.registerTool(
    'specguard_check',
    {
      description:
        'Spec health for the whole system: owned files, tests, proofs, gaps, matrix or drift, from one trace model written to .specguard/trace.json (CLI: specguard check). The summary leads with each capability\'s proof statement (approved, testable, aligned, conforms; the `statement` field of the result). Start here when unsure what needs attention.',
      inputSchema: {
        view: z.enum(['summary', 'coverage', 'gaps', 'matrix', 'drift']).optional().describe('Default summary.'),
        spec: z.string().optional().describe('With drift: one capability id.'),
        since: z.string().optional().describe('With drift: git ref to diff against. With the summary: the base the proof statement judges changed claims, coverage and weakening against.'),
        explain: z.string().optional().describe('Capability id: return that capability\'s proof statement explained (each pillar, the blocking reasons with the command that fixes each, the advisory ones) instead of the summary.'),
        strict: z.boolean().optional().describe('Judge the proof statement as if every proof.require* gate were on.'),
        team: z.boolean().optional().describe('Also show what the team server has proven (CI), set against this working tree.'),
        cwd: z.string().optional(),
      },
    },
    ({ view, spec, since, explain, strict, team, cwd }): Promise<ToolResult> =>
      withActivityLog('check', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runCheck(config, { view, spec, since, explain, strict });
        if (team) result.messages.push(...(await teamLines(config)));
        return toolResult(result);
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_spec_graph',
    {
      description: 'The spec tree (system, capabilities, components) with the files each spec owns, and any rule violations (CLI: specguard spec graph).',
      inputSchema: { cwd: z.string().optional() },
    },
    ({ cwd }): Promise<ToolResult> =>
      withActivityLog('spec-graph', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        return toolResult(await runSpecGraph(config));
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_history_add',
    {
      description:
        'Record a prompt, approved plan or decision as requirement history under specs/history and link it from the capabilities it affects. Omit affects and the fast model proposes them (CLI: specguard history add).',
      inputSchema: {
        prompt: z.string().optional(),
        plan: z.string().optional().describe('The plan text, or a path to a file holding it.'),
        decision: z.string().optional(),
        title: z.string().optional(),
        affects: z.array(z.string()).optional().describe('Capability ids. Unknown ids fail and nothing is written.'),
        cwd: z.string().optional(),
      },
    },
    ({ prompt, plan, decision, title, affects, cwd }): Promise<ToolResult> =>
      withActivityLog('history-add', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        return toolResult(await runHistoryAdd(config, { prompt, plan, decision, title, affects, source: 'mcp' }));
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_history_log',
    {
      description: 'The requirement timeline, newest first, optionally for one capability (CLI: specguard history log).',
      inputSchema: { capability: z.string().optional(), cwd: z.string().optional() },
    },
    ({ capability, cwd }): Promise<ToolResult> =>
      withActivityLog('history-log', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        return toolResult(await runHistoryLog(config, { capability }));
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_agent_work',
    {
      description:
        'Model requests waiting for you, the host coding agent (llm.provider "host", or no API key while running inside an agent). ' +
        'action "list" returns each request in full (system, prompt, and for JSON requests the schema the answer must satisfy); ' +
        'action "answer" records your answer to one request by hash (JSON for object requests, text otherwise). ' +
        'Afterwards rerun the command that asked; exit code 12 means "waiting for the agent", not failure (CLI: specguard agent pending|answer).',
      inputSchema: {
        action: z.enum(['list', 'answer']),
        hash: z.string().optional().describe('answer: the request hash, or a unique prefix of 8 or more characters.'),
        answer: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional().describe('answer: the answer.'),
        cwd: z.string().optional(),
      },
    },
    ({ action, hash, answer, cwd }): Promise<ToolResult> =>
      withActivityLog('agent-work', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        const root = config.rootDir ?? resolveCwd(cwd);
        if (action === 'list') {
          const requests = listAgentRequests(root);
          return textResult(requests.length === 0 ? 'No model requests are waiting.' : JSON.stringify(requests, null, 2));
        }
        const full = hash ? resolveRequestHash(root, hash) : null;
        if (!full || !readAgentRequest(root, full)) return errorResult(new Error(`No single pending request matches "${hash ?? ''}". Use action "list".`));
        if (answer === undefined) return errorResult(new Error('answer is required with action "answer".'));
        const dir = config.llm.replay?.dir ?? path.join('.specguard', 'replay');
        answerAgentRequest(root, path.isAbsolute(dir) ? dir : path.resolve(root, dir), full, answer);
        return textResult(`Recorded the answer to ${full.slice(0, 12)}. Rerun the command that asked.`);
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_test_run',
    {
      description:
        'Run the configured tests and ingest the results into the proof ledger in one step; in a workspace, one unit, several, or only the affected ones (CLI: specguard test run).',
      inputSchema: {
        app: z.string().optional(),
        units: z.array(z.string()).optional().describe('Workspace units to run.'),
        affected: z.boolean().optional().describe('Only changed units and the units that depend on them.'),
        since: z.string().optional().describe('With affected: git ref to compare against.'),
        cwd: z.string().optional(),
      },
    },
    ({ app, units, affected, since, cwd }): Promise<ToolResult> =>
      withActivityLog('test-run', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        return toolResult(await runTestRun(config, { app, units, affected, since }));
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_security_scan',
    {
      description:
        'Scan dependencies, code and secrets, review each capability spec for security flaws that are missing or wrong requirements, and write a RemediationPlan to .specguard/security/plans (CLI: specguard security scan).',
      inputSchema: {
        minSeverity: z.enum(['critical', 'high', 'moderate', 'low']).optional(),
        noSpecReview: z.boolean().optional(),
        cwd: z.string().optional(),
      },
    },
    ({ minSeverity, noSpecReview, cwd }): Promise<ToolResult> =>
      withActivityLog('security-scan', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        return toolResult(await runSecurityScan(config, { minSeverity, noSpecReview }));
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_security_plan',
    {
      description:
        'List remediation plans, show one, or move an item through its lifecycle (open, planned, in-progress, fixed, verified, wont-fix) so an external system can report progress (CLI: specguard security plan).',
      inputSchema: {
        action: z.enum(['list', 'show', 'set-status']),
        plan: z.string().optional().describe('Plan id, or latest.'),
        item: z.string().optional(),
        status: z.string().optional(),
        note: z.string().optional(),
        by: z.string().optional(),
        externalRef: z.string().optional(),
        cwd: z.string().optional(),
      },
    },
    ({ action, plan, item, status, note, by, externalRef, cwd }): Promise<ToolResult> =>
      withActivityLog('security-plan', resolveCwd(cwd), async () => {
        const config = await loadConfig(resolveCwd(cwd));
        // Plans are shared state: through the team server when one answers, local files otherwise, and the result says which.
        if (action === 'list') return toolResult(await planList(config));
        if (action === 'show') return toolResult(await planShow(config, plan ?? 'latest'));
        if (!item || !status) return errorResult(new Error('set-status needs item and status'));
        return toolResult(await planSetStatus(config, plan ?? 'latest', item, status, { note, by, externalRef }));
      }).catch(errorResult),
  );

  // Tool modules of the later slices register through the same filtered method, so CORE_TOOLS and read-only mode apply to them.
  const ctx = { resolveCwd, withActivityLog };
  registerChangeTools(server, ctx);
  registerProofStoreTools(server, ctx);

  (server as { registerTool: unknown }).registerTool = register;
  return server;
}

/** Start the server on a stdio transport. Only called when run as main. */
async function main(): Promise<void> {
  const server = buildServer();
  // A plugin's command may write anything, so a read-only server offers none.
  if (!mcpReadOnly()) await registerPluginTools(server);
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
    console.error('[specguard-mcp] fatal:', err);
    process.exit(1);
  });
}
