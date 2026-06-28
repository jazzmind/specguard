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

import { errorResult, textResult, toolResult, type ToolResult } from './format.js';

const SERVER_NAME = 'specguard-mcp';
const SERVER_VERSION = '0.1.0';

/** Resolve the working directory a tool should load config from. */
function resolveCwd(cwd?: string): string {
  return cwd ? path.resolve(cwd) : process.cwd();
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
    async ({ app, file, force, cwd }): Promise<ToolResult> => {
      try {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runReverseGenerate(config, { app, file, force });
        return toolResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
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
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    async ({ spec, all, framework, app, force, cwd }): Promise<ToolResult> => {
      try {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runForwardGenerate(config, { spec, all, framework, app, force });
        return toolResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ spec, all, maxRetries, cwd }): Promise<ToolResult> => {
      try {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runHeal(config, { spec, all, maxRetries });
        return toolResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'specguard_status',
    {
      description: 'Report spec/test coverage across configured apps (CLI: specguard status).',
      inputSchema: {
        cwd: z.string().optional().describe('Directory to load .specguard/config.json from.'),
      },
    },
    async ({ cwd }): Promise<ToolResult> => {
      try {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runStatus(config);
        return toolResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ since, spec, cwd }): Promise<ToolResult> => {
      try {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runDrift(config, { since, spec });
        return toolResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ spec, all, withSast, cwd }): Promise<ToolResult> => {
      try {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runSecurity(config, { spec, all, withSast });
        return toolResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ spec, all, out, cwd }): Promise<ToolResult> => {
      try {
        const config = await loadConfig(resolveCwd(cwd));
        const result = await runDocGenerate(config, { spec, all, out });
        return toolResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Stub tools (not yet backed by a pipeline; mirror the CLI stubs) ------

  server.registerTool(
    'specguard_validate',
    {
      description: 'Validate specs against the running app (CLI: specguard validate). Not yet implemented.',
      inputSchema: {
        spec: z.string().optional(),
        all: z.boolean().optional(),
        url: z.string().optional(),
        auth: z.string().optional(),
        out: z.string().optional(),
        cwd: z.string().optional(),
      },
    },
    async (): Promise<ToolResult> =>
      textResult('specguard_validate is not yet implemented (pipeline pending).'),
  );

  server.registerTool(
    'specguard_matrix',
    {
      description:
        'Generate the requirement-to-test traceability matrix (CLI: specguard matrix). Not yet implemented.',
      inputSchema: {
        out: z.string().optional(),
        format: z.string().optional(),
        cwd: z.string().optional(),
      },
    },
    async (): Promise<ToolResult> =>
      textResult('specguard_matrix is not yet implemented (pipeline pending).'),
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
