---
title: "Validate Pipeline"
sidebar_label: "Validate Pipeline"
generated: true
---

# Validate Pipeline

The Validate Pipeline is SpecGuard's core verification engine. It opens a real browser, navigates to your running application, and checks whether every acceptance criterion in your Living Specifications is actually being met — producing evidence-backed verdicts you can trust.

## How It Works

The pipeline runs each specification through a four-stage loop:

1. **Perceive** — SpecGuard navigates to the URL defined in your spec, captures a screenshot, and collects an accessibility snapshot of the page.
2. **Plan** — The AI compares your acceptance criteria against what it perceived and plans the interaction steps needed to verify each one.
3. **Act** — Those steps are executed in a real browser via Playwright. Any actions classified as destructive or outbound are automatically blocked before they run.
4. **Verify** — The AI evaluates the outcome of each action against your acceptance criteria and assigns a verdict.

## Verdicts

Every acceptance criterion in a spec receives one of four verdicts:

| Verdict | Meaning |
|---|---|
| `PASS` | The criterion is met. |
| `FAIL` | The criterion is not met. A piece of evidence (screenshot path, HTTP status, or console error) is always cited. |
| `BLOCKED` | The action required to verify this criterion was blocked by guardrails. |
| `INCONCLUSIVE` | SpecGuard could not determine whether the criterion is met or not. |

## Running Validations

Validate a single spec by its key:

```
specguard validate --spec <key>
```

Validate all specs that have a `url:` field defined:

```
specguard validate --all
```

### Spec Requirements

Each spec must include a `url:` field in its metadata for the pipeline to navigate to your application. Specs without a `url:` field are skipped automatically.

If your spec includes an `auth:` metadata field referencing an auth profile, SpecGuard will invoke the auth state machine to establish the correct session before validation begins.

## Evidence and Results

All evidence collected during a run — screenshots, HTTP status codes, and console errors — is saved to:

```
.specguard/evidence/<spec-key>/
```

Every run appends its results to `.specguard/validation-history.json`, giving you a persistent record of how your specs have fared over time.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | All criteria passed. |
| `1` | One or more criteria failed. |

This makes the Validate Pipeline straightforward to integrate into CI workflows — a non-zero exit code signals that your application is not meeting its specification.
