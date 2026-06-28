---
title: "Matrix Pipeline"
sidebar_label: "Matrix Pipeline"
description: "The Matrix Pipeline generates a traceability matrix that cross-references your specs, test files, documentation, and source modules, helping teams instantly see which requirements are covered and which are not."
category: "pipelines"
order: 50
generated: true
---

# Matrix Pipeline

The Matrix Pipeline gives your team a living traceability matrix — a structured map that cross-references every spec against its related test files, documentation pages, and source modules. At a glance, you can answer questions like:

- *"Which tests cover this requirement?"*
- *"Which requirements have no tests yet?"*

---

## How It Works

When you run the Matrix Pipeline, SpecGuard scans your project and builds a matrix entry for every spec it finds. Each entry records:

| Field | Description |
|---|---|
| `specKey` | The unique identifier for the spec |
| `title` | The human-readable spec title |
| `tests` | Paths to matched test files |
| `docs` | Paths to matched documentation files |
| `sources` | Paths to matched source module files |

### Matching Rules

SpecGuard uses simple, predictable basename matching to link files to specs:

- **Test files** — A test file matches a spec when its basename (with `.test.ts` removed) matches the spec key's basename. For example, `auth-login.test.ts` matches the spec key `auth-login`.
- **Doc files** — A doc file matches a spec when its basename (with `.md` removed) matches the spec key's basename. For example, `auth-login.md` matches `auth-login`.
- **Source files** — Source files are taken directly from the spec's `module:` metadata field when it is present, rather than inferred by name.

---

## Output

By default, the matrix is written to:

```
.specguard/traceability.json
```

You can change this path using the `matrix.output` option in your SpecGuard configuration file.

### JSON Output

The default JSON output contains an array of matrix entries, one per spec:

```json
[
  {
    "specKey": "auth/auth-login",
    "title": "User Login",
    "tests": ["src/auth/auth-login.test.ts"],
    "docs": ["docs/auth-login.md"],
    "sources": ["src/auth/login.ts"]
  }
]
```

### CSV Output

For compliance teams or reporting workflows, you can request CSV output using the `--format csv` flag. The CSV file includes the following columns:

| Column | Description |
|---|---|
| `specKey` | The spec's unique key |
| `title` | The spec title |
| `testCount` | Number of matched test files |
| `docCount` | Number of matched doc files |
| `sourceModule` | The source module path (from `module:` metadata) |

```
specKey,title,testCount,docCount,sourceModule
auth/auth-login,User Login,1,1,src/auth/login.ts
```

---

## Usage

Run the Matrix Pipeline using the SpecGuard CLI:

```bash
# Generate the default JSON traceability matrix
specguard run matrix

# Generate a CSV matrix for compliance reporting
specguard run matrix --format csv

# Scope the matrix to a single app's specs
specguard run matrix --app <name>
```

### Options

| Flag | Description |
|---|---|
| `--format csv` | Write output as a CSV file instead of JSON |
| `--app <name>` | Scope the matrix to only the specs belonging to the named app |

---

## Exit Behaviour

The Matrix Pipeline is **informational** — it always exits with code `0`. It will never fail your CI pipeline, regardless of how many specs are unmatched. Use the output to inform your team, not to gate builds.

---

## Configuration Reference

You can configure the output path in your SpecGuard config file:

```yaml
matrix:
  output: .specguard/traceability.json  # default
```

Change `output` to any relative path where you'd like the matrix file written.
