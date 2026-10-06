/**
 * LLM usage accounting: pricing table, cost estimate, and the usage log.
 *
 * Spec: specs/core/llm.md
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { LlmPrice } from './types.js';

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  /** Calls whose model had no price, so their cost counts as zero. */
  unpricedCalls: number;
  /** Calls served from recordings (no tokens, no cost). */
  replayedCalls: number;
}

export interface UsageLog {
  version: 1;
  updatedAt: string;
  totals: UsageTotals;
  byPipeline: Record<string, UsageTotals>;
  byModel: Record<string, UsageTotals>;
}

export const USAGE_FILE = 'llm-usage.json';

const BUILT_IN_PRICES: Array<{ match: RegExp; price: LlmPrice }> = [
  // Estimates in USD per million tokens. Override with `llm.pricing`.
  { match: /opus/i, price: { inputPerMTok: 15, outputPerMTok: 75 } },
  { match: /sonnet/i, price: { inputPerMTok: 3, outputPerMTok: 15 } },
  { match: /haiku/i, price: { inputPerMTok: 1, outputPerMTok: 5 } },
  { match: /gpt-4o-mini/i, price: { inputPerMTok: 0.15, outputPerMTok: 0.6 } },
  { match: /gpt-4o/i, price: { inputPerMTok: 2.5, outputPerMTok: 10 } },
  { match: /gpt-4\.1-mini/i, price: { inputPerMTok: 0.4, outputPerMTok: 1.6 } },
  { match: /gpt-4\.1/i, price: { inputPerMTok: 2, outputPerMTok: 8 } },
];

/** Price for a model: config override first, then the built-in table, else undefined. */
export function priceFor(model: string, overrides?: Record<string, LlmPrice>): LlmPrice | undefined {
  if (overrides?.[model]) return overrides[model];
  return BUILT_IN_PRICES.find((entry) => entry.match.test(model))?.price;
}

export function estimateUsd(inputTokens: number, outputTokens: number, price: LlmPrice | undefined): number {
  if (!price) return 0;
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
}

export function emptyTotals(): UsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0, unpricedCalls: 0, replayedCalls: 0 };
}

export function emptyUsageLog(): UsageLog {
  return { version: 1, updatedAt: new Date().toISOString(), totals: emptyTotals(), byPipeline: {}, byModel: {} };
}

function add(into: UsageTotals, delta: Partial<UsageTotals>): void {
  into.calls += delta.calls ?? 0;
  into.inputTokens += delta.inputTokens ?? 0;
  into.outputTokens += delta.outputTokens ?? 0;
  into.estimatedUsd = Math.round((into.estimatedUsd + (delta.estimatedUsd ?? 0)) * 1e8) / 1e8;
  into.unpricedCalls += delta.unpricedCalls ?? 0;
  into.replayedCalls += delta.replayedCalls ?? 0;
}

export function usagePath(rootDir: string): string {
  return path.join(rootDir, '.specguard', USAGE_FILE);
}

export function readUsageLog(rootDir: string): UsageLog {
  try {
    const parsed = JSON.parse(readFileSync(usagePath(rootDir), 'utf8')) as UsageLog;
    if (parsed?.version === 1 && parsed.totals) return parsed;
  } catch {
    /* missing or corrupt: start fresh */
  }
  return emptyUsageLog();
}

/** Add one call's usage to the log on disk. Best-effort: accounting must never fail a call. */
export function recordUsage(rootDir: string, pipeline: string, model: string, delta: Partial<UsageTotals>): void {
  try {
    const log = readUsageLog(rootDir);
    add(log.totals, delta);
    add((log.byPipeline[pipeline] ??= emptyTotals()), delta);
    add((log.byModel[model] ??= emptyTotals()), delta);
    log.updatedAt = new Date().toISOString();
    const file = usagePath(rootDir);
    if (!existsSync(path.dirname(file))) mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(log, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    /* ignore */
  }
}
