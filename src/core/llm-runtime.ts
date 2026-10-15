/**
 * LLM runtime: the loaded `llm` config, the pipeline name for the current
 * command, and the spend of this run. A CLI process has one of each. A server
 * handling many projects and requests wraps each request in `runWithLlmScope`,
 * which gives it its own config, spend, budget and user, so one request can
 * neither spend another's budget nor reset its count. Kept apart from `llm.ts`
 * so that loading a config never needs the AI SDK.
 *
 * Spec: specs/capabilities/platform-foundation.md
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

/** One call's usage, as reported to a scope's `onUsage`. */
export interface UsageEvent {
  pipeline: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  /** True when the model has no known price, so `estimatedUsd` is 0 by default rather than measured. */
  unpriced: boolean;
  user?: string;
}

export interface LlmScope {
  /** Config for calls in this scope; default: the process-wide one. */
  runtime?: LlmRuntime;
  /** Who the calls are for. Sent to the provider so a gateway can attribute spend. */
  user?: string;
  /** Labels sent to the gateway with every call (for example the project). */
  tags?: string[];
  /** Called after every successful call. */
  onUsage?: (usage: UsageEvent) => void;
}

interface ScopeState extends LlmScope {
  spend: RunSpend;
  budgetMessage: string | null;
}

const scopeStore = new AsyncLocalStorage<ScopeState>();

/**
 * Run `fn` with its own spend count, budget and (optionally) config and user. Everything `fn` starts
 * inherits the scope; a scope inside a scope starts a new one.
 */
export function runWithLlmScope<T>(scope: LlmScope, fn: () => T): T {
  return scopeStore.run({ ...scope, spend: { calls: 0, tokens: 0, usd: 0 }, budgetMessage: null }, fn);
}

export function currentLlmScope(): LlmScope | undefined {
  return scopeStore.getStore();
}

/** Called by `loadConfig`. The last config loaded in the process wins. */
export function configureLlm(next: LlmRuntime): void {
  runtime = next;
}

export function getLlmRuntime(): LlmRuntime | null {
  return scopeStore.getStore()?.runtime ?? runtime;
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
  return scopeStore.getStore()?.spend ?? spend;
}

/**
 * Start a fresh spend count. A CLI run counts spend once for the whole process;
 * a long-lived `serve` process applies `llm.budget` per generation instead,
 * or it would refuse every request once the process total reached the cap.
 */
export function resetRunSpend(): void {
  const scope = scopeStore.getStore();
  if (scope) {
    scope.spend = { calls: 0, tokens: 0, usd: 0 };
    scope.budgetMessage = null;
    return;
  }
  spend = { calls: 0, tokens: 0, usd: 0 };
  budgetMessage = null;
}

export function addRunSpend(delta: Partial<RunSpend>): void {
  const scope = scopeStore.getStore();
  if (scope) {
    scope.spend = {
      calls: scope.spend.calls + (delta.calls ?? 0),
      tokens: scope.spend.tokens + (delta.tokens ?? 0),
      usd: scope.spend.usd + (delta.usd ?? 0),
    };
    return;
  }
  spend = { calls: spend.calls + (delta.calls ?? 0), tokens: spend.tokens + (delta.tokens ?? 0), usd: spend.usd + (delta.usd ?? 0) };
}

/** Set when a call was refused for budget; the CLI turns it into exit code 8. */
export function markBudgetExceeded(message: string): void {
  const scope = scopeStore.getStore();
  if (scope) scope.budgetMessage ??= message;
  else budgetMessage ??= message;
}

export function budgetExceededMessage(): string | null {
  const scope = scopeStore.getStore();
  return scope ? scope.budgetMessage : budgetMessage;
}
