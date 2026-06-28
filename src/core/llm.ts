/**
 * LLM adapter — the single chokepoint for all LLM access in SpecGuard.
 *
 * Pipelines MUST route through `llmGenerateText` / `llmGenerateObject` rather
 * than importing `ai` or provider SDKs directly. This module selects the
 * provider from config and resolves the API key from the environment.
 *
 * Security: the resolved API key value is never logged or included in any
 * error message — only the *name* of the env var may appear in diagnostics.
 */

import { generateText, generateObject, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { ZodType } from 'zod';

import { SpecGuardError } from './errors.js';
import { ExitCode } from './exit-codes.js';

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
}

/** Options for schema-validated structured generation. */
export interface LlmObjectOpts<T> extends LlmTextOpts {
  schema: ZodType<T>;
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
  if (!apiKey) {
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
      const openai = createOpenAI({ apiKey });
      return openai(model);
    }
    default:
      throw new SpecGuardError(
        `Unknown LLM provider: \`${provider}\`. Supported providers: anthropic, openai.`,
        ExitCode.InternalError,
      );
  }
}

/** Generate free-form text from the configured provider/model. */
export async function llmGenerateText(opts: LlmTextOpts): Promise<string> {
  const model = resolveModel(opts.provider, opts.model, opts.apiKeyEnv);
  const { text } = await generateText({
    model,
    system: opts.system,
    prompt: opts.prompt,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
  });
  return text;
}

/** Generate a structured object validated against a Zod schema. */
export async function llmGenerateObject<T>(opts: LlmObjectOpts<T>): Promise<T> {
  const model = resolveModel(opts.provider, opts.model, opts.apiKeyEnv);
  const { object } = await generateObject({
    model,
    schema: opts.schema,
    system: opts.system,
    prompt: opts.prompt,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
  });
  return object;
}
