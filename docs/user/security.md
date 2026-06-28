---
title: "Security Pipeline"
sidebar_label: "Security Pipeline"
description: "The Security Pipeline generates OWASP-annotated security test stubs from a spec's Security Notes section and can optionally run a Semgrep SAST scan, turning documented security constraints into executable vitest tests."
category: "pipelines"
order: 60
generated: true
---

# Security Pipeline

## Overview

The Security Pipeline bridges the gap between documented security requirements and executable tests. For every spec that contains a `## Security Notes` section, the pipeline reads those constraints, inspects the referenced source module, and asks the LLM to produce a ready-to-run **vitest security test file** — with every generated test annotated with its relevant [OWASP Top 10](https://owasp.org/www-project-top-ten/) category.

Optionally, you can enable a **Semgrep SAST scan** with `--with-sast`. When real findings are returned, they are fed directly into the LLM prompt so the generated stubs target concrete, known issues in your codebase rather than generic patterns.

This is the security half of SpecGuard's requirement-to-test traceability story: your documented security constraints drive your security test suite.

---

## How It Works

1. **Spec resolution** — The pipeline locates the spec (by key or path) and extracts its `## Security Notes` section.
2. **Source module reading** — The source file named in the spec's `meta.module` field is read. If the file is missing or unreadable, the pipeline notes this in the LLM prompt and continues rather than failing.
3. **Optional SAST scan** — When `--with-sast` is supplied, Semgrep is invoked via Docker over the owning app's repository. If Docker or Semgrep is unavailable, a warning is logged and the pipeline proceeds without findings.
4. **LLM generation** — The LLM is prompted to emit a single, complete vitest test file. Each test is prefixed with an OWASP category comment (e.g. `// OWASP A01: Broken Access Control`). The model is instructed to output only valid test code — no Markdown fences, no prose. Any accidental fences in the output are stripped automatically.
5. **File output** — The generated file is written to `tests/security/<feature>.test.ts`, resolved against your app's `rootDir`. The `<feature>` segment mirrors the spec's path relative to the app's `specDir`, with the `.md` extension dropped.

---

## Running the Pipeline

### Process a single spec

```bash
specguard security --spec core/auth
```

You can supply either a **spec key** (resolved under the matching app's `specDir`) or a **direct path** to a `.md` file:

```bash
specguard security --spec ./specs/core/auth.md
```

### Process all specs

```bash
specguard security --all
```

Processes every spec found under each configured app's `specDir`.

### Enable the SAST scan

```bash
specguard security --spec core/auth --with-sast
```

Runs Semgrep via Docker over the app's repository before generating stubs. Any findings are summarised and included in the LLM prompt, producing regression-focused test stubs for real issues.

---

## Output

Generated test files are placed at:

```
<rootDir>/tests/security/<feature>.test.ts
```

For example, a spec at `specs/core/auth.md` (with `specDir` set to `specs/`) produces:

```
tests/security/core/auth.test.ts
```

> **Existing files are never overwritten.** If a security test file already exists for a spec, that spec is recorded as `skipped` and a `[skip]` message is logged. Delete or rename the existing file if you want to regenerate it.

---

## Exit Codes

| Condition | Exit Code |
|---|---|
| Stubs generated successfully (no SAST, or SAST returned no findings) | `0` |
| `--with-sast` ran and returned real findings | `5` (`SecurityIssues`) |

Generating stubs alone — even if some specs are skipped — exits with `0`. Exit code `5` is reserved exclusively for the case where the SAST scan surfaces real issues, signalling to your CI pipeline that findings need attention.

---

## Generated Test Format

Each generated test file is a standard vitest file. Every test stub is prefixed with an OWASP Top 10 annotation comment derived from the spec's Security Notes:

```typescript
// OWASP A01: Broken Access Control
it('should reject requests from unauthenticated users', async () => {
  // TODO: implement security test
});

// OWASP A03: Injection
it('should sanitise user-supplied input before passing to the query layer', async () => {
  // TODO: implement security test
});
```

When `--with-sast` is used and findings are returned, additional stubs targeting those specific findings are included in the file.

---

## Error Handling

- **LLM errors** for a single spec are recorded as `failed` and logged. The pipeline continues processing any remaining specs.
- **Missing source modules** are noted in the prompt; the pipeline does not fail.
- **Unavailable Docker/Semgrep** when using `--with-sast` logs a `[warn]` and the pipeline continues without SAST findings.

The pipeline always returns a `PipelineResult` containing counts, per-item detail, and progress messages. The CLI renders the final summary automatically.

---

## Configuration

The Security Pipeline reads app configuration from your `SpecGuardConfig`. Each app entry supplies:

| Field | Purpose |
|---|---|
| `specDir` | Root directory for specs; used to resolve spec keys and derive output paths |
| `repo` | Path to the source repository scanned by Semgrep when `--with-sast` is used |
| `framework` | Test framework (vitest is used for security stubs) |
| `rootDir` | Root against which `tests/security/` output paths are resolved |

See the [Configuration reference](../core/config) for full details.

---

## Dependencies

The Security Pipeline builds on the following SpecGuard internals:

- **`core/spec-parser`** — spec loading, parsing, and `## Security Notes` extraction
- **`core/llm`** — LLM access via `llmGenerateText`
- **`core/reader` / `core/writer`** — all file I/O
- **`core/config`** — `AppConfig` resolution
- **`adapters/semgrep`** — Semgrep SAST adapter (Docker invocation)
- **`pipelines/forward-generate`** — shares the spec → app → feature-naming convention
