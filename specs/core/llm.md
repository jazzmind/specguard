# LLM Adapter

<!--
  module: src/core/llm.ts
  type: core
  status: draft
-->

## Overview

The single chokepoint for all LLM access in SpecGuard. Pipelines never import
`ai` or provider SDKs directly — they call `llmGenerateText` (free-form text)
or `llmGenerateObject` (Zod-schema-validated structured output) here. This
module wraps ai-sdk v4 (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`), selects
the provider from config, and resolves the API key from the environment.

## Acceptance Criteria

- [ ] `llmGenerateText(opts)` returns the generated text string for a given provider/model/prompt
- [ ] `llmGenerateObject(opts)` returns an object validated against the supplied Zod schema
- [ ] Provider `anthropic` builds a model via `createAnthropic`; `openai` via `createOpenAI`
- [ ] The API key is read from `process.env[opts.apiKeyEnv]` and passed to the provider factory
- [ ] An unset or empty API key env var throws `SpecGuardError` (message must NOT contain the key value)
- [ ] An unknown provider throws `SpecGuardError`
- [ ] `resolveModel(provider, model, apiKeyEnv)` is exported so the missing-key path is unit-testable
- [ ] No `console.log` (or any logger) ever receives the resolved API key value
- [ ] `llm.pipelines.<name>` overrides provider, model, key env and fallback for one pipeline; the pipeline name comes from the CLI command or MCP tool that is running <!-- claim: per-pipeline-override -->
- [ ] `llm.fallback` is an ordered chain tried after the primary target has failed all its attempts; a budget or disabled-LLM error never triggers it <!-- claim: fallback-chain -->
- [ ] Each attempt has a timeout (`llm.timeoutMs`, default 120000); retryable failures (timeouts, 429, 5xx, network resets) are retried `llm.retries` times (default 2) with exponential backoff and jitter; auth, validation and missing-key errors are not retried <!-- claim: timeout-retry -->
- [ ] Every real call adds tokens, call count and an estimated cost to `.specguard/llm-usage.json`, in total, per pipeline and per model; pricing comes from a built-in table and `llm.pricing` overrides it <!-- claim: usage-log -->
- [ ] `llm.budget` (`maxUsd`, `maxTokens`, `maxCalls`) is a hard cap on one process run: once spent or projected spend crosses it, every later call throws `LlmBudgetExceededError`, and the CLI exits with code 8 and says why <!-- claim: budget-cap -->
- [ ] `provider: "replay"` serves recorded responses keyed by a hash of the prompt, system text and image bytes, makes no network call, and a miss throws an error that names the hash and says how to record <!-- claim: replay-provider -->
- [ ] `--record` (or `llm.replay.record`) writes every real response to the replay directory (default `.specguard/replay`) so a later `provider: "replay"` run reproduces it <!-- claim: record-mode -->
- [ ] `provider: "none"` makes every call throw `LlmDisabledError` without touching the network, and `align` runs deterministic-only under it <!-- claim: provider-none -->
- [ ] `llm.allowImages: false` rejects a call that carries images <!-- claim: allow-images -->

## Scenarios

### Scenario 1: Generate text

**Steps:**
1. Set the configured API key env var to a non-empty value
2. Call `llmGenerateText({ provider: 'anthropic', model, prompt, apiKeyEnv })`

**Expected Results:**
- Returns the `.text` produced by ai-sdk `generateText`
- The provider factory received the key from `process.env[apiKeyEnv]`

---

### Scenario 2: Generate object with a Zod schema

**Steps:**
1. Define a Zod schema, e.g. `z.object({ name: z.string() })`
2. Call `llmGenerateObject({ ...textOpts, schema })`

**Expected Results:**
- The `schema` is forwarded to ai-sdk `generateObject`
- Returns the parsed `.object`, typed as the schema's inferred type

---

### Scenario 3: Provider selection

**Steps:**
1. Call `resolveModel('anthropic', model, apiKeyEnv)` then `resolveModel('openai', model, apiKeyEnv)`
2. Call `resolveModel('grok', model, apiKeyEnv)`

**Expected Results:**
- `anthropic` and `openai` return a usable ai-sdk model instance
- An unknown provider throws `SpecGuardError`

---

### Scenario 4: Missing API key

**Steps:**
1. Ensure `process.env[apiKeyEnv]` is unset (or empty)
2. Call `resolveModel(provider, model, apiKeyEnv)` (or any generate function)

**Expected Results:**
- Throws `SpecGuardError`
- The error message names the missing env var but never contains a key value

## Security Notes

- The resolved API key value MUST NEVER be logged, printed, or included in any
  error message or thrown exception. Only the **name** of the env var
  (`opts.apiKeyEnv`) may appear in diagnostics.
- The key lives only in the local provider instance for the duration of the
  call and is never persisted.

## Dependencies

- `src/core/types.ts` — `LlmConfig` shape (provider/model/apiKeyEnv)
- `src/core/errors.ts` — `SpecGuardError`
- External: `ai` (v4), `@ai-sdk/anthropic` (v1), `@ai-sdk/openai` (v1), `zod` (v3)
