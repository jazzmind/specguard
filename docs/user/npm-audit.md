---
title: "npm-audit Adapter"
sidebar_label: "npm-audit Adapter"
description: "The npm-audit adapter runs npm audit in your project directory and normalises the results into the same finding shape used by the security pipeline, letting you surface dependency vulnerabilities alongside SAST findings."
category: "adapters"
order: 50
generated: true
---

# npm-audit Adapter

The **npm-audit adapter** integrates Node.js dependency vulnerability scanning into SpecGuard's security pipeline. It runs `npm audit --json` inside your project directory and normalises the results into the same `SastFinding[]` shape used by the rest of the security pipeline — meaning known dependency vulnerabilities appear right alongside your Semgrep SAST findings, in a single unified report.

---

## How It Works

When invoked, the adapter:

1. Runs `npm audit --json` in the specified project directory using Node.js's built-in `child_process.spawnSync`.
2. Parses the JSON output — supporting **both** the npm audit v1 format (keyed on `advisories`) and the npm audit v2 format (keyed on `vulnerabilities`).
3. Normalises each vulnerability into a `SastFinding` object with the following fields:

| Field | Value |
|---|---|
| `ruleId` | `npm-audit/<packageName>` |
| `path` | `package.json` |
| `message` | Human-readable description of the vulnerability |
| `severity` | Severity level reported by npm audit |

4. Returns a result object of the shape `NpmAuditResult { findings, ok }`.

---

## Return Value

The adapter always returns an `NpmAuditResult` object — it **never throws**. The shape is:

```ts
{
  ok: boolean;
  findings: SastFinding[];
}
```

- **`findings`** — An array of normalised `SastFinding` objects, one per detected vulnerability. This array is empty when there are no vulnerabilities or when the adapter cannot run.
- **`ok`** — A boolean indicating whether the adapter ran and produced valid output successfully.
  - `true` — npm audit ran and its output was parsed successfully. Note that `ok: true` does **not** mean your project is vulnerability-free; findings may still be present.
  - `false` — npm was unavailable in the environment, or the output was not valid JSON. In this case, `findings` will be an empty array.

> **Tip:** Think of `ok` as a health signal for the adapter itself, not a pass/fail verdict on your dependencies. A non-empty `findings` array alongside `ok: true` is the normal, expected result when vulnerabilities are detected.

---

## npm Audit Format Compatibility

The adapter transparently handles both major npm audit JSON formats:

- **v1** (npm 6 and earlier) — output uses the `advisories` key.
- **v2** (npm 7 and later) — output uses the `vulnerabilities` key.

No configuration is required; the adapter detects the format automatically.

---

## Usage

Call `runNpmAudit` with the path to your project directory:

```ts
import { runNpmAudit } from './adapters/npm-audit';

const { ok, findings } = runNpmAudit('/path/to/your/project');

if (!ok) {
  console.warn('npm audit could not be run. Is npm available in this environment?');
} else {
  console.log(`Found ${findings.length} dependency vulnerability finding(s).`);
}
```

The returned `findings` can be passed directly into the security pipeline alongside any Semgrep SAST findings, since they share the same `SastFinding[]` type.

---

## Error Handling

The adapter is designed to be safe to call in any environment:

- If `npm` is not installed or not on the `PATH`, the adapter returns `{ ok: false, findings: [] }`.
- If `npm audit` produces output that is not valid JSON (e.g. due to an unexpected error), the adapter returns `{ ok: false, findings: [] }`.
- The adapter will **never throw an exception**, so it is safe to use without a surrounding `try/catch`.

---

## Finding Shape Reference

Each normalised finding conforms to the `SastFinding` type from the security pipeline:

```ts
{
  ruleId: 'npm-audit/<packageName>',  // e.g. 'npm-audit/lodash'
  path: 'package.json',
  message: string,                    // Vulnerability description from npm audit
  severity: string,                   // e.g. 'high', 'critical', 'moderate'
}
```

This consistent shape means vulnerability findings from `npm audit` are fully interoperable with findings from other security pipeline adapters such as Semgrep.
