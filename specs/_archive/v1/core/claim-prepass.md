# Claim prepass

<!--
  module: src/core/claim-prepass.ts
  type: core
  status: draft
-->

## Overview

A deterministic pass shared by `matrix` and `align`. It collects an app's test files (from `testOutput`, `sources.tests`, `extraTestSources`, and CLI extras), scans them for claim tags and test titles, and tells each caller which claims and scenarios already have a test. `align` sends only what the prepass could not settle to the LLM.

## Acceptance Criteria

- [ ] `collectTestFiles` returns the union of the `testOutput` tree, `sources.tests` globs, `extraTestSources`, and extra globs, de-duplicated and sorted <!-- claim: collect-union -->
- [ ] `prepassSpec` marks a claim covered when any test carries a tag whose spec key equals the spec's key, with or without a `repo:` prefix <!-- claim: claim-coverage -->
- [ ] The spec key a tag is compared with is the canonical key, so with per-app spec dirs a tag `api/services/messaging#x` covers claim `x` of `specs/api/services/messaging.md` <!-- claim: canonical-tag-match -->
- [ ] `prepassSpec` marks a scenario covered when a test title contains the scenario name after case and punctuation are ignored <!-- claim: scenario-title-match -->
- [ ] `prepassSpec` returns the test files that carry tags for the spec so callers can include them <!-- claim: tagged-files -->

## Scenarios

### Scenario 1: Tag settles a claim

**Steps:**
1. A test file contains `it('awards once @claim:core/awards#award-once')`
2. Run `prepassSpec` for spec `core/awards`

**Expected Results:**
- `award-once` is covered and lists that file
