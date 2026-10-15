# Doc Generation Pipeline

<!--
  module: src/pipelines/doc-generate.ts
  type: pipeline
  status: draft
-->

## Overview

Transforms Living Spec Markdown files into clear, user-facing documentation pages. Each spec is parsed, internal-only sections are stripped (the metadata comment, `## Scenarios`, and `## Security Notes`), and the remainder (Overview, Acceptance Criteria, Dependencies) is sent to the LLM to be rewritten as friendly end-user docs. YAML frontmatter is prepended and the page is written to a docs output directory (default `docs/user/`).

Config-driven: the spec's owning app (matched by `specDir`) is resolved the same way as forward-generate. Docs are regenerable artifacts, so existing files are overwritten without a skip step. No paths are hard-coded — the caller loads `SpecGuardConfig` and passes it in.

## Acceptance Criteria

- [ ] Reads app config from `SpecGuardConfig` (caller loads it; no config discovery here)
- [ ] `--spec <key|path>` processes exactly one spec; `--all` processes every spec under each app's `specDir` via `loadAllSpecs`
- [ ] A spec key like `core/spec-parser` resolves under the matching app's `specDir`; a direct `.md` path is used verbatim
- [ ] The spec is mapped to its owning app by matching the spec file location against each app's resolved `specDir` (same mapping as forward-generate)
- [ ] `stripForDocs(content)` removes the metadata HTML comment, the `## Scenarios` section, and the `## Security Notes` section; a section runs from its `## Heading` to the next `## ` heading or EOF
- [ ] The stripped source (Overview, Acceptance Criteria, Dependencies, etc.) is transformed by the LLM into user-facing Markdown documentation — accurate to the input, never inventing features
- [ ] YAML frontmatter is prepended with `title`, `sidebar_label` (both the spec title), and `generated: true`
- [ ] Output path is `<out>/<feature>.md` where `out` defaults to `docs/user` (resolved relative to `config.rootDir`) and `feature` is the spec path relative to the owning app's `specDir`
- [ ] Existing doc files are overwritten (docs are regenerable); no skip step and no error if the file exists
- [ ] An LLM error for one spec records `failed` and continues with the remaining specs
- [ ] Returns a `PipelineResult` with counts, per-item detail, and progress messages; exit code is non-zero only if every attempted spec failed
- [ ] All LLM access routes through `core/llm.ts`; all file I/O routes through `core/reader.ts` / `core/writer.ts`

## Doc Generation Prompt Requirements

The LLM system prompt must instruct the model to:
- Produce clear, friendly, end-user-facing documentation in Markdown
- Reframe internal "Acceptance Criteria" as user-facing capability/usage prose, not a checklist of dev tasks
- Stay accurate to the supplied spec content — never invent features, flags, or behavior
- Output Markdown body only — no wrapping code fence around the whole document, no frontmatter (the pipeline adds frontmatter)

## Scenarios

### Scenario 1: Generate a doc from a single spec via --spec

**Steps:**
1. A spec exists at `<specDir>/spec-parser.md` for app `specguard-core`
2. Call `runDocGenerate(config, { spec: 'core/spec-parser' })`

**Expected Results:**
- The spec is parsed and the LLM is called once
- A doc file is written to `docs/user/spec-parser.md`
- The file begins with YAML frontmatter containing `title:`, `sidebar_label:`, and `generated: true`
- The frontmatter is followed by the LLM-produced doc body
- Result includes `created: 1`

---

### Scenario 2: Generate docs for all specs via --all

**Steps:**
1. Multiple specs exist across apps' `specDir`s
2. Call `runDocGenerate(config, { all: true })`

**Expected Results:**
- `loadAllSpecs` discovers every spec under each app's `specDir`
- One doc file is generated per spec
- Result `created` equals the number of specs processed

---

### Scenario 3: Custom output directory via --out

**Steps:**
1. A spec exists for an app
2. Call `runDocGenerate(config, { spec: '<key>', out: 'site/docs' })`

**Expected Results:**
- The doc is written under `site/docs/<feature>.md` (resolved relative to `rootDir`)
- The default `docs/user` directory is not used

---

### Scenario 4: stripForDocs removes internal sections

**Steps:**
1. Spec content contains a metadata comment, `## Overview`, `## Acceptance Criteria`, `## Scenarios`, and `## Security Notes`
2. Call `stripForDocs(content)`

**Expected Results:**
- The `<!-- ... -->` metadata comment is removed
- The entire `## Scenarios` section (heading through the next `## ` or EOF) is removed
- The entire `## Security Notes` section is removed
- `## Overview` and `## Acceptance Criteria` remain

---

### Scenario 5: LLM call fails for one spec

**Steps:**
1. The LLM adapter throws for one spec while others succeed

**Expected Results:**
- That spec is recorded as `failed: 1` with the error message
- The pipeline continues with the remaining specs
- Exit is non-zero only if every attempted spec failed

## Dependencies

- `specs/core/spec-parser.md` — `parseSpecContent`, `loadAllSpecs`
- `specs/core/llm.md` — LLM adapter (`llmGenerateText`)
- `specs/core/config.md` — `AppConfig` (`specDir`)
- `specs/core/writer.md` — file output
- `specs/pipelines/forward-generate.md` — shares the spec→app→feature mapping convention
