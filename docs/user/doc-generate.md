---
title: "Doc Generation Pipeline"
sidebar_label: "Doc Generation Pipeline"
description: "The Doc Generation Pipeline transforms Living Spec Markdown files into polished, user-facing documentation pages by stripping internal sections and rewriting the content with an LLM, then writing the output to a configurable docs directory."
category: "pipelines"
order: 20
generated: true
---

# Doc Generation Pipeline

The Doc Generation Pipeline takes your Living Spec Markdown files and turns them into clean, friendly documentation pages ready for your users. It strips out internal-only content, sends the meaningful parts to an LLM for rewriting, prepends YAML frontmatter, and writes the finished pages to your docs output directory.

---

## How It Works

When you run the pipeline, each spec file goes through three stages:

1. **Strip internal sections** — The pipeline removes content that is not meant for end users: the metadata comment block, the `## Scenarios` section, and the `## Security Notes` section. Each of these sections is removed from its heading through to the next `##`-level heading (or the end of the file). What remains — typically the Overview, Acceptance Criteria, Dependencies, and any other sections you have written — is passed forward.

2. **LLM rewrite** — The stripped source is sent to the LLM, which rewrites it as user-facing Markdown documentation. The LLM is instructed to stay strictly accurate to the spec content (it will never invent features, flags, or behavior), to reframe any "Acceptance Criteria" as readable capability and usage prose rather than a developer checklist, and to return a Markdown body only (no wrapping code fence, no frontmatter).

3. **Write output** — YAML frontmatter is prepended to the generated body, and the finished file is written to the output directory. Because documentation pages are regenerable artifacts, any existing file at the target path is simply overwritten — there is no skip step and no error if the file already exists.

---

## Running the Pipeline

The pipeline is config-driven. The caller loads a `SpecGuardConfig` and passes it in; no config discovery happens inside the pipeline itself.

### Process a single spec

```
--spec <key|path>
```

Pass either a spec key (e.g. `core/spec-parser`) or a direct `.md` file path:

- **Spec key** — resolved under the matching app's `specDir`. For example, `core/spec-parser` looks up the app whose `specDir` contains that key and resolves the full path from there.
- **Direct path** — a `.md` path is used verbatim, exactly as supplied.

### Process all specs

```
--all
```

Processes every spec found under each app's `specDir` using `loadAllSpecs`. Useful for a full documentation rebuild.

---

## Output Location

Generated files are written to:

```
<out>/<feature>.md
```

| Part | Description |
|---|---|
| `out` | Output directory. Defaults to `docs/user`, resolved relative to `config.rootDir`. |
| `feature` | The spec's path relative to its owning app's `specDir`. |

For example, a spec at `apps/core/specs/config.md` (where `specDir` is `apps/core/specs`) would be written to `docs/user/config.md` by default.

### YAML Frontmatter

Every generated page receives frontmatter in this shape:

```yaml
---
title: <spec title>
sidebar_label: <spec title>
generated: true
---
```

Both `title` and `sidebar_label` are set to the spec's title as parsed from the source file.

---

## Spec-to-App Mapping

Each spec file is matched to its owning app by comparing the spec file's location against each app's resolved `specDir`. This is the same mapping convention used by the Forward Generate pipeline, so your app configuration works consistently across both pipelines.

---

## Error Handling and Results

The pipeline is designed to be resilient across bulk runs:

- If the LLM returns an error for a particular spec, that spec is recorded as **failed** and the pipeline continues processing the remaining specs.
- When the run completes, a `PipelineResult` is returned containing:
  - **Counts** — how many specs were processed, succeeded, and failed.
  - **Per-item detail** — the outcome for each individual spec.
  - **Progress messages** — status updates emitted during the run.
- The exit code is **non-zero only if every attempted spec failed**. A partial success (some specs generated, some failed) exits cleanly.

---

## Internal Architecture

All LLM calls are routed through `core/llm.ts` (`llmGenerateText`). All file reads and writes are routed through `core/reader.ts` and `core/writer.ts` respectively. No paths are hard-coded in the pipeline itself.

**Dependencies:**

| Module | Used for |
|---|---|
| `core/spec-parser` | `parseSpecContent`, `loadAllSpecs` |
| `core/llm` | LLM adapter (`llmGenerateText`) |
| `core/config` | `AppConfig` (`specDir`) |
| `core/writer` | Writing output files |
| `pipelines/forward-generate` | Shared spec → app → feature mapping convention |
