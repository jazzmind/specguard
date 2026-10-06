# Redaction

<!--
  module: src/core/redact.ts
  type: core
  status: draft
-->

## Overview

The redactor masks personal data in text collected from a browser (DOM text, accessibility snapshots, console errors) before the validate pipeline sends it to an LLM. Built-in masks cover email, phone, SSN and card numbers; projects add regex patterns, selectors to blank, or a hook module.

## Acceptance Criteria

- [ ] Built-in masks replace email addresses, phone numbers, US SSNs and Luhn-valid card numbers with fixed placeholders <!-- claim: builtin-masks -->
- [ ] `validate.redaction.patterns` adds project regexes and `builtin: false` turns the built-in masks off <!-- claim: custom-patterns -->
- [ ] `validate.redaction.blankSelectors` lists selectors whose text content is blanked before the snapshot is taken <!-- claim: blank-selectors -->
- [ ] `hookPath` loads a module whose default export `(text, kind) => string` runs after the built-in masks, and a non-function export is an error <!-- claim: hook -->
- [ ] Redaction is applied to every `kind` (`dom`, `a11y`, `console`, `text`) and is idempotent <!-- claim: all-kinds -->

## Scenarios

### Scenario 1: Email masked

**Steps:**
1. Redact `Contact jane@example.com`

**Expected Results:**
- The email is replaced by a placeholder

## Dependencies

- No external dependencies
