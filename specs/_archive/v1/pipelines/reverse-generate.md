# Reverse Generation Pipeline

<!--
  module: src/pipelines/reverse-generate.ts
  type: pipeline
  status: draft
-->

## Overview

Reads existing source files (components, routes, API handlers, existing tests) and generates structured Living Spec Markdown files for features that don't yet have a spec, or updates stale specs when code has changed. This is the primary pipeline for brownfield codebases — it creates specs from code rather than requiring specs to be written from scratch.

Config-driven source discovery: the `.specguard/config.json` app definition provides glob patterns for routes, pages, API files, and existing tests. No file paths are hard-coded.

## Acceptance Criteria

- [ ] Reads app config from `SpecGuardConfig` (no filesystem calls to locate config — caller loads it)
- [ ] `--app <name>` targets a single app; `--all` processes every app in config (one or the other is required)
- [ ] CLI exits with code 1 if neither `--app` nor `--all` is provided
- [ ] Expands source globs relative to the app's `repo` directory
- [ ] Groups discovered files by type (`routes`, `pages`, `api`, `tests`)
- [ ] For each logical "feature" discovered, checks whether a spec already exists in `specDir`
- [ ] If spec exists and `--force` is not set, skips with a `[skip]` log line
- [ ] If spec does not exist (or `--force` is set), calls the LLM to generate a spec
- [ ] Generated spec is written to `<specDir>/<area>/<feature>.md`
- [ ] Creates intermediate directories as needed
- [ ] Returns a `PipelineResult` with counts of created, skipped, and failed specs
- [ ] Each file read is capped at 20,000 chars to keep LLM context manageable (truncates with `... (truncated)`)
- [ ] LLM receives: system prompt defining spec format, all relevant source files as context, the target spec key

## Spec Generation Prompt Requirements

The LLM system prompt must instruct the model to:
- Write one spec per distinct page, route, or feature area
- Only document behaviour visible in the provided source code
- Use the exact spec format (HTML comment block, H2 sections)
- Keep `## Overview` to 3-6 sentences
- Make each scenario step observable by a test tool (not abstract)
- Output only the Markdown content — no preamble or explanation

## Scenarios

### Scenario 1: Generate spec for a new file with no existing spec

**Steps:**
1. Call `runReverseGenerate(config, { app: 'my-app' })`
2. Config has a `pages` glob matching `src/pages/checkout.tsx`
3. No file exists at `specs/my-app/checkout.md`

**Expected Results:**
- LLM is called with checkout page source as context
- `specs/my-app/checkout.md` is created
- Result includes `created: 1`
- Log shows `[gen] my-app/checkout`

---

### Scenario 2: Skip existing spec without --force

**Steps:**
1. Call `runReverseGenerate(config, { app: 'my-app' })`
2. `specs/my-app/checkout.md` already exists
3. `opts.force` is `false`

**Expected Results:**
- LLM is NOT called
- No files written
- Result includes `skipped: 1`
- Log shows `[skip] my-app/checkout — spec already exists`

---

### Scenario 3: Overwrite existing spec with --force

**Steps:**
1. Call `runReverseGenerate(config, { app: 'my-app', force: true })`
2. `specs/my-app/checkout.md` already exists

**Expected Results:**
- LLM is called
- Existing spec is overwritten
- Result includes `created: 1`

---

### Scenario 4: --file targets a single source file

**Steps:**
1. Call `runReverseGenerate(config, { app: 'my-app', file: 'src/pages/login.tsx' })`

**Expected Results:**
- Only `src/pages/login.tsx` is processed (no other files)
- Spec key derived from the file path relative to the app `repo`

---

### Scenario 5: Source file not found

**Steps:**
1. Config glob resolves to a path that does not exist on disk

**Expected Results:**
- File is skipped with a `[warn]` log line
- Pipeline continues with remaining files
- No error thrown

---

### Scenario 6: LLM call fails

**Steps:**
1. LLM adapter throws an error for one spec

**Expected Results:**
- That spec is recorded in result as `failed: 1` with the error message
- Pipeline continues with remaining specs
- Final exit is non-zero only if all specs failed

## Security Notes

- Source files may contain secrets (env vars, API keys in comments). These are sent to the LLM provider as part of the spec generation prompt. The pipeline should warn if any source file appears to contain secret patterns (`/sk-[a-zA-Z0-9]{20,}/`, `process.env.`, etc.) before including it.
- Generated spec files must not reproduce raw secret values found in source — the LLM prompt must instruct the model to redact.

## Dependencies

- `specs/core/spec-parser.md` — for reading/checking existing specs
- `specs/core/llm.md` — LLM adapter
- `specs/core/config.md` — `AppConfig` type, glob expansion
- `specs/core/writer.md` — file output
