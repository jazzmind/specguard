/**
 * MCP tools of the change protocol: `specguard_change_start`, `specguard_change_red`, `specguard_change_green`
 * (write tools) and `specguard_change_status`, `specguard_change_report` (read-only). `convert`, `done --force` and
 * `abandon` stay CLI-only, because they change what CI will accept.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: the registration function's signature is frozen; Slice J (change pipeline) fills in the body, adds the tool
 * names to CORE_TOOLS (and the write ones to WRITE_TOOLS), and raises the CORE_TOOLS cap in tests/pipelines/plugin-manage.test.ts.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpToolContext } from './context.js';

export function registerChangeTools(_server: McpServer, _ctx: McpToolContext): void {
  // Slice J (change pipeline) registers the tools here.
}
