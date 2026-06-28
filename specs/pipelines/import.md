# Import Pipeline

<!-- module: src/pipelines/import.ts -->
<!-- type: pipeline -->
<!-- status: stable -->

## Overview

The import pipeline transforms unstructured external requirement documents (PRDs,
Jira exports, plain Markdown notes) into Living Specification format. This is the
brownfield entry point for teams that have existing requirements documentation.

Once imported, the spec file becomes the source of truth — not the original document.

## Acceptance Criteria

- `runImport(config, opts)` accepts a file path or URL as the source.
- Supported input types: Markdown file (`.md`), plain text file (`.txt`), URL (fetched via https).
- LLM transforms the input into the SpecGuard Living Spec format (H1 title, metadata comment, Overview, Acceptance Criteria, Scenarios, Security Notes).
- Output spec is written to `<app.specDir>/<derived-name>.md`.
- Derived name is slugified from the document's title (H1 heading or first line).
- If a spec with the same name already exists and `--force` is not set, the operation is skipped.
- Exit code is `0` on success, `1` on error.
- `--app <name>` specifies which app's `specDir` to write to (required if config has multiple apps).
- `--out <path>` overrides the output path.

## Scenarios

### Scenario 1: Import from Markdown file
**Steps:**
1. `specguard import ./docs/feature-brief.md --app myapp`
2. LLM generates a Living Spec

**Expected Results:**
- Spec written to `<app.specDir>/feature-brief.md`
- `created: 1` in result

### Scenario 2: Skip existing spec without --force
**Steps:**
1. Spec already exists at the target path
2. Run import without `--force`

**Expected Results:**
- `skipped: 1`, no file overwrite

### Scenario 3: URL input fetched and converted
**Steps:**
1. `specguard import https://example.com/prd --app myapp`
2. URL is fetched and content extracted

**Expected Results:**
- Spec created from the fetched content

## Security Notes

- URLs are fetched with a standard User-Agent. Do not follow redirects to `file://` or private networks.
- LLM prompts must not include auth credentials even if the source document contains them.

## Dependencies

- `src/core/llm.ts`
- `src/core/writer.ts`
- `src/core/reader.ts`
- Node.js `https`
