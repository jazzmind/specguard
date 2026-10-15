/**
 * `specguard spec graph`: print the spec tree with the files each spec owns,
 * and fail on v2 rule violations. Later phases build `check` on the same graph.
 *
 * Spec: specs/capabilities/spec-authoring.md
 */
import { ExitCode } from '../core/exit-codes.js';
import { buildSpecGraph, type SpecNode } from '../core/spec-graph.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';

export async function runSpecGraph(config: SpecGuardConfig): Promise<PipelineResult> {
  const result = emptyResult('spec-graph');
  const graph = await buildSpecGraph(config, { warn: (m) => result.messages.push(m) });

  const line = (node: SpecNode, depth: number): void => {
    const owns = node.kind ? `${node.ownedFiles.length} file(s)` : 'v1';
    const claims = node.spec.claims.filter((c) => c.id).length;
    result.messages.push(`${'  '.repeat(depth)}${node.id} [${node.kind ?? 'v1'}] ${owns}, ${claims} claim(s)`);
    for (const childId of node.children) {
      const child = graph.nodes.get(childId);
      if (child) line(child, depth + 1);
    }
  };

  const placed = new Set<string>();
  const mark = (node: SpecNode): void => {
    placed.add(node.id);
    node.children.forEach((c) => graph.nodes.get(c) && mark(graph.nodes.get(c)!));
  };
  if (graph.system) {
    line(graph.system, 0);
    mark(graph.system);
  }
  const rest = [...graph.nodes.values()].filter((n) => !placed.has(n.id)).sort((a, b) => a.id.localeCompare(b.id));
  for (const node of rest) line(node, 0);

  for (const issue of graph.issues) {
    result.messages.push(`  [${issue.level === 'error' ? 'error' : 'warn'}] ${issue.code}: ${issue.message}`);
    result.items.push({ key: issue.spec ?? issue.code, status: issue.level === 'error' ? 'failed' : 'skipped', message: issue.message });
    if (issue.level === 'error') result.failed += 1;
    else result.skipped += 1;
  }
  result.created = graph.nodes.size;
  if (result.failed > 0) result.exitCode = ExitCode.ValidationFailed;
  return result;
}
