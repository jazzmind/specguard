/**
 * MCP tools of the proof store: `specguard_proof_fetch` (writes git refs only, never the working tree). There is no
 * publish tool: an agent cannot write proof notes.
 *
 * The tool name is in CORE_TOOLS and WRITE_TOOLS, so a read-only server does not offer it.
 *
 * Spec: specs/capabilities/proof-store.md
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadConfig } from '../../core/config.js';
import { runProofFetch } from '../../pipelines/proof-store-cmd.js';
import { errorResult, toolResult, type ToolResult } from '../format.js';
import type { McpToolContext } from './context.js';

export function registerProofStoreTools(server: McpServer, ctx: McpToolContext): void {
  const { resolveCwd, withActivityLog } = ctx;

  server.registerTool(
    'specguard_proof_fetch',
    {
      description:
        'Fetch the CI proof notes (refs/notes/specguard) from the remote so check and proof status see what CI proved. ' +
        'Writes git refs only, never the working tree; it cannot publish a note. (CLI: specguard proof fetch)',
      inputSchema: {
        ifOlder: z.string().optional().describe('Skip when the last fetch is younger than this duration (30s, 10m, 2h, 1d).'),
        cwd: z.string().optional().describe('Repo directory containing .specguard/config.json.'),
      },
    },
    ({ ifOlder, cwd }): Promise<ToolResult> =>
      withActivityLog('proof-fetch', resolveCwd(cwd), async () => toolResult(await runProofFetch(await loadConfig(resolveCwd(cwd)), { ...(ifOlder ? { ifOlder } : {}) }))).catch(errorResult),
  );
}
