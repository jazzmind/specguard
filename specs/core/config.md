# Config Loader

<!--
  module: src/core/config.ts
  type: core
  status: draft
-->

## Overview

Locates, reads, and validates the `.specguard/config.json` file that drives every SpecGuard command. The loader walks up from a starting directory to find the nearest `.specguard/` folder, parses the JSON, and validates it against a Zod schema that mirrors the `SpecGuardConfig` type. It also exposes the directory containing `.specguard/` as `rootDir` so downstream pipelines can resolve app-relative paths.

This module is the single entry point for config — pipelines never read the config file directly.

## Acceptance Criteria

- [ ] `loadConfig(cwd?)` searches for `.specguard/config.json` starting at `cwd` (default `process.cwd()`) and walking up parent directories
- [ ] Throws `ConfigNotFoundError` when no `.specguard/config.json` exists in any ancestor directory
- [ ] Reads and `JSON.parse`s the config file
- [ ] Validates parsed JSON against a Zod schema mirroring `SpecGuardConfig`
- [ ] Throws `ConfigInvalidError` with a readable message when validation fails
- [ ] Ignores the `_comment` field and tolerates unknown keys via passthrough
- [ ] Sets `rootDir` on the returned config to the directory containing `.specguard/`
- [ ] Successfully loads the repo's own `.specguard/config.json` without error
- [ ] The upward search stops at the repository boundary (the first directory containing `.git`), so a repo without its own config never silently inherits a parent repo's config <!-- claim: repo-boundary -->
- [ ] `"extends": "<path>"` (a config file, or a directory containing `.specguard/config.json`, resolved from the extending config's directory) is the only way to inherit another config: keys merge one level deep, arrays and `apps` in the child replace the parent's, and a cycle is a `ConfigInvalidError` <!-- claim: extends-explicit -->
- [ ] `paths` accepts `specsRoot`, `docsOut`, `securityTests`, and `proofLedger`, and replaces the hard-coded `specs/`, `docs/user`, `tests/security/` and `.specguard/proofs.json` locations <!-- claim: paths-block -->
- [ ] Each app accepts a `test` block `{ command, cwd, reporter, resultsFile, timeoutMs, image }`, and `runners.testRunner` may be `local` or `docker` <!-- claim: app-test-block -->
- [ ] Each app accepts `stripPrefix` (string or list) and `entryPoints` (list of paths or globs), and `plugins` / `featureState` are accepted at the top level <!-- claim: app-fields -->

## Scenarios

### Scenario 1: Load a valid config

**Steps:**
1. Call `loadConfig(repoRoot)` where `repoRoot` contains `.specguard/config.json`
2. Inspect the returned `SpecGuardConfig`

**Expected Results:**
- `config.apps` has at least one entry
- `config.llm.provider` equals `anthropic`
- `config.rootDir` is the directory containing `.specguard/`
- The `_comment` field does not cause an error

---

### Scenario 2: Config not found

**Steps:**
1. Call `loadConfig(emptyDir)` where no ancestor contains `.specguard/config.json`

**Expected Results:**
- A `ConfigNotFoundError` is thrown
- The error message references the directory the search started from

---

### Scenario 3: Invalid config (Zod failure)

**Steps:**
1. Point `loadConfig` at a `.specguard/config.json` missing required fields (e.g. no `apps` or no `llm`)

**Expected Results:**
- A `ConfigInvalidError` is thrown
- The message is human readable and describes which field failed

---

### Scenario 4: Walk up to a parent directory

**Steps:**
1. Call `loadConfig` from a nested subdirectory of the repo

**Expected Results:**
- The loader walks up parent directories and finds the repo's `.specguard/config.json`
- `rootDir` points at the repo root, not the nested subdirectory

## Dependencies

- `src/core/types.ts` — `SpecGuardConfig` and related types
- `src/core/errors.ts` — `ConfigNotFoundError`, `ConfigInvalidError`
- `src/core/reader.ts` — file existence and reads
- `zod` — schema validation
