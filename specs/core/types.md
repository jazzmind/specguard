# Core Type Definitions

<!-- module: specguard-core/types / type: core / status: draft -->

## Overview

This module defines the canonical TypeScript data shapes shared across all SpecGuard subsystems, including the parser, config loader, pipelines, CLI, and MCP server. It establishes the `ParsedSpec` model representing a fully parsed Living Specification file, the `SpecGuardConfig` model representing a validated `.specguard/config.json`, and the `PipelineResult` model representing the standard outcome of any pipeline execution. Zod validation schemas are intentionally kept with their consumers; this module provides only the TypeScript types. The `emptyResult` factory function is the sole runtime export, providing a zero-value `PipelineResult` for a named pipeline.

## Acceptance Criteria

- `SpecMeta` must accept all known keys (`module`, `type`, `status`, `auth`, `url`, `framework`) and preserve any unknown keys verbatim in `extra`.
- `ParsedSpec` must carry a `specKey` derived from the spec's path relative to the specs root directory.
- `AppConfig.framework` must accept `'vitest'`, `'playwright'`, `'jest'`, or any other string value.
- `LlmConfig` must store only the name of the environment variable holding the API key (`apiKeyEnv`), never the key value itself.
- `AuthProfile` must store only the names of environment variables for credentials (`usernameEnvVar`, `passwordEnvVar`), never the credential values themselves.
- `PipelineResult` must include integer counts (`created`, `updated`, `skipped`, `failed`) that serve as convenience aggregates over the `items` array.
- `emptyResult(pipeline)` must return a `PipelineResult` with all counts set to `0`, an empty `items` array, `exitCode` of `0`, and an empty `messages` array.
- `PipelineItem.status` must be one of `'created'`, `'updated'`, `'skipped'`, `'failed'`, or `'ok'`.
- `Severity` must be one of `'critical'`, `'major'`, `'minor'`, or `'info'`.

## Scenarios

### Scenario 1: emptyResult initialises all fields to zero values

**Steps:**
1. Call `emptyResult('reverse')` and capture the returned object.
2. Assert the `pipeline` field equals `'reverse'`.
3. Assert `created`, `updated`, `skipped`, and `failed` each equal `0`.
4. Assert `items` is an empty array (`[]`).
5. Assert `exitCode` equals `0`.
6. Assert `messages` is an empty array (`[]`).

**Expected Results:**
- The returned object satisfies the `PipelineResult` interface with all numeric counts at zero.
- No fields are `undefined` or missing.

### Scenario 2: emptyResult called with different pipeline names

**Steps:**
1. Call `emptyResult('validate')` and capture the result.
2. Assert the `pipeline` field equals `'validate'`.
3. Call `emptyResult('security')` and capture the result.
4. Assert the `pipeline` field equals `'security'`.

**Expected Results:**
- Each call returns an independent object with the correct `pipeline` name.
- All other fields remain at their zero values for both results.

### Scenario 3: SpecMeta preserves unknown keys in extra

**Steps:**
1. Construct a `SpecMeta` object with known keys `module: 'auth'`, `type: 'adapter'`, `status: 'stable'` and an unknown key `owner: 'team-a'` placed in `extra`.
2. Read `meta.module`, `meta.type`, and `meta.status`.
3. Read `meta.extra['owner']`.

**Expected Results:**
- `meta.module` equals `'auth'`, `meta.type` equals `'adapter'`, `meta.status` equals `'stable'`.
- `meta.extra['owner']` equals `'team-a'`.
- No unknown key appears as a top-level property outside `extra`.

### Scenario 4: ParsedSpec carries a specKey derived from path

**Steps:**
1. Construct a `ParsedSpec` object with `filePath` set to an absolute path and `specKey` set to `'core/spec-parser'`.
2. Read `parsedSpec.specKey`.
3. Assert the value does not contain an absolute path prefix.

**Expected Results:**
- `parsedSpec.specKey` equals `'core/spec-parser'`.
- The `specKey` is a relative, path-like string without a leading slash or drive letter.

### Scenario 5: PipelineItem accepts all valid status values

**Steps:**
1. Construct five `PipelineItem` objects, each with `key: 'test-key'` and `status` set to one of `'created'`, `'updated'`, `'skipped'`, `'failed'`, `'ok'` respectively.
2. Assert each object's `status` field matches the assigned value.

**Expected Results:**
- All five objects are valid `PipelineItem` instances without type errors.
- Each `status` field holds exactly the assigned string value.

### Scenario 6: LlmConfig stores only the env var name, not the key value

**Steps:**
1. Construct an `LlmConfig` object with `provider: 'anthropic'`, `model: 'claude-3-5-sonnet-20241022'`, and `apiKeyEnv: 'ANTHROPIC_API_KEY'`.
2. Assert `llmConfig.apiKeyEnv` equals `'ANTHROPIC_API_KEY'`.
3. Assert the object has no field containing a raw API key value (i.e., no field whose value starts with `'sk-'` or similar credential patterns).

**Expected Results:**
- `llmConfig.apiKeyEnv` holds only the environment variable name string.
- No credential value is present anywhere in the object.

## Security Notes

- `LlmConfig.apiKeyEnv` must store only the **name** of the environment variable, never the resolved secret value. Any code constructing or serialising `LlmConfig` must not inline API key values.
- `AuthProfile.usernameEnvVar` and `AuthProfile.passwordEnvVar` must store only environment variable names. Credential values must never be stored in these types or serialised to disk via `SpecGuardConfig`.
- Consumers reading `SpecMeta.extra` should treat all values as untrusted strings and avoid evaluating them.

## Dependencies

- No runtime dependencies; this module exports pure TypeScript types and one factory function.
- Consumed by: spec parser, config loader, all pipeline implementations, CLI command handlers, and the MCP server.
- Zod schemas that validate external input against these types reside with their respective consumers and are not part of this module.