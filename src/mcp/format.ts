/**
 * Result formatting helpers for the SpecGuard MCP server.
 *
 * Kept in their own module (free of SDK / transport imports) so they can be
 * unit-tested without spinning up an MCP server.
 */
import type { PipelineResult } from '../core/types.js';

/** An MCP text content block. */
export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * The shape every tool handler returns. The index signature keeps it
 * structurally compatible with the MCP SDK's `CallToolResult`.
 */
export interface ToolResult {
  content: TextContent[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Render a `PipelineResult` into a human-readable text summary: a header line
 * with the counts and suggested exit code, followed by the pipeline's own
 * message lines, followed by per-item detail. The raw JSON is appended so
 * machine consumers can parse it too.
 */
export function formatResult(result: PipelineResult): string {
  const lines: string[] = [];
  lines.push(
    `[${result.pipeline}] created=${result.created} updated=${result.updated} ` +
      `skipped=${result.skipped} failed=${result.failed} exitCode=${result.exitCode}`,
  );

  if (result.messages.length > 0) {
    lines.push('', ...result.messages);
  }

  if (result.items.length > 0) {
    lines.push('', 'Items:');
    for (const item of result.items) {
      const suffix = item.message ? ` — ${item.message}` : '';
      const where = item.path ? ` (${item.path})` : '';
      lines.push(`  - ${item.key}: ${item.status}${where}${suffix}`);
    }
  }

  lines.push('', 'Raw result:', JSON.stringify(result, null, 2));
  return lines.join('\n');
}

/** Build a successful tool result from a pipeline result. */
export function toolResult(result: PipelineResult): ToolResult {
  return {
    content: [{ type: 'text', text: formatResult(result) }],
    isError: result.failed > 0 ? undefined : undefined,
  };
}

/** Build a plain text tool result (utility tools, stubs). */
export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Build an error tool result from a thrown value. */
export function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
