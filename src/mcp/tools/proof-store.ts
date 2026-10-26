/**
 * MCP tools of the proof store: `specguard_proof_fetch` (writes git refs only, never the working tree). There is no
 * publish tool: an agent cannot write proof notes.
 *
 * Spec: specs/capabilities/proof-store.md
 * Contract: the registration function's signature is frozen; Slice I (proof store) fills in the body and adds the tool
 * name to CORE_TOOLS together with the cap change in tests/pipelines/plugin-manage.test.ts.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpToolContext } from './context.js';

export function registerProofStoreTools(_server: McpServer, _ctx: McpToolContext): void {
  // Slice I (proof store) registers the tools here.
}
