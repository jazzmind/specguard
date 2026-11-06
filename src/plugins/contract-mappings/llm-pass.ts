/**
 * The model half of `contracts-map`: pick providers from a numbered catalogue. Nothing but the (redacted)
 * spec text or code excerpt and the catalogue is sent, and an answer outside the catalogue is rejected.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import path from 'node:path';

import { z } from 'zod';

import { llmGenerateObject } from '../../core/llm.js';
import { createSecretRedactor } from '../../core/redact.js';
import type { SpecGuardConfig } from '../../core/types.js';
import type { CatalogueSpec } from './catalogue.js';
import type { Suggestion } from './merge.js';

export const picksSchema = z.object({
  picks: z.array(
    z.object({
      providerId: z.union([z.number(), z.string()]),
      reason: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export type Picks = z.infer<typeof picksSchema>;

export const redact = (text: string): string => createSecretRedactor().text(text);

/** The notice printed before anything is sent, and the items that will be (the rest are over the cap). */
export function egressNotice<T>(
  what: string,
  sends: string,
  llm: SpecGuardConfig['llm'],
  items: T[],
  cap: number,
  label: (item: T) => string,
): { lines: string[]; sending: T[] } {
  const sending = items.slice(0, cap);
  const lines = [
    `${what}: ${sends} are sent to ${llm.provider}/${llm.model}, for at most ${cap} item(s) (--max-llm-specs).`,
    ...sending.map((i) => `  [send] ${label(i)}`),
    ...items.slice(cap).map((i) => `  [cap] ${label(i)}: not sent, the limit of ${cap} was reached`),
  ];
  return { lines, sending };
}

/** The catalogue as the prompt shows it: `1. Title (repo::path): summary`. */
export const catalogueText = (catalogue: CatalogueSpec[]): string =>
  catalogue.map((c, i) => `${i + 1}. ${c.title} (${c.repo}::${c.relPath})${c.summary ? `: ${c.summary}` : ''}`).join('\n');

const INSTRUCTIONS =
  'Decide which of the numbered provider specs the consumer below depends on (its API, data or screens). ' +
  'Answer with providerId set to the number from the list, a short reason and a confidence from 0 to 1. ' +
  'Pick nothing when none clearly applies. Do not invent providers that are not in the list.';

export function buildPrompt(subject: string, catalogue: CatalogueSpec[], extra = ''): string {
  return `${INSTRUCTIONS}\n\n${subject}\n${extra}\nProvider specs:\n${catalogueText(catalogue)}\n`;
}

/** Resolve a model's providerId to a catalogue entry: its number, or its `repo::path`. */
export function resolveProvider(id: number | string, catalogue: CatalogueSpec[]): CatalogueSpec | null {
  const n = typeof id === 'number' ? id : /^\s*\d+\s*$/.test(id) ? Number(id) : NaN;
  if (Number.isInteger(n)) return catalogue[n - 1] ?? null;
  return catalogue.find((c) => `${c.repo}::${c.relPath}` === String(id).trim()) ?? null;
}

/** One model call. Returns suggestions for the catalogue entries it picked; logs and drops the rest. */
export async function askCatalogue(opts: {
  llm: SpecGuardConfig['llm'];
  prompt: string;
  catalogue: CatalogueSpec[];
  consumerRepoAbs: string;
  evidence: string;
  minConfidence: number;
  log: (line: string) => void;
  label: string;
}): Promise<Suggestion[]> {
  const { llm, catalogue, log } = opts;
  let picks: Picks;
  try {
    picks = await llmGenerateObject({
      provider: llm.provider,
      model: llm.model,
      apiKeyEnv: llm.apiKeyEnv,
      prompt: opts.prompt,
      schema: picksSchema,
      maxTokens: 800,
      temperature: 0,
    });
  } catch (err) {
    log(`  [warn] ${opts.label}: the model call failed: ${(err as Error).message}`);
    return [];
  }
  const out: Suggestion[] = [];
  for (const pick of picks.picks) {
    const provider = resolveProvider(pick.providerId, catalogue);
    if (!provider) {
      log(`  [reject] ${opts.label}: the model named "${String(pick.providerId)}", which is not in the catalogue`);
      continue;
    }
    if (pick.confidence < opts.minConfidence) continue;
    out.push({
      provider: path.relative(opts.consumerRepoAbs, provider.abs).split(path.sep).join('/'),
      source: 'llm',
      confidence: Math.round(pick.confidence * 100) / 100,
      reason: pick.reason.slice(0, 300),
      evidence: opts.evidence,
    });
  }
  return out;
}
