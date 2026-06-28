---
title: "Import Pipeline"
sidebar_label: "Import Pipeline"
description: "The Import Pipeline transforms existing requirement documents — such as PRDs, Jira exports, or Markdown notes — into Living Specification format, giving brownfield teams a fast on-ramp into SpecGuard."
category: "pipelines"
order: 10
generated: true
---

# Import Pipeline

The Import Pipeline is your starting point if your team already has requirements documentation outside of SpecGuard. It reads an existing document — a PRD, a Jira export, a plain Markdown file, or any text-based source — and uses an LLM to reshape it into the standard Living Specification format. From that point on, the generated spec file becomes the single source of truth; the original document is no longer authoritative.

---

## Supported Input Sources

You can point the Import Pipeline at any of the following:

| Source type | Example |
|---|---|
| Markdown file | `./docs/my-feature.md` |
| Plain text file | `./notes/requirements.txt` |
| Remote URL (HTTPS) | `https://example.com/prd.md` |

Remote URLs are fetched securely over HTTPS.

---

## What Gets Generated

The LLM transforms your source document into a fully structured Living Spec file containing all standard sections:

- **H1 title** — derived from the document's own title
- **Metadata comment block**
- **Overview**
- **Acceptance Criteria**
- **Scenarios**
- **Security Notes**

The output file is written to your configured spec directory (`app.specDir`) and named using a URL-friendly slug derived from the document's title (its H1 heading, or first line if no heading is present). For example, a document titled *"User Authentication Flow"* would produce `user-authentication-flow.md`.

---

## Basic Usage

```bash
specguard import <source>
```

Where `<source>` is a file path or a URL.

**Examples:**

```bash
# Import a local Markdown file
specguard import ./docs/onboarding-prd.md

# Import a plain text file
specguard import ./notes/billing-requirements.txt

# Import from a remote URL
specguard import https://example.com/specs/search-feature.md
```

---

## Options

### `--app <name>`

Specifies which app's `specDir` the output file should be written to. This option is **required** when your SpecGuard configuration defines multiple apps.

```bash
specguard import ./docs/prd.md --app payments
```

### `--out <path>`

Overrides the default output path entirely. Use this when you want to control exactly where the generated spec file is saved, regardless of `specDir` or the derived name.

```bash
specguard import ./docs/prd.md --out ./specs/custom-name.md
```

### `--force`

By default, if a spec file with the same derived name already exists in the target directory, the import is **skipped** to prevent accidental overwrites. Pass `--force` to overwrite the existing file.

```bash
specguard import ./docs/prd.md --force
```

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Import completed successfully |
| `1` | An error occurred |

---

## Tips & Gotchas

- **The generated spec is the source of truth.** Once imported, edit the `.md` spec file directly — do not re-import the original document to make changes, as this will overwrite your work (unless you use `--force` intentionally).
- **Duplicate protection is on by default.** If you run the same import twice without `--force`, the second run is safely skipped.
- **Multi-app projects need `--app`.** If your config defines more than one app, SpecGuard cannot infer which `specDir` to use — always supply `--app` in that case.
