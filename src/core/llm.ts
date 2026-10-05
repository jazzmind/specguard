/**
 * LLM adapter — the single chokepoint for all LLM access in SpecGuard.
 *
 * Pipelines MUST route through `llmGenerateText` / `llmGenerateObject` rather
 * than importing `ai` or provider SDKs directly. This module selects the
 * provider from config and resolves the API key from the environment, and adds:
 * per-pipeline model overrides, a fallback chain, timeout and retry with
 * backoff, a usage log, a hard spend cap, and a replay provider so CI and tests
 * run deterministically and offline.
 *
 * Security: the resolved API key value is never logged or included in any
 * error message — only the *name* of the env var may appear in diagnostics.
 *
 * Spec: specs/core/llm.md
 */

import { generateText, generateObject, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import path from 'node:path';
import type { ZodType } from 'zod';

import { SpecGuardError } from './errors.js';
import { ExitCode } from './exit-codes.js';
import { loadReplay, previewOf, replayKey, saveReplay, type ReplayKind } from './llm-replay.js';
import {
  addRunSpend,
  currentPipeline,
  getLlmRuntime,
  markBudgetExceeded,
  recordMode,
  runSpend,
} from './llm-runtime.js';
import { estimateUsd, priceFor, recordUsage } from './llm-usage.js';
import type { LlmTarget } from './types.js';

export {
  configureLlm,
  resetLlmRuntime,
  runWithPipeline,
  setDefaultPipeline,
  setRecordMode,
  budgetExceededMessage,
} from './llm-runtime.js';

/** Options shared by all LLM generation calls. */
export interface LlmTextOpts {
  provider: string;
  model: string;
  system?: string;
  prompt: string;
  /** Name of the env var holding the API key. The value is never logged. */
  apiKeyEnv: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Optional image buffers (PNG/JPEG) sent as multimodal content alongside the
   * text prompt. When present the call switches from `prompt:` to `messages:`
   * so the images precede the text in the user turn, matching vision model
   * expectations (Anthropic, OpenAI gpt-4o).
   *
   * LiteLLM passthrough: multimodal support depends on the proxied model.
   */
  images?: Buffer[];
  /** Pipeline name for overrides and the usage log. Default: the running command. */
  pipeline?: string;
}

/** Options for schema-validated structured generation. */
export interface LlmObjectOpts<T> extends LlmTextOpts {
  schema: ZodType<T>;
}

/** Thrown for every call once `llm.budget` is reached. The CLI exits with code 8. */
export class LlmBudgetExceededError extends SpecGuardError {
  constructor(message: string) {
    super(message, ExitCode.BudgetExceeded);
    this.name = 'LlmBudgetExceededError';
  }
}

/** Thrown when `provider` is `none`: the run is deterministic-only. */
export class LlmDisabledError extends SpecGuardError {
  constructor(what = 'this step') {
    super(
      `The LLM is disabled (llm.provider is "none"), so ${what} cannot run. ` +
        'Use a deterministic-only command, or set llm.provider to a real provider or "replay".',
      ExitCode.InternalError,
    );
    this.name = 'LlmDisabledError';
  }
}

/** Thrown by the replay provider when no recording matches the request. */
export class ReplayMissError extends SpecGuardError {
  constructor(public readonly hash: string, dir: string) {
    super(
      `No recorded LLM response for request ${hash.slice(0, 16)} in ${dir}. ` +
        'Re-run once with --record and a real provider to record it.',
      ExitCode.InternalError,
    );
    this.name = 'ReplayMissError';
  }
}

/**
 * Build an ai-sdk model instance for the given provider, resolving the API key
 * from `process.env[apiKeyEnv]`.
 *
 * Exported so the missing-key path is unit-testable. Throws `SpecGuardError`
 * when the env var is unset/empty or the provider is unknown. The thrown
 * message never contains the key value.
 */
export function resolveModel(provider: string, model: string, apiKeyEnv: string): LanguageModel {
  const apiKey = process.env[apiKeyEnv];

  if (provider === 'none') throw new LlmDisabledError();
  if (provider === 'replay') {
    throw new SpecGuardError('The replay provider serves recordings and has no model.', ExitCode.InternalError);
  }

  // LiteLLM is a local server — API key may not be required.
  if (provider !== 'litellm' && !apiKey) {
    throw new SpecGuardError(
      `Missing API key: environment variable \`${apiKeyEnv}\` is not set or empty. ` +
        `Set it to your ${provider} API key.`,
      ExitCode.InternalError,
    );
  }

  switch (provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(model);
    }
    case 'openai': {
      const baseURL = process.env['OPENAI_BASE_URL'] || undefined;
      const openai = createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
      return openai.chat(model);
    }
    case 'litellm': {
      const baseURL = process.env['LITELLM_BASE_URL'] || 'http://localhost:4000';
      const openai = createOpenAI({ apiKey: apiKey || 'nokey', baseURL });
      return openai.chat(model);
    }
    default:
      throw new SpecGuardError(
        `Unknown LLM provider: \`${provider}\`. Supported: anthropic, openai, litellm, replay, none.`,
        ExitCode.InternalError,
      );
  }
}

// ---------------------------------------------------------------------------
// Targets, retries, budget
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** The ordered targets for one call: the primary (with a pipeline override applied), then the fallbacks. */
export function resolveTargets(opts: Pick<LlmTextOpts, 'provider' | 'model' | 'apiKeyEnv' | 'pipeline'>): LlmTarget[] {
  const rt = getLlmRuntime();
  const pipeline = opts.pipeline ?? currentPipeline();
  const override = rt?.llm.pipelines?.[pipeline];
  const primary: LlmTarget = {
    provider: override?.provider ?? opts.provider,
    model: override?.model ?? opts.model,
    apiKeyEnv: override?.apiKeyEnv ?? opts.apiKeyEnv,
  };
  const chain = override?.fallback ?? rt?.llm.fallback ?? [];
  return [primary, ...chain];
}

function retryable(err: unknown): boolean {
  if (err instanceof SpecGuardError) return false;
  const e = err as { isRetryable?: boolean; statusCode?: number; status?: number; name?: string; code?: string; cause?: unknown };
  if (e.isRetryable === true) return true;
  const status = e.statusCode ?? e.status;
  if (status === 408 || status === 409 || status === 429 || (typeof status === 'number' && status >= 500)) return true;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  const code = e.code ?? (e.cause as { code?: string } | undefined)?.code;
  if (code && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_.*)$/.test(code)) return true;
  return false;
}

/** Sleep seam: tests replace it to avoid real waiting. */
export const llmClock = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  random: (): number => Math.random(),
};

function backoffDelay(attempt: number, baseMs: number): number {
  if (baseMs <= 0) return 0;
  const exp = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + (llmClock.random() * exp) / 2);
}

function checkBudget(pipeline: string, projectedInputTokens: number): void {
  const budget = getLlmRuntime()?.llm.budget;
  if (!budget) return;
  const spent = runSpend();
  const fail = (what: string): never => {
    const message = `LLM budget exceeded (${what}). Raise llm.budget in .specguard/config.json or run fewer pipelines. Pipeline: ${pipeline}.`;
    markBudgetExceeded(message);
    throw new LlmBudgetExceededError(message);
  };
  if (budget.maxCalls !== undefined && spent.calls >= budget.maxCalls) fail(`${spent.calls} of ${budget.maxCalls} calls`);
  if (budget.maxTokens !== undefined && spent.tokens + projectedInputTokens > budget.maxTokens) {
    fail(`${spent.tokens} of ${budget.maxTokens} tokens`);
  }
  if (budget.maxUsd !== undefined && spent.usd >= budget.maxUsd) {
    fail(`$${spent.usd.toFixed(4)} of $${budget.maxUsd.toFixed(2)}`);
  }
}

interface CallResult<T> {
  value: T;
  inputTokens: number;
  outputTokens: number;
}

function usageOf(usage: unknown): { inputTokens: number; outputTokens: number } {
  const u = (usage ?? {}) as { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number };
  return { inputTokens: u.inputTokens ?? u.promptTokens ?? 0, outputTokens: u.outputTokens ?? u.completionTokens ?? 0 };
}

/** Run one attempt chain (first try plus retries) against one target. */
async function attemptTarget<T>(
  target: LlmTarget,
  pipeline: string,
  projectedInputTokens: number,
  exec: (model: LanguageModel, signal: AbortSignal) => Promise<CallResult<T>>,
): Promise<{ result: CallResult<T> }> {
  const rt = getLlmRuntime();
  const retries = rt?.llm.retries ?? DEFAULT_RETRIES;
  const timeoutMs = rt?.llm.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backoffMs = rt?.llm.backoffMs ?? DEFAULT_BACKOFF_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    checkBudget(pipeline, projectedInputTokens);
    const model = resolveModel(target.provider, target.model, target.apiKeyEnv ?? '');
    try {
      const result = await exec(model, AbortSignal.timeout(timeoutMs));
      return { result };
    } catch (err) {
      lastError = err;
      if (err instanceof SpecGuardError || !retryable(err) || attempt === retries) break;
      await llmClock.sleep(backoffDelay(attempt, backoffMs));
    }
  }
  throw lastError;
}

function account(target: LlmTarget, pipeline: string, inputTokens: number, outputTokens: number): void {
  const rt = getLlmRuntime();
  const price = priceFor(target.model, rt?.llm.pricing);
  const usd = estimateUsd(inputTokens, outputTokens, price);
  addRunSpend({ calls: 1, tokens: inputTokens + outputTokens, usd });
  if (rt) {
    recordUsage(rt.rootDir, pipeline, target.model, {
      calls: 1,
      inputTokens,
      outputTokens,
      estimatedUsd: usd,
      unpricedCalls: price ? 0 : 1,
    });
  }
}

function replayDir(): string {
  const rt = getLlmRuntime();
  const dir = rt?.llm.replay?.dir ?? path.join('.specguard', 'replay');
  return path.isAbsolute(dir) ? dir : path.resolve(rt?.rootDir ?? process.cwd(), dir);
}

/** The shared call path: replay, none, budget, retries, fallback, usage, recording. */
async function invoke<T>(
  kind: ReplayKind,
  opts: LlmTextOpts,
  exec: (model: LanguageModel, signal: AbortSignal) => Promise<CallResult<T>>,
  fromReplay: (recorded: unknown) => T,
): Promise<T> {
  const pipeline = opts.pipeline ?? currentPipeline();
  const rt = getLlmRuntime();
  const targets = resolveTargets(opts);
  const primary = targets[0];

  if (primary.provider === 'none') throw new LlmDisabledError();

  if (opts.images && opts.images.length > 0 && rt?.llm.allowImages === false) {
    throw new SpecGuardError(
      'This call carries images but llm.allowImages is false. Remove the images or set llm.allowImages to true.',
      ExitCode.InternalError,
    );
  }

  const hash = replayKey(kind, opts.system, opts.prompt, opts.images);

  if (primary.provider === 'replay') {
    const dir = replayDir();
    const record = loadReplay(dir, hash);
    if (!record) throw new ReplayMissError(hash, dir);
    if (rt) recordUsage(rt.rootDir, pipeline, 'replay', { replayedCalls: 1 });
    return fromReplay(record.response);
  }

  const projectedInput = Math.ceil(((opts.system?.length ?? 0) + opts.prompt.length) / 4);
  let lastError: unknown;
  const errors: string[] = [];
  for (const target of targets) {
    if (target.provider === 'none' || target.provider === 'replay') continue;
    try {
      const { result } = await attemptTarget(target, pipeline, projectedInput, exec);
      account(target, pipeline, result.inputTokens, result.outputTokens);
      if (recordMode()) {
        saveReplay(replayDir(), {
          kind,
          hash,
          promptPreview: previewOf(opts.prompt),
          provider: target.provider,
          model: target.model,
          recordedAt: new Date().toISOString(),
          response: result.value,
        });
      }
      return result.value;
    } catch (err) {
      lastError = err;
      if (err instanceof LlmBudgetExceededError || err instanceof LlmDisabledError) throw err;
      errors.push(`${target.provider}/${target.model}: ${(err as Error).message ?? String(err)}`);
    }
  }
  if (targets.length > 1 && errors.length > 1) {
    throw new SpecGuardError(`All LLM targets failed. ${errors.join(' | ')}`, ExitCode.InternalError, lastError);
  }
  throw lastError;
}

function userMessages(opts: LlmTextOpts) {
  return [
    {
      role: 'user' as const,
      content: [
        ...(opts.images ?? []).map((image) => ({ type: 'image' as const, image })),
        { type: 'text' as const, text: opts.prompt },
      ],
    },
  ];
}

/** Generate free-form text from the configured provider/model. */
export async function llmGenerateText(opts: LlmTextOpts): Promise<string> {
  return invoke<string>(
    'text',
    opts,
    async (model, abortSignal) => {
      const common = {
        model,
        system: opts.system,
        maxOutputTokens: opts.maxTokens,
        temperature: opts.temperature,
        abortSignal,
      };
      const res =
        opts.images && opts.images.length > 0
          ? await generateText({ ...common, messages: userMessages(opts) })
          : await generateText({ ...common, prompt: opts.prompt });
      return { value: res.text, ...usageOf((res as { usage?: unknown }).usage) };
    },
    (recorded) => String(recorded),
  );
}

/** Generate a structured object validated against a Zod schema. */
export async function llmGenerateObject<T>(opts: LlmObjectOpts<T>): Promise<T> {
  return invoke<T>(
    'object',
    opts,
    async (model, abortSignal) => {
      const common = {
        model,
        schema: opts.schema,
        system: opts.system,
        maxOutputTokens: opts.maxTokens,
        temperature: opts.temperature,
        abortSignal,
      };
      const res =
        opts.images && opts.images.length > 0
          ? await generateObject({ ...common, messages: userMessages(opts) })
          : await generateObject({ ...common, prompt: opts.prompt });
      return { value: res.object as T, ...usageOf((res as { usage?: unknown }).usage) };
    },
    (recorded) => opts.schema.parse(recorded),
  );
}
