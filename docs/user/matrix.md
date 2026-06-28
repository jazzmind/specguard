---
title: "Matrix Pipeline"
sidebar_label: "Matrix Pipeline"
generated: true
---

# Matrix Pipeline

## Overview

The Matrix Pipeline generates a **traceability matrix** that maps your specifications to the tests, documentation files, and source modules that relate to them. The result is saved to `.specguard/traceability.json` by default (or a path you configure), and can also be exported as a CSV file for compliance and audit purposes.

Use the matrix to answer questions like:

- *Which tests cover this requirement?*
- *Which requirements have no tests yet?*

---

## What the Matrix Contains

For every spec in your project, the matrix produces an entry with the following information:

| Field | Description |
|---|---|
| `specKey` | The unique identifier for the spec |
| `title` | The human-readable title of the spec |
| `tests` | Paths to test files matched to this spec |
| `docs` | Paths to documentation files matched to this spec |
| `sources` | Source module paths associated with this spec |

### How Files Are Matched

SpecGuard uses a straightforward naming convention to link files to specs automatically:

- **Test files** — A test file is matched to a spec when its filename (minus the `.test.ts` extension) matches the spec key's base name. For example, `auth-login.test.ts` matches the spec keyed `auth-login`.
- **Documentation files** — A doc file is matched when its filename (minus the `.md` extension) matches the spec key's base name. For example, `auth-login.md` matches the same spec.
- **Source modules** — Source files are drawn from the `module:` metadata field in the spec itself, when that field is present.

---

## Output

### JSON (Default)

By default, the matrix is written to:

```
.specguard/traceability.json
```

You can change this path by setting `matrix.output` in your SpecGuard configuration file.

### CSV Export

If you need a spreadsheet-friendly format for compliance teams or audits, pass the `--format csv` flag. This produces a `.csv` file with the following columns:

```
specKey, title, testCount, docCount, sourceModule
```

---

## Usage

Run the matrix pipeline with:

```bash
specguard run matrix
```

**Export as CSV:**

```bash
specguard run matrix --format csv
```

**Scope to a single app:**

If your project contains multiple apps, you can limit the matrix to the specs belonging to one app using the `--app` flag:

```bash
specguard run matrix --app <name>
```

Replace `<name>` with the name of the app you want to scope to.

---

## Notes

- The matrix pipeline is **informational** — it always exits successfully regardless of coverage gaps. Missing tests or docs are surfaced in the output for your review, but they do not cause the pipeline to fail.
- Coverage gaps (specs with empty `tests` or `docs` arrays) are a useful starting point for prioritising new test or documentation work.
