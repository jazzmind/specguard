# Root Document Sync

<!-- module: specguard-core/root-doc-sync / type: feature / status: draft -->

## Overview

The root document sync feature keeps `README.md`, `CLAUDE.md`, and `AGENTS.md` aligned with the current SpecGuard spec state whenever the `docs` pipeline runs. It uses HTML comment sentinels of the form `<!-- specguard:<key>:start -->` / `<!-- specguard:<key>:end -->` to surgically replace auto-generated sections while leaving all hand-written content outside those sentinels untouched. Architecture and pipeline content is generated via an LLM call using the configured provider and model. If `AGENTS.md` does not yet exist it is created from a structured template; if it already exists only its sentinel-delimited sections are updated. Failures in LLM generation are caught and logged without crashing the pipeline.

## Acceptance Criteria

- AC1: `syncRootDocs` updates `README.md` with sentinel sections `architecture`, `commands`, and `pipeline-reference`.
- AC2: `syncRootDocs` updates `CLAUDE.md` with sentinel sections `architecture`, `pipeline-reference`, and `spec-location` only when `CLAUDE.md` already exists on disk.
- AC3: When `AGENTS.md` does not exist, `syncRootDocs` creates it from the full template including all five sentinel sections and a static commands reference block.
- AC4: When `AGENTS.md` already exists, `syncRootDocs` updates only the five sentinel sections (`agents:when-to-run`, `agents:pipelines`, `agents:spec-format`, `agents:config-apps`, `agents:workflows`) without altering content outside those sentinels.
- AC5: `replaceSentinel` replaces content between existing start/end sentinels without duplicating the sentinel tags.
- AC6: `replaceSentinel` appends a new sentinel section at the end of the file when no matching sentinels are found.
- AC7: If LLM generation for architecture sections fails, the function logs the error and returns early without writing any files.
- AC8: If LLM generation for the AGENTS.md guide fails, the function logs the error and returns early without writing `AGENTS.md`.
- AC9: Parent directories for target files are created recursively if they do not exist.
- AC10: LLM API key values are never written into any generated file.

## Scenarios

### Scenario 1: README.md sentinel sections are inserted when none exist

**Steps:**
1. Provide a `README.md` that contains no SpecGuard sentinel comments.
2. Call `syncRootDocs` with a valid config and a non-empty `specs` array.
3. Mock the LLM to return deterministic `architecture`, `commands`, `pipelineReference`, and `specLocationMapping` strings.
4. Read the resulting `README.md` from disk.

**Expected Results:**
- The file contains `<!-- specguard:architecture:start -->` followed by the mocked architecture text followed by `<!-- specguard:architecture:end -->`.
- The file contains `<!-- specguard:commands:start -->` and `<!-- specguard:commands:end -->` wrapping the mocked commands text.
- The file contains `<!-- specguard:pipeline-reference:start -->` and `<!-- specguard:pipeline-reference:end -->` wrapping the mocked pipeline reference text.
- Content that was in `README.md` before the call is still present in the file.

### Scenario 2: README.md sentinel sections are replaced when they already exist

**Steps:**
1. Provide a `README.md` that already contains `<!-- specguard:architecture:start -->`, old content, and `<!-- specguard:architecture:end -->`.
2. Call `syncRootDocs` with a valid config and specs; mock LLM to return new architecture text.
3. Read the resulting `README.md` from disk.

**Expected Results:**
- The file contains exactly one `<!-- specguard:architecture:start -->` tag.
- The file contains exactly one `<!-- specguard:architecture:end -->` tag.
- The old content between the sentinels is no longer present.
- The new mocked architecture text appears between the sentinel tags.

### Scenario 3: CLAUDE.md is skipped when it does not exist

**Steps:**
1. Ensure no `CLAUDE.md` file exists in the root directory.
2. Call `syncRootDocs` with a valid config and specs; mock LLM responses.
3. Check the filesystem for `CLAUDE.md`.

**Expected Results:**
- No `CLAUDE.md` file is created.
- The log output does not contain `[root-sync] CLAUDE.md updated`.

### Scenario 4: CLAUDE.md sentinel sections are updated when the file exists

**Steps:**
1. Create a `CLAUDE.md` containing hand-written content and no SpecGuard sentinels.
2. Call `syncRootDocs` with a valid config and specs; mock LLM to return deterministic strings.
3. Read the resulting `CLAUDE.md` from disk.

**Expected Results:**
- The file contains sentinel sections for `architecture`, `pipeline-reference`, and `spec-location`.
- The original hand-written content is still present in the file.
- The log output contains `[root-sync] CLAUDE.md updated`.

### Scenario 5: AGENTS.md is created from template when it does not exist

**Steps:**
1. Ensure no `AGENTS.md` file exists in the root directory.
2. Call `syncRootDocs` with a valid config and specs; mock both LLM calls to return deterministic strings.
3. Read the resulting `AGENTS.md` from disk.

**Expected Results:**
- The file begins with `# AGENTS.md — SpecGuard Integration Guide for AI Coding Agents`.
- The file contains all five sentinel pairs: `agents:when-to-run`, `agents:pipelines`, `agents:spec-format`, `agents:config-apps`, `agents:workflows`.
- The file contains the static commands reference block with `npx tsx src/cli/index.ts status`.
- The log output contains `[root-sync] AGENTS.md created`.

### Scenario 6: AGENTS.md sentinel sections are updated when the file already exists

**Steps:**
1. Create an `AGENTS.md` containing existing sentinel sections with old content and additional hand-written text outside the sentinels.
2. Call `syncRootDocs` with a valid config and specs; mock the agents guide LLM call to return new content.
3. Read the resulting `AGENTS.md` from disk.

**Expected Results:**
- Each of the five sentinel sections contains the new mocked content.
- Hand-written text outside the sentinel sections is still present.
- The log output contains `[root-sync] AGENTS.md updated`.

### Scenario 7: Architecture LLM failure causes early return with no file writes

**Steps:**
1. Provide existing `README.md` and `CLAUDE.md` files with known content.
2. Configure the LLM mock to throw an error when `generateArchitectureSections` is called.
3. Call `syncRootDocs` and capture log output.
4. Read `README.md` and `CLAUDE.md` from disk.

**Expected Results:**
- The log output contains `[root-sync] architecture section generation failed:` followed by the error message.
- `README.md` content is unchanged from before the call.
- `CLAUDE.md` content is unchanged from before the call.
- `AGENTS.md` is not created.

### Scenario 8: AGENTS.md guide LLM failure causes early return after README update

**Steps:**
1. Mock the architecture LLM call to succeed and the agents guide LLM call to throw an error.
2. Call `syncRootDocs` and capture log output.
3. Check the filesystem for `AGENTS.md`.

**Expected Results:**
- `README.md` is written with updated sentinel sections (architecture LLM succeeded).
- The log output contains `[root-sync] AGENTS.md guide generation failed:` followed by the error message.
- `AGENTS.md` is not created or modified.

### Scenario 9: Target file parent directories are created when missing

**Steps:**
1. Configure `config.rootDir` to point to a path whose parent directories do not yet exist on disk.
2. Call `applyTargetSections` with a file path inside that non-existent directory tree.
3. Check the filesystem.

**Expected Results:**
- All intermediate directories are created.
- The target file is written successfully with the expected sentinel content.

## Security Notes

- LLM API keys are read from environment variables referenced by `config.llm.apiKeyEnv` and must never appear in any generated file (`README.md`, `CLAUDE.md`, `AGENTS.md`).
- The context prompt sent to the LLM includes only project metadata (app names, spec keys, directory paths, and pipeline names) — no raw source code or secret values.
- Generated file writes use `utf8` encoding; no binary or executable content is written.

## Dependencies

- `node:fs` — reading and writing `README.md`, `CLAUDE.md`, `AGENTS.md`.
- `node:path` — resolving file paths relative to `config.rootDir`.
- `zod` — runtime schema validation of LLM-generated objects (`ArchitectureSectionSchema`, `AgentsGuideSchema`).
- `./llm.js` (`llmGenerateObject`) — LLM structured-output calls for architecture and agents guide content.
- `./types.js` (`SpecGuardConfig`, `ParsedSpec`) — configuration and spec data types.