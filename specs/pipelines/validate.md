# Validate Pipeline

<!-- module: src/pipelines/validate.ts -->
<!-- type: pipeline -->
<!-- status: stable -->

## Overview

The validate pipeline drives a real browser against the running application and
verifies that acceptance criteria from each Living Specification are actually met.
It implements the PERCEIVE-PLAN-ACT-VERIFY loop and produces evidence-backed verdicts.

For each spec:
1. **PERCEIVE** — Navigate to the URL from spec metadata, collect screenshot + a11y snapshot
2. **PLAN** — LLM compares acceptance criteria against perceived state, plans interaction steps
3. **ACT** — Execute planned actions via Playwright; guardrails block destructive/outbound actions before execution
4. **VERIFY** — LLM evaluates whether each acceptance criterion is met, assigns a verdict

Verdicts are `PASS`, `FAIL`, `BLOCKED`, or `INCONCLUSIVE` per acceptance criterion.
Evidence (screenshots, HTTP status, console errors) is saved to `.specguard/evidence/<spec-key>/`.
Results are appended to `.specguard/validation-history.json`.

## Acceptance Criteria

- `runValidate(config, opts)` returns a `PipelineResult` with verdicts in `messages`.
- Each spec requires a `url:` metadata field; specs without one are skipped with `[skip]` message.
- Auth state machine is invoked when spec has an `auth:` metadata field referencing a profile.
- Each acceptance criterion in the spec is evaluated and receives one verdict: `PASS`, `FAIL`, `BLOCKED`, or `INCONCLUSIVE`.
- Every `FAIL` verdict must cite evidence (screenshot path, HTTP status, or console error).
- Actions classified as `destructive` or `outbound` by the guardrails are blocked before execution.
- Exit code is `1` (ValidationFailed) when any criterion is `FAIL`; `0` when all pass.
- Results are appended to `.specguard/validation-history.json`.
- `--spec <key>` validates a single spec; `--all` validates all specs with a `url:` field.
- [ ] Each auth profile gets its own browser context, and a spec without `auth:` runs in an anonymous context that is never logged in <!-- claim: one-context-per-profile -->
- [ ] The browser is headless unless `validate.headless` is false or `--headed` is passed <!-- claim: headless-config -->
- [ ] `--allow-outbound` (or `validate.guardrails.allowOutbound`) lets outbound actions run; destructive actions stay blocked <!-- claim: allow-outbound -->
- [ ] DOM text, accessibility text and console errors are passed through the redactor before they reach the LLM <!-- claim: redact-before-llm -->
- [ ] When `llm.allowImages` is false no screenshot is sent to the LLM <!-- claim: images-gated -->
- [ ] `.specguard/evidence`, `.specguard/auth` and `.specguard/reports` get a `.gitignore` that ignores their contents <!-- claim: evidence-gitignored -->
- [ ] When `runners.playwright` is `docker` the pipeline uses the docker adapter instead of a local browser <!-- claim: docker-runner -->

## Scenarios

### Scenario 1: All criteria pass
**Steps:**
1. Navigate to spec's URL
2. Acceptance criteria are all met in the perceived state

**Expected Results:**
- All verdicts are `PASS`
- Exit code 0
- History entry written

### Scenario 2: Criterion fails with evidence
**Steps:**
1. Navigate to spec's URL
2. LLM determines a criterion is not met
3. Evidence (screenshot) exists

**Expected Results:**
- Verdict is `FAIL` with evidence path cited in message
- Exit code 1

### Scenario 3: Spec has no URL metadata — skipped
**Steps:**
1. Spec does not have a `url:` field in metadata

**Expected Results:**
- Item status is `skipped` with reason `no url in spec metadata`
- Exit code remains 0 if no other failures

### Scenario 4: Action blocked by guardrails
**Steps:**
1. LLM plans an action classified as destructive
2. Guardrails block it before execution

**Expected Results:**
- Verdict is `BLOCKED` for that criterion
- Action appears in messages as `[blocked]`

## Security Notes

- Auth credentials must never appear in evidence files, messages, or history JSON.
- Always call `redact()` on error messages from the auth state machine.
- Evidence screenshots may contain PII — document this in the report.

## Dependencies

- `src/adapters/playwright.ts`
- `src/adapters/auth-state-machine.ts`
- `src/adapters/guardrails.ts`
- `src/core/llm.ts`
- `src/core/spec-parser.ts`
