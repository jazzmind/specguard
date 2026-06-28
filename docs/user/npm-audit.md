---
title: "npm-audit Adapter"
sidebar_label: "npm-audit Adapter"
generated: true
---

# npm-audit Adapter

## Overview

The **npm-audit adapter** integrates Node.js dependency vulnerability scanning into your security pipeline. It runs `npm audit` against your project and normalises the results into the same finding format used by Semgrep SAST checks — so you get a unified view of both code-level and dependency-level security issues in one place.

The adapter handles both the npm audit v1 and v2 JSON output formats automatically, so it works regardless of which version of npm your project uses.

---

## What It Does

When invoked, the adapter runs `npm audit --json` inside your project directory and converts the output into a list of `SastFinding` objects. These findings slot directly into the security pipeline alongside any Semgrep results, letting your test stubs and pipeline tooling treat dependency vulnerabilities and static analysis findings uniformly.

---

## Usage

Call `runNpmAudit` with the path to your project directory:

```ts
const { findings, ok } = await runNpmAudit('/path/to/your/project');
```

### Return Value

`runNpmAudit` returns an `NpmAuditResult` object with two fields:

| Field | Type | Description |
|---|---|---|
| `findings` | `SastFinding[]` | The list of vulnerability findings discovered by `npm audit`. May be empty. |
| `ok` | `boolean` | Whether the adapter ran successfully. See details below. |

**`ok` does not indicate whether vulnerabilities were found.** A result with `ok: true` and a non-empty `findings` array simply means the adapter ran successfully and found some issues — this is expected and normal. `ok` is only `false` when the adapter itself could not complete its work (for example, if npm is not available or produced unexpected output).

---

## Finding Format

Each entry in the `findings` array follows the standard `SastFinding` shape used across the security pipeline:

| Field | Value |
|---|---|
| `ruleId` | `npm-audit/<packageName>` — identifies the vulnerable package |
| `path` | `package.json` |
| `message` | A description of the vulnerability |
| `severity` | The severity level reported by npm |

For example, a vulnerability in the `lodash` package would produce a finding with `ruleId: 'npm-audit/lodash'`.

---

## Error Handling

The adapter is designed to be safe to call in any environment. It **never throws**. If npm is not installed, is not accessible in the current environment, or produces output that cannot be parsed as JSON, `runNpmAudit` returns:

```ts
{ ok: false, findings: [] }
```

This means you can safely include the adapter in CI pipelines and test stubs without needing to guard against exceptions.

---

## Format Compatibility

The adapter transparently supports both npm audit output formats:

- **v2** (npm 7+) — uses the `vulnerabilities` key in the JSON output
- **v1** (npm 6 and earlier) — uses the `advisories` key in the JSON output

No configuration is needed; the adapter detects the format automatically.
