/**
 * What `buildServer` hands each tool-registration module: the two helpers every tool uses (the working directory a
 * call loads config from, and the activity log with the call-rate limit), so a tool module does not import
 * `server.ts` and so create a cycle.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import type { ToolResult } from '../format.js';

export interface McpToolContext {
  /** The directory a tool loads `.specguard/config.json` from: the given `cwd`, else the process's. */
  resolveCwd(cwd?: string): string;
  /** Run a tool body under the rate limit and the activity log, as every built-in tool does. */
  withActivityLog(pipeline: string, cwd: string, fn: () => Promise<ToolResult>): Promise<ToolResult>;
}
