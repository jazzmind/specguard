---
title: "Import Pipeline"
sidebar_label: "Import Pipeline"
generated: true
---

# Import Pipeline

## Overview

The Import Pipeline is your starting point when you already have requirements documentation — product requirement docs (PRDs), Jira exports, plain Markdown notes, or anything in between. It reads your existing document and transforms it into a properly structured Living Specification, making that new spec file the authoritative source of truth going forward.

---

## Supported Input Types

You can point the importer at any of the following sources:

| Input | Description |
|---|---|
| `.md` file | A local Markdown file |
| `.txt` file | A local plain-text file |
| URL | Any publicly reachable `https://` URL |

---

## What Gets Generated

The importer uses an LLM to restructure your source document into the standard Living Spec format, which includes:

- An **H1 title** and metadata header
- An **Overview** section
- **Acceptance Criteria**
- **Scenarios**
- **Security Notes**

The output file is written to your app's configured spec directory (`specDir`) and named after the source document. The filename is derived by slugifying the document's title — taken from its H1 heading or, if none is present, its first line.

For example, a document titled **"User Authentication Flow"** would produce a file named `user-authentication-flow.md`.

---

## Basic Usage

```
specguard import <file-or-url>
```

### Examples

Import a local Markdown file:

```
specguard import ./docs/auth-requirements.md
```

Import a plain-text file:

```
specguard import ./notes/onboarding.txt
```

Import from a URL:

```
specguard import https://example.com/requirements/payments.md
```

---

## Options

### `--app <name>`

Specifies which app's `specDir` the output file should be written to. This flag is **required** when your configuration defines more than one app.

```
specguard import ./requirements.md --app payments-service
```

### `--out <path>`

Overrides the default output path entirely, writing the generated spec to the location you specify instead.

```
specguard import ./requirements.md --out ./specs/custom-name.md
```

### `--force`

By default, if a spec file with the same derived name already exists in the target directory, the import is skipped to prevent accidental overwrites. Pass `--force` to overwrite the existing file.

```
specguard import ./requirements.md --force
```

---

## Behavior & Notes

- **The generated spec becomes the source of truth.** Once imported, you should treat the Living Spec file — not the original document — as the canonical record of your requirements.
- **Existing files are protected by default.** Without `--force`, the importer will not overwrite a spec that already exists at the target path.
- The command exits with code `0` on success and `1` if an error occurs.
