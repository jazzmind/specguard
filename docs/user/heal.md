---
title: "Self-Healing Test Pipeline"
sidebar_label: "Self-Healing Test Pipeline"
description: "The Self-Healing Test Pipeline automatically runs your test suite, uses an LLM to classify each failure as either a stale test or a real application bug, rewrites and re-runs failing tests up to a configurable retry limit, and produces a detailed heal report — never touching your application source code."
category: "pipelines"
order: 50
generated: true
---

# Self-Healing Test Pipeline

The Self-Healing Test Pipeline keeps your test suite green by automatically diagnosing and repairing tests that have drifted out of sync with your application. It runs your tests, asks an LLM to decide whether each failure is the *test's* fault or the *application's* fault, rewrites broken tests when appropriate, and repeats — all without ever modifying your application source code.

---

## How It Works

When you invoke the heal pipeline, it follows this sequence:

1. **Run your test suite.** The pipeline executes your configured test command and captures the results.
2. **Parse the failures.** It extracts every failing test — its file path, test name, and failure message — from the test runner's output.
3. **Classify each failure with the LLM.** For each failing test, the pipeline reads the test source (and, where available, the corresponding spec) and asks the LLM to make a determination:
   - **`test-bug`** — The test itself is wrong: a stale assertion, a drifted selector, bad setup, etc.
   - **`app-bug`** — The test is correct and has caught a real bug in the application.
4. **Rewrite and re-run (test bugs only).** When the LLM identifies a test bug, the pipeline rewrites the test file with the LLM's suggested fix and re-runs the full suite. This classify → rewrite → re-run loop repeats until the test passes or the retry budget is exhausted.
5. **Report application bugs without touching code.** When the LLM identifies an application bug, the failure is recorded with the LLM's reasoning and the pipeline moves on. Your application source is never modified.
6. **Produce a heal report.** After all retries are complete, the pipeline summarises how many tests were fixed, how many remain broken, and how many failures were attributed to application bugs.

---

## Configuration

The pipeline reads its settings from the `config.heal` block in your SpecGuard configuration file:

| Option | Default | Description |
|---|---|---|
| `testCommand` | `npm test` | The command used to run your test suite. |
| `maxRetries` | `2` | Maximum number of rewrite-and-re-run cycles per failing test. |

You can override either option at invocation time — per-invocation values always take precedence over the configuration file.

**Example `config.heal` block:**

```json
{
  "heal": {
    "testCommand": "npx vitest run",
    "maxRetries": 3
  }
}
```

---

## Test Runner Integration

The pipeline appends vitest's JSON reporter to your test command automatically:

```
<testCommand> -- --reporter=json
```

This produces a Jest-compatible JSON document on stdout that the pipeline parses to identify failures. The parser is tolerant of extra output surrounding the JSON (log lines, banners, etc.) — it locates the first complete `{...}` object in stdout and parses that.

A failing test is any entry in `assertionResults` with `"status": "failed"`. The pipeline records:
- **File** — the absolute path from `testResults[].name`
- **Test name** — from the `title` or `fullName` field
- **Failure message** — the joined contents of `failureMessages`

If the JSON output cannot be located or parsed at all, the pipeline records a `"could not parse test output"` message and continues gracefully — it never crashes due to malformed runner output.

---

## Early Exit: All Tests Passing

If the initial test run produces no failures, the pipeline exits immediately with exit code `0` and the message `"all tests passing"`. No LLM calls are made.

---

## The Heal Report

After the pipeline finishes, it appends a human-readable summary to the result messages. The report breaks down results into three categories:

- **Fixed** — tests that were classified as test bugs and successfully repaired within the retry budget.
- **Still broken** — tests that were classified as test bugs but could not be fixed after all retries.
- **App bugs** — tests that the LLM determined are correctly catching real application bugs.

### Exit Codes

| Condition | Exit Code |
|---|---|
| All tests passing (or all test-bugs fixed) | `0` |
| Any tests remain broken after retries (including app-bugs) | `7` (`HealFailed`) |

An exit code of `7` means the suite is still red — either some test rewrites did not succeed within the retry budget, or the LLM identified application bugs that need developer attention.

---

## What the Pipeline Will and Won't Do

| Action | Behaviour |
|---|---|
| Rewrite a failing test file | ✅ Yes, when classified as a test bug |
| Re-run the full suite after a rewrite | ✅ Yes, up to `maxRetries` times |
| Modify application source code | ❌ Never |
| Report application bugs with reasoning | ✅ Yes, as failed pipeline items |
| Make LLM calls when no tests are failing | ❌ Never |

---

## Dependencies

The Self-Healing Test Pipeline builds on several SpecGuard core subsystems:

- **LLM** — All language model calls are routed through the central LLM module (`llmGenerateObject`) for structured classification responses.
- **Reader / Writer** — All test file reads and rewrites go through the standard file I/O abstractions.
- **Spec Parser** — Used to locate the spec file corresponding to a test file, giving the LLM additional context when classifying failures.
- **Exit Codes** — Uses the shared `HealFailed` exit code (`7`) to signal an unresolved red suite.
