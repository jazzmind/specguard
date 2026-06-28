---
title: "LLM Adapter"
sidebar_label: "LLM Adapter"
description: "The LLM Adapter is SpecGuard's single, unified interface for all language model access — pipelines call it directly instead of importing provider SDKs, keeping LLM usage consistent and secure across the system."
category: "adapters"
order: 10
generated: true
---

# LLM Adapter

The LLM Adapter is the single, unified gateway through which all of SpecGuard's pipelines interact with large language models. Rather than importing provider SDKs directly, every pipeline routes its LLM calls through this adapter. This keeps provider configuration, API key handling, and output validation in one place — making your setup easier to reason about and your secrets easier to protect.

---

## What It Does

The adapter exposes two core functions that cover the full range of LLM use cases inside SpecGuard:

- **`llmGenerateText(opts)`** — Sends a prompt to the configured model and returns the generated text as a plain string. Use this whenever you need free-form natural language output.
- **`llmGenerateObject(opts)`** — Sends a prompt and returns a structured object that has been validated against a [Zod](https://zod.dev/) schema you supply. Use this when you need reliable, typed data back from the model.

Under the hood, the adapter wraps **ai-sdk v4** (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`) and handles provider selection and credential resolution automatically based on your configuration.

---

## Supported Providers

The adapter currently supports two LLM providers:

| Provider | SDK Used |
|---|---|
| `anthropic` | `@ai-sdk/anthropic` (`createAnthropic`) |
| `openai` | `@ai-sdk/openai` (`createOpenAI`) |

The provider is selected from your `LlmConfig` (defined in `src/core/types.ts`). If you specify a provider name that is not one of the above, the adapter will throw a `SpecGuardError` immediately, so misconfiguration is caught early rather than at runtime.

---

## Configuration

Your `LlmConfig` object drives the adapter's behaviour. It contains three fields:

- **`provider`** — Which LLM provider to use (`"anthropic"` or `"openai"`).
- **`model`** — The model identifier to pass to the provider (e.g. a specific Claude or GPT model name).
- **`apiKeyEnv`** — The **name** of the environment variable that holds your API key (e.g. `"ANTHROPIC_API_KEY"`).

The adapter reads the actual key value from `process.env[apiKeyEnv]` at call time and passes it directly to the provider factory. **The key value itself is never written to any log output** — only the environment variable name is referenced in error messages, so your credentials stay safe even when debugging.

---

## API Key Handling

The adapter enforces strict rules around API key resolution:

- If the environment variable named by `apiKeyEnv` is **unset or empty**, the adapter throws a `SpecGuardError`. The error message will tell you which environment variable is missing, but will **never** include the key's value.
- This validation happens before any network call is made, so you get a clear, actionable error rather than a cryptic provider rejection.

Make sure the appropriate environment variable is set in your runtime environment before invoking any pipeline that uses the LLM Adapter.

---

## Advanced: `resolveModel`

The adapter also exports a lower-level helper:

```ts
resolveModel(provider: string, model: string, apiKeyEnv: string)
```

This function encapsulates provider instantiation and API key resolution. It is exported primarily to make the missing-key validation path independently testable, but you can also use it if you need to construct a model instance outside of the standard `llmGenerateText` / `llmGenerateObject` flow.

---

## Dependencies

The LLM Adapter relies on the following internal and external packages:

| Dependency | Purpose |
|---|---|
| `src/core/types.ts` | `LlmConfig` type (provider, model, apiKeyEnv) |
| `src/core/errors.ts` | `SpecGuardError` for structured error throwing |
| `ai` (v4) | Core ai-sdk runtime |
| `@ai-sdk/anthropic` (v1) | Anthropic provider integration |
| `@ai-sdk/openai` (v1) | OpenAI provider integration |
| `zod` (v3) | Schema validation for `llmGenerateObject` |

---

## Security Notes

- **Never log your API key.** The adapter is designed so that the resolved key value is passed only to the provider factory and is never surfaced in logs, error messages, or console output.
- **Use environment variables.** Store your API keys in environment variables and reference them by name in `apiKeyEnv`. Do not hard-code key values in your configuration files.
