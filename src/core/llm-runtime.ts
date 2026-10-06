/**
 * Process-wide LLM runtime: the loaded `llm` config, the pipeline name for the
 * current command, and the spend of this run. Kept apart from `llm.ts` so that
 * loading a config never needs the AI SDK.
 *
 * Spec: specs/core/llm.md
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { LlmConfig } from './types.js';

export interface LlmRuntime {
  rootDir: string;
  llm: LlmConfig;
}

export interface RunSpend {
  calls: number;
  tokens: number;
  usd: number;
}

let runtime: LlmRuntime | null = null;
let defaultPipeline: string | undefined;
let recordOverride: boolean | undefined;
let spend: RunSpend = { calls: 0, tokens: 0, usd: 0 };
let budgetMessage: string | null = null;

const pipelineStore = new AsyncLocalStorage<{ pipeline: string }>();

/** Called by `loadConfig`. The last config loaded in the process wins. */
export function configureLlm(next: LlmRuntime): void {
  runtime = next;
}

export function getLlmRuntime(): LlmRuntime | null {
  return runtime;
}

/** Forget everything (tests). */
export function resetLlmRuntime(): void {
  runtime = null;
  defaultPipeline = undefined;
  recordOverride = undefined;
  spend = { calls: 0, tokens: 0, usd: 0 };
  budgetMessage = null;
}

/** Pipeline name for LLM calls made inside `fn` (the MCP server uses this per tool call). */
export function runWithPipeline<T>(pipeline: string, fn: () => T): T {
  return pipelineStore.run({ pipeline }, fn);
}

/** The CLI sets this once from the command name. */
export function setDefaultPipeline(name: string | undefined): void {
  defaultPipeline = name;
}

export function currentPipeline(): string {
  return pipelineStore.getStore()?.pipeline ?? defaultPipeline ?? 'unknown';
}

/** `--record`: force record mode on (or off) regardless of config. */
export function setRecordMode(value: boolean | undefined): void {
  recordOverride = value;
}

export function recordMode(): boolean {
  return recordOverride ?? runtime?.llm.replay?.record ?? false;
}

export function runSpend(): RunSpend {
  return spend;
}

export function addRunSpend(delta: Partial<RunSpend>): void {
  spend = { calls: spend.calls + (delta.calls ?? 0), tokens: spend.tokens + (delta.tokens ?? 0), usd: spend.usd + (delta.usd ?? 0) };
}

/** Set when a call was refused for budget; the CLI turns it into exit code 8. */
export function markBudgetExceeded(message: string): void {
  budgetMessage ??= message;
}

export function budgetExceededMessage(): string | null {
  return budgetMessage;
}
