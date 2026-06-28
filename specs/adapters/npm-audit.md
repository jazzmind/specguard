# npm-audit Adapter

<!-- module: src/adapters/npm-audit.ts -->
<!-- type: adapter -->
<!-- status: stable -->

## Overview

The npm-audit adapter runs `npm audit --json` in a project directory and normalises
the output into the same `SastFinding[]` shape used by the security pipeline. This
allows security test stubs to incorporate known dependency vulnerabilities alongside
Semgrep SAST findings.

Supports both npm audit v1 (advisories) and v2 (vulnerabilities) JSON formats.

## Acceptance Criteria

- `runNpmAudit(projectDir)` returns `NpmAuditResult { findings, ok }`.
- Parses npm audit v2 JSON (`vulnerabilities` key) into `SastFinding[]`.
- Parses npm audit v1 JSON (`advisories` key) into `SastFinding[]`.
- Each finding has `ruleId: 'npm-audit/<packageName>'`, `path: 'package.json'`, `message`, and `severity`.
- Returns `{ ok: false, findings: [] }` when npm is unavailable or output is not valid JSON. Never throws.
- `ok` is `true` even when findings are returned (findings are not an error condition).

## Scenarios

### Scenario 1: Vulnerabilities found (v2 format)
**Steps:**
1. `npm audit --json` returns v2 format with vulnerabilities

**Expected Results:**
- Returns `{ ok: true, findings: [{ ruleId: 'npm-audit/lodash', ... }] }`

### Scenario 2: No vulnerabilities
**Steps:**
1. `npm audit --json` returns clean output

**Expected Results:**
- Returns `{ ok: true, findings: [] }`

### Scenario 3: npm unavailable
**Steps:**
1. npm is not on PATH

**Expected Results:**
- Returns `{ ok: false, findings: [] }` without throwing

## Security Notes

- npm audit output may reveal internal package names and versions — treat as confidential.
- Never include audit output in LLM prompts in full; pass only the `findings` array.

## Dependencies

- Node.js `child_process.spawnSync`
- `src/pipelines/security.ts` (SastFinding type)
