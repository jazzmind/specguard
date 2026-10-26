/**
 * MCP tools of the change protocol: `specguard_change_start`, `specguard_change_red`, `specguard_change_green`
 * (write tools) and `specguard_change_status`, `specguard_change_report` (read-only). `convert`, `done --force` and
 * `abandon` stay CLI-only, because they change what CI will accept. No tool approves anything: approving is a person's
 * `specguard spec approve`.
 *
 * The tool names are in CORE_TOOLS (and the write ones in WRITE_TOOLS), so a read-only server offers only status and report.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadConfig } from '../../core/config.js';
import { buildChangePacket, changeStatuses, runChangeStart } from '../../pipelines/change.js';
import { runChangeGreen, runChangeRed } from '../../pipelines/change-run.js';
import { errorResult, textResult, toolResult, type ToolResult } from '../format.js';
import type { McpToolContext } from './context.js';

const CWD = z.string().optional().describe('Directory to load .specguard/config.json from.');
const ID = z.string().optional().describe('Change id (or a unique part of it); the only open change on the branch when omitted.');
const BASE = z.string().optional().describe('Base ref to compare against (default: the change record\'s, then origin/HEAD, origin/main, main, master).');

export function registerChangeTools(server: McpServer, ctx: McpToolContext): void {
  const { resolveCwd, withActivityLog } = ctx;

  server.registerTool(
    'specguard_change_start',
    {
      description:
        'Open a spec-first change for capabilities (CLI: specguard change start). Order: edit the requirements, a person approves them (you never approve), tag tests, change red, write code, change green.',
      inputSchema: {
        capabilities: z.array(z.string()).min(1).describe('Capability ids.'),
        kind: z.enum(['feature', 'refactor', 'spike']).optional().describe('feature (default), refactor (no requirement changes) or spike (code first, cannot merge).'),
        why: z.string().optional().describe('What the change is for.'),
        base: BASE,
        plan: z.string().optional().describe('History entry id of an approved plan to link.'),
        cwd: CWD,
      },
    },
    ({ capabilities, kind, why, base, plan, cwd }): Promise<ToolResult> =>
      withActivityLog('change-start', resolveCwd(cwd), async () => toolResult(await runChangeStart(await loadConfig(resolveCwd(cwd)), { capabilities, kind, why, base, plan }))).catch(errorResult),
  );

  server.registerTool(
    'specguard_change_red',
    {
      description: 'Run exactly the tests of the change\'s changed requirements against the base code and record the run (CLI: specguard change red). Provisional: CI re-proves red.',
      inputSchema: { id: ID, base: BASE, cwd: CWD },
    },
    ({ id, base, cwd }): Promise<ToolResult> =>
      withActivityLog('change-red', resolveCwd(cwd), async () => toolResult(await runChangeRed(await loadConfig(resolveCwd(cwd)), { id, base }))).catch(errorResult),
  );

  server.registerTool(
    'specguard_change_green',
    {
      description: 'Run the tests of the change\'s changed requirements against the current code and record the run (CLI: specguard change green).',
      inputSchema: { id: ID, base: BASE, cwd: CWD },
    },
    ({ id, base, cwd }): Promise<ToolResult> =>
      withActivityLog('change-green', resolveCwd(cwd), async () => toolResult(await runChangeGreen(await loadConfig(resolveCwd(cwd)), { id, base }))).catch(errorResult),
  );

  server.registerTool(
    'specguard_change_status',
    {
      description: 'Where a change stands (spec, tests, red, code, green, validated), detected from git, specs, tests and run records, with the blocks and the one next step (CLI: specguard change status --json).',
      inputSchema: { id: ID, base: BASE, cwd: CWD },
    },
    ({ id, base, cwd }): Promise<ToolResult> =>
      withActivityLog('change-status', resolveCwd(cwd), async () => {
        const got = await changeStatuses(await loadConfig(resolveCwd(cwd)), { id, base });
        if (!got.ok) return errorResult(new Error(got.error));
        return textResult(JSON.stringify({ changes: got.changes, errors: got.errors }, null, 2));
      }).catch(errorResult),
  );

  server.registerTool(
    'specguard_change_report',
    {
      description: 'The PR proof packet built locally and marked provisional: requirements that changed, evidence, weakened tests, unrequested code (CLI: specguard change report). Markdown, then the packet JSON.',
      inputSchema: { id: ID, base: BASE, cwd: CWD },
    },
    ({ id, base, cwd }): Promise<ToolResult> =>
      withActivityLog('change-report', resolveCwd(cwd), async () => {
        const built = await buildChangePacket(await loadConfig(resolveCwd(cwd)), { id, base });
        if (!built.ok) return errorResult(new Error(built.error));
        return textResult(`${built.markdown}\n\n${JSON.stringify(built.packet, null, 2)}`);
      }).catch(errorResult),
  );
}
