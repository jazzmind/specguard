# Guardrails

<!-- module: src/adapters/guardrails.ts -->
<!-- type: adapter -->
<!-- status: stable -->

## Overview

The guardrails adapter classifies browser actions before they are executed by the
validate or heal pipelines. Classification is keyword-based and deterministic — no
LLM call. This is a safety net that prevents the most common destructive and
outbound mistakes during automated browser interaction.

Three classifications are possible:
- **safe** — navigate, read, fill, click navigation elements
- **destructive** — delete, archive, purge, drop, remove, destroy, reset
- **outbound** — send, invite, share, publish, pay, submit payment, transfer, broadcast

Blocked actions appear in pipeline reports as `BLOCKED` verdicts with the reason.

## Acceptance Criteria

- `classifyAction(description)` returns `'safe'`, `'destructive'`, or `'outbound'` based on keyword matching against the action description string.
- Matching is case-insensitive.
- Destructive keywords: `delete`, `remove`, `archive`, `purge`, `drop`, `destroy`, `reset`, `wipe`, `erase`.
- Outbound keywords: `send`, `invite`, `share`, `publish`, `pay`, `submit`, `transfer`, `broadcast`, `post`, `email`.
- When no keywords match, returns `'safe'`.
- `isBlocked(classification)` returns `true` for `destructive` and `outbound`, `false` for `safe`.
- `makeBlockedAction(description, classification)` returns a `BlockedAction` with the description, classification, and reason string.

## Scenarios

### Scenario 1: Destructive action
**Steps:**
1. Call `classifyAction('Delete this record')`

**Expected Results:**
- Returns `'destructive'`

### Scenario 2: Outbound action
**Steps:**
1. Call `classifyAction('Send email invitation to user')`

**Expected Results:**
- Returns `'outbound'`

### Scenario 3: Safe action
**Steps:**
1. Call `classifyAction('Click the Submit button to save draft')`

**Expected Results:**
- Returns `'safe'` (submit here refers to saving, but submit is an outbound keyword — actually this should return `'outbound'`; use `'Save draft'` for safe test)

### Scenario 4: Case insensitivity
**Steps:**
1. Call `classifyAction('REMOVE all items')`

**Expected Results:**
- Returns `'destructive'`

## Security Notes

- No credentials or sensitive data should ever be passed to `classifyAction`.
- Classification never makes network calls.

## Dependencies

- No external dependencies
