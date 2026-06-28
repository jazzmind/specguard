---
title: "Doc Generation Pipeline"
sidebar_label: "Doc Generation Pipeline"
generated: true
---

# Doc Generation Pipeline

## What This Pipeline Does

The Doc Generation Pipeline takes your internal Living Specification files and transforms them into polished, user-facing documentation pages. Rather than exposing raw spec content — which includes developer-oriented sections like scenarios and security notes — the pipeline strips away the internal scaffolding and uses an AI model to rewrite what remains as clear, friendly prose that your users can actually read and act on.

The resulting documentation pages are written to an output directory (defaulting to `docs/user/`) and are ready to publish as-is.

---

## How It Works

When you run the pipeline, it:

1. **Reads your spec files** — either a single spec you specify, or every spec across all configured apps.
2. **Strips internal-only content** — the metadata comment, the `## Scenarios` section, and the `## Security Notes` section are removed before anything is sent to the AI model. Only the Overview, Acceptance Criteria, Dependencies, and similar sections are passed along.
3. **Rewrites the content** — the AI model transforms the remaining spec content into user-facing Markdown documentation. Acceptance Criteria, for example, are reframed as capability and usage descriptions rather than developer checklists. The output is always accurate to the source spec — the model never invents features, flags, or behavior that the spec doesn't describe.
4. **Prepends YAML frontmatter** — each generated page automatically receives frontmatter with a `title`, `sidebar_label` (both set to the spec's title), and `generated: true`.
5. **Writes the output file** — the page is saved to the output directory. Because generated docs are always reproducible, any existing file at that path is simply overwritten with no warning or error.

---

## Running the Pipeline

The pipeline is configured through `SpecGuardConfig`, which your tooling loads and passes in — there is no automatic config discovery inside the pipeline itself.

### Process a single spec

Use `--spec` with either a spec key or a direct file path:

```
--spec core/spec-parser
```

A spec key like `core/spec-parser` is resolved under the matching app's configured `specDir`. If you supply a direct `.md` path instead, it is used exactly as given.

### Process all specs

Use `--all` to process every spec found under each app's `specDir`:

```
--all
```

---

## Output Location

Generated documentation files are written to:

```
<out>/<feature>.md
```

- `<out>` defaults to `docs/user/`, resolved relative to your project's root directory. You can configure a different output path.
- `<feature>` is the spec file's path relative to its owning app's `specDir`, preserving any subdirectory structure.

For example, a spec at `specs/core/spec-parser.md` (with `specDir` pointing to `specs/core/`) would produce `docs/user/spec-parser.md`.

---

## Results and Error Handling

After a run, the pipeline returns a result summary that includes:

- **Counts** of how many specs were processed, succeeded, and failed.
- **Per-item detail** so you can see exactly what happened to each spec.
- **Progress messages** emitted during the run.

If the AI model encounters an error while processing a particular spec, that spec is recorded as `failed` and the pipeline continues with the remaining specs. The overall exit code is non-zero only if **every** attempted spec failed — a partial success is treated as a successful run.

---

## A Note on Accuracy

The AI model that rewrites your specs is explicitly instructed to stay faithful to the source content. It will not introduce features, configuration flags, commands, or behavior that your spec does not describe. What you write in your Living Spec is exactly what gets documented — no more, no less.
