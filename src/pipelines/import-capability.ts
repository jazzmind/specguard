/**
 * `specguard import <file> --capability <id>`: add what an external requirements document
 * says to an existing capability spec.
 *
 * The model proposes only requirements the capability does not already state. Without `--yes`
 * the proposal is printed and nothing is written. With it, the bullets are appended to the
 * capability's `## Requirements` section with claim anchors, and a history entry records
 * where they came from.
 *
 * Spec: specs/capabilities/spec-authoring.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { normalizeClaimId } from '../core/claim-migration.js';
import { ExitCode } from '../core/exit-codes.js';
import { llmGenerateObject } from '../core/llm.js';
import { readFile } from '../core/reader.js';
import { buildSpecGraph } from '../core/spec-graph.js';
import { specsRootDir } from '../core/spec-key.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { writeFile } from '../core/writer.js';
import { writeHistory } from './history.js';
import { fetchUrl } from './import.js';

export interface ImportIntoCapabilityOpts {
  /** File path or http(s) URL. */
  source: string;
  /** Capability id to extend. */
  capability: string;
  /** Write the proposed requirements. Without it the proposal is only printed. */
  yes?: boolean;
  /** Skip the requirement-history entry. */
  noHistory?: boolean;
}

const MAX_SOURCE_CHARS = 48_000;

const AdditionsSchema = z.object({
  additions: z
    .array(
      z.object({
        text: z.string().describe('One testable requirement, one sentence, in the document\'s own terms.'),
        id: z.string().describe('Short kebab-case id for the requirement.'),
        basis: z.string().describe('The part of the document it comes from, in a few words.'),
      }),
    )
    .describe('Requirements the document states that the capability does not already cover. Empty when there are none.'),
  alreadyCovered: z.array(z.string()).describe('Statements in the document that the capability already covers.'),
  elsewhere: z.array(z.string()).describe('Statements that belong to another capability or to no capability.'),
});

const SYSTEM = [
  'You extend an existing capability spec with requirements from an external document.',
  'Propose a requirement only when the document states it AND the capability\'s current requirements do not already cover it.',
  'Each requirement is one testable sentence. Do not invent requirements the document does not state.',
  'Put statements that belong to a different capability, or to none, under `elsewhere`.',
].join(' ');

/** Insert `bullets` at the end of the `## Requirements` section (creating it before `## Scenarios` or at the end). */
export function appendRequirements(markdown: string, bullets: string[]): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^##\s+(Requirements|Acceptance Criteria)\s*$/i.test(l));
  if (start === -1) return `${markdown.replace(/\s*$/, '')}\n\n## Requirements\n\n${bullets.join('\n')}\n`;
  let end = lines.findIndex((l, i) => i > start && /^##\s+/.test(l));
  if (end === -1) end = lines.length;
  // Keep the blank line that separates this section from the next one.
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === '') at -= 1;
  return [...lines.slice(0, at), ...bullets, ...lines.slice(at)].join('\n');
}

export async function runImportIntoCapability(config: SpecGuardConfig, opts: ImportIntoCapabilityOpts): Promise<PipelineResult> {
  const result = emptyResult('import');
  const log = (line: string): void => void result.messages.push(line);
  const fail = (message: string, code: number = ExitCode.InternalError): PipelineResult => {
    result.failed = 1;
    result.exitCode = code;
    log(message);
    return result;
  };
  const root = config.rootDir ?? process.cwd();

  const graph = await buildSpecGraph(config);
  const node = graph.nodes.get(opts.capability);
  if (!node) return fail(`no capability "${opts.capability}". Known: ${[...graph.nodes.keys()].join(', ') || '(none)'}`, ExitCode.ValidationFailed);

  let doc: string;
  try {
    const isUrl = /^https?:\/\//.test(opts.source);
    doc = isUrl ? await fetchUrl(opts.source) : await readFile(path.resolve(root, opts.source));
  } catch (err) {
    return fail(`could not load ${opts.source}: ${(err as Error).message}`);
  }

  const known = new Set(node.spec.claims.map((c) => c.id).filter((id): id is string => Boolean(id)));
  const proposal = await llmGenerateObject({
    provider: config.llm.provider,
    model: config.llm.model,
    apiKeyEnv: config.llm.apiKeyEnv,
    pipeline: 'import',
    system: SYSTEM,
    prompt: [
      `Capability: ${node.spec.title || node.id} (${node.id})`,
      `## Problem & Value\n${node.spec.sections['Problem & Value']?.trim() || node.spec.overview}`,
      `## Current requirements\n${node.spec.claims.map((c) => `- ${c.id ?? '(no id)'}: ${c.text}`).join('\n') || '(none)'}`,
      `## Document (${path.basename(opts.source)})\n${doc.slice(0, MAX_SOURCE_CHARS)}`,
    ].join('\n\n'),
    schema: AdditionsSchema,
  });

  // Ids are made valid and unique against what the capability already has, so a clash never overwrites a claim.
  const additions: Array<{ id: string; text: string; basis: string }> = [];
  const existingText = new Set(node.spec.claims.map((c) => c.text.trim().toLowerCase()));
  for (const a of proposal.additions) {
    const text = a.text.trim().replace(/\s+/g, ' ');
    if (!text || existingText.has(text.toLowerCase())) continue;
    let id = normalizeClaimId(a.id || text);
    for (let n = 2; known.has(id) || additions.some((x) => x.id === id); n += 1) id = `${normalizeClaimId(a.id || text).slice(0, 44)}-${n}`;
    additions.push({ id, text, basis: a.basis });
    existingText.add(text.toLowerCase());
  }

  log(`[import] ${node.id}: ${additions.length} new requirement(s) from ${path.basename(opts.source)}; ${proposal.alreadyCovered.length} already covered, ${proposal.elsewhere.length} belong elsewhere`);
  for (const a of additions) log(`  + ${a.id}: ${a.text}`);
  for (const e of proposal.elsewhere) log(`  ? elsewhere: ${e}`);
  if (additions.length === 0) {
    result.skipped = 1;
    return result;
  }
  if (!opts.yes) {
    log('Nothing written. Rerun with --yes to add these to the spec.');
    result.skipped = additions.length;
    return result;
  }

  const file = path.join(specsRootDir(config), `${node.specKey}.md`);
  if (!fs.existsSync(file)) return fail(`spec file for ${node.id} not found at ${path.relative(root, file)}`);
  const before = await readFile(file);
  await writeFile(file, appendRequirements(before, additions.map((a) => `- [ ] ${a.text} <!-- claim: ${a.id} -->`)));
  result.updated = additions.length;
  for (const a of additions) result.items.push({ key: `${node.specKey}#${a.id}`, status: 'updated', message: a.text });

  if (!opts.noHistory) {
    const id = await writeHistory(config, {
      kind: 'import',
      title: `Import requirements from ${path.basename(opts.source)}`,
      decision: [`Added ${additions.length} requirement(s) to ${node.id} from ${opts.source}:`, ...additions.map((a) => `- ${a.id}: ${a.text} (${a.basis})`)].join('\n'),
      affects: [node.id],
      source: 'import',
    });
    log(`recorded requirement history ${id}`);
  }
  return result;
}
