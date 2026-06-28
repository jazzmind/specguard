---
title: "Validate Pipeline"
sidebar_label: "Validate Pipeline"
description: "The Validate Pipeline drives a real browser against your running application to verify that every acceptance criterion in a Living Specification is actually met, producing evidence-backed verdicts of PASS, FAIL, BLOCKED, or INCONCLUSIVE."
category: "pipelines"
order: 10
generated: true
---

# Validate Pipeline

The Validate Pipeline is SpecGuard's core verification engine. It launches a real browser, navigates to your application, and checks whether every acceptance criterion defined in a Living Specification is genuinely satisfied — not just assumed. Results are backed by concrete evidence and written to a persistent history file so you can track quality over time.

---

## How It Works

The pipeline follows a four-stage **PERCEIVE → PLAN → ACT → VERIFY** loop for each specification it processes.

### 1. PERCEIVE
SpecGuard navigates to the URL declared in the spec's metadata, then captures a screenshot and an accessibility snapshot of the page. This gives the pipeline a ground-truth view of the application's current state.

### 2. PLAN
An LLM compares the acceptance criteria from the spec against the perceived page state and produces a sequence of interaction steps needed to exercise the feature under test.

### 3. ACT
The planned steps are executed in the browser via Playwright. Before any action runs, the built-in **guardrails** layer inspects it. Any action classified as `destructive` or `outbound` is blocked and never executed, keeping your data and external services safe.

### 4. VERIFY
After the interactions complete, the LLM evaluates each acceptance criterion against the resulting page state and assigns a **verdict**.

---

## Verdicts

Every acceptance criterion in a spec receives exactly one of the following verdicts:

| Verdict | Meaning |
|---|---|
| `PASS` | The criterion is demonstrably satisfied. |
| `FAIL` | The criterion is not met. Evidence is always cited (screenshot path, HTTP status, or console error). |
| `BLOCKED` | The pipeline could not reach the state needed to evaluate the criterion (e.g., a required action was blocked by guardrails). |
| `INCONCLUSIVE` | The available evidence was insufficient to make a definitive determination. |

---

## Running the Pipeline

Use the `--spec` flag to validate a single specification, or `--all` to validate every spec that declares a `url:` metadata field.

```bash
# Validate one spec by its key
specguard validate --spec my-feature/login

# Validate all specs that have a url: field
specguard validate --all
```

> **Note:** Any spec that does not have a `url:` metadata field is automatically skipped. You will see a `[skip]` message in the output for those specs.

---

## Authentication

If a spec includes an `auth:` metadata field referencing an auth profile, the pipeline automatically invokes the auth state machine before beginning the PERCEIVE stage. This ensures the browser session is authenticated correctly before any criteria are evaluated.

---

## Evidence & Results

### Evidence Files
For every spec that is validated, SpecGuard saves supporting evidence to:

```
.specguard/evidence/<spec-key>/
```

Evidence can include screenshots, recorded HTTP status codes, and captured browser console errors. Every `FAIL` verdict is required to reference at least one piece of evidence from this directory.

### Validation History
All results are appended to a single history file:

```
.specguard/validation-history.json
```

This file accumulates runs over time, giving you a full audit trail of when criteria passed or failed.

---

## Exit Codes

The pipeline communicates its overall outcome through the process exit code, making it straightforward to integrate with CI/CD pipelines.

| Exit Code | Meaning |
|---|---|
| `0` | All acceptance criteria passed. |
| `1` (`ValidationFailed`) | One or more criteria received a `FAIL` verdict. |

---

## Spec Metadata Reference

The following metadata fields in your Living Specification affect how the Validate Pipeline behaves:

| Field | Required | Description |
|---|---|---|
| `url:` | **Yes** | The URL the pipeline navigates to. Specs without this field are skipped. |
| `auth:` | No | References an auth profile. When present, the auth state machine is invoked before validation begins. |
