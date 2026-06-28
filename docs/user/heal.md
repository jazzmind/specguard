---
title: "Self-Healing Test Pipeline"
sidebar_label: "Self-Healing Test Pipeline"
generated: true
---

# Self-Healing Test Pipeline

## What It Does

The Self-Healing Test Pipeline runs your project's test suite and automatically attempts to fix any failing tests. For each failure, it asks an AI model to determine *who is at fault*:

- **The test itself** — a stale assertion, a drifted selector, or bad test setup that no longer reflects the current codebase.
- **The application** — a real bug that the test correctly caught.

When the test is at fault, the pipeline rewrites the test code and re-runs the suite, repeating this loop until all fixable tests pass or the retry budget is exhausted. When the application is at fault, the pipeline reports the bug clearly and **never modifies your application source code**.

At the end of a run, you receive a heal report summarising how many tests were fixed, how many remain broken, and how many failures point to genuine application bugs.

---

## Configuration

The pipeline reads its settings from the `config.heal` section of your project configuration:

| Setting | Default | Description |
|---|---|---|
| `testCommand` | `npm test` | The command used to run your test suite. |
| `maxRetries` | `2` | How many times the pipeline will attempt to rewrite and re-run failing tests before giving up. |

Both settings can be overridden at invocation time, so you can run a one-off heal with a different command or a higher retry budget without changing your config file.

---

## How a Heal Run Works

### 1. Running the Suite

The pipeline runs your configured test command with Vitest's JSON reporter appended automatically. It captures the full output and exit code — a failing suite does not stop the pipeline from continuing.

### 2. Parsing Results

The pipeline extracts the structured JSON test report from the command output, even if the output contains extra noise around it. For each test result, it identifies:

- The **file path** of the test.
- The **test name**.
- The **failure message**.

If the output cannot be parsed at all (for example, if the runner produced no JSON), the pipeline records a "could not parse test output" message and continues gracefully — it will never crash due to malformed output.

If **no tests are failing**, the pipeline exits immediately with a clean result and makes no AI calls.

### 3. Classifying Each Failure

For every failing test, the pipeline reads the test source file and, where available, the corresponding specification for additional context. It then asks the AI model to classify the failure as one of:

- **`test-bug`** — the test code needs to be updated.
- **`app-bug`** — the application code has a real defect.

The AI provides a reason for its classification alongside any proposed fix.

### 4. Fixing Test Bugs

When a failure is classified as `test-bug`, the pipeline:

1. Writes the AI's corrected test code to the test file.
2. Re-runs the full test suite.
3. Checks whether the previously failing tests now pass.

This classify → rewrite → re-run loop repeats up to `maxRetries` times. If a test is still failing after all retries, it is recorded as **still-broken**.

### 5. Reporting Application Bugs

When a failure is classified as `app-bug`, the pipeline records it as a failed item with the AI's reason as the message. **No application source files are touched.** These failures count against the final exit code because the suite is still red.

---

## The Heal Report

After all retries are complete, the pipeline produces a summary with three counts:

- **Fixed** — tests that were failing and are now passing.
- **Still-broken** — tests that remained failing after all retry attempts.
- **App-bugs** — tests that correctly identified a defect in the application.

These counts are included as readable lines in the pipeline result output.

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | All tests are passing — nothing needed fixing, or all fixable tests were healed. |
| `7` (`HealFailed`) | One or more tests remain broken after retries, including any app-bug failures. |

Exit code `7` means your suite is still red and human attention is required — either to fix the application bug the test caught, or to investigate a test the pipeline could not automatically repair.

---

## What the Pipeline Will Never Do

- Modify application source code, even if it believes the application is buggy.
- Crash or throw an error due to unparseable test runner output.
- Make AI calls when all tests are already passing.
