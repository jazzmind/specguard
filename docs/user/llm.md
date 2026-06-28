---
title: "LLM Adapter"
sidebar_label: "LLM Adapter"
generated: true
---

# LLM Adapter

## Overview

The LLM Adapter is SpecGuard's single, unified gateway to large language model providers. All AI-powered pipelines within SpecGuard route their requests through this module — no pipeline talks to a provider SDK directly. This design keeps provider configuration, credential handling, and error behaviour consistent across the entire application.

The adapter supports two modes of interaction:

- **Free-form text generation** — ask the model a question or prompt and receive a plain text response.
- **Structured object generation** — ask the model to produce output that conforms to a [Zod](https://zod.dev/) schema, receiving a validated, typed object in return.

---

## Supported Providers

The adapter currently supports two LLM providers:

| Provider key | Backed by |
|---|---|
| `anthropic` | Anthropic Claude models |
| `openai` | OpenAI models |

The provider and model to use are determined by your SpecGuard configuration (the `LlmConfig` shape), which specifies a `provider`, a `model`, and an `apiKeyEnv` field naming the environment variable that holds your API key.

---

## API Key Resolution

SpecGuard reads your API key from the environment variable named by the `apiKeyEnv` field in your configuration. For example, if `apiKeyEnv` is `"ANTHROPIC_API_KEY"`, the adapter looks up `process.env.ANTHROPIC_API_KEY` at runtime.

**The key value is never logged.** SpecGuard is careful to ensure that your API key does not appear in any log output or error messages, regardless of what goes wrong.

---

## Error Behaviour

The adapter raises a `SpecGuardError` in two situations:

- **Missing or empty API key** — if the environment variable named by `apiKeyEnv` is unset or contains an empty string, the adapter throws immediately with a descriptive message. The message will tell you *which variable* is missing, but will never include the key's value.
- **Unknown provider** — if the `provider` field in your configuration is not one of the supported values, the adapter throws rather than silently falling back to a default.

In both cases the error is a `SpecGuardError`, so it can be caught and handled consistently alongside other SpecGuard errors.

---

## Usage

Pipelines and internal tooling interact with the adapter through two functions:

### `llmGenerateText(opts)`

Sends a prompt to the configured provider and model, and returns the generated text as a string. Use this when you need a free-form natural language response.

### `llmGenerateObject(opts)`

Sends a prompt to the configured provider and model, instructing it to produce structured output. The response is validated against a Zod schema you supply; the function returns the validated, typed object. Use this when you need the model's output to conform to a specific data shape.

Both functions accept options that include your `LlmConfig` (provider, model, and API key environment variable name) alongside the prompt or schema relevant to each call.

---

## Dependencies

The adapter is built on the following libraries:

- [`ai`](https://www.npmjs.com/package/ai) v4 — the AI SDK core
- [`@ai-sdk/anthropic`](https://www.npmjs.com/package/@ai-sdk/anthropic) v1 — Anthropic provider integration
- [`@ai-sdk/openai`](https://www.npmjs.com/package/@ai-sdk/openai) v1 — OpenAI provider integration
- [`zod`](https://www.npmjs.com/package/zod) v3 — schema validation for structured output
