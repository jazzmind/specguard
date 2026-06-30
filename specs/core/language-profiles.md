# Language Profiles

<!--
  module: src/core/language-profiles.ts
  type: core
  status: draft
-->

## Overview

The single source of truth for everything language-specific in SpecGuard. A `LanguageProfile` is a pure data+function record describing one supported target language: how to detect it, the default config it produces (`init`), how source paths map to feature keys, the LLM prompt fragments for test/security generation, how to parse test-runner output (`heal`), and which quality/audit runners apply.

Pipelines never hardcode `.test.ts`, `npm test`, `vitest`, or `.ts` regexes. Instead they call `resolveProfile(app)` and read the relevant field. This module also exposes `detectLanguage(cwd)` for `init` and `featureFromPath(absFile, repoDir, profile)` — the one place the source-path → feature-key derivation lives (previously duplicated in reverse/status/gap-analysis).

TypeScript is the default and its profile reproduces the previously-hardcoded values exactly, so existing configs (which have no `language` field) behave identically. Python is fully supported; Go, Rust, and Java are stubs (real detection/config/path-mapping, but generic test-gen prompts and `'unsupported'` runners).

## Acceptance Criteria

- [ ] `getProfile(id)` returns the profile for a `LanguageId`, throwing a clear error for an unknown id
- [ ] `resolveProfile(app)` returns the profile for `app.language`, defaulting to `'typescript'` when `language` is absent
- [ ] The `typescript` profile's `featureExtRegex`, `testExt`, `testFileCandidates`, `testCommand`, `testReporterArgs`, and `sourceGlobs` reproduce the values previously hardcoded in status/reverse/gap-analysis/heal/init exactly (e.g. `testFileCandidates('reader')` yields the `<feature>.{test,spec}.{ts,tsx,js,jsx}` matrix)
- [ ] `featureFromPath(absFile, repoDir, profile)` reproduces the legacy `deriveFeature` behavior: drop a leading `src/`/`tests/` segment, drop the next (area) segment, then apply each `featureExtRegex` entry in order
- [ ] `detectLanguage(cwd)` resolves a language by: marker files (per profile `detectFiles`), tie-broken by source-file count over `detectGlobs` with fixed priority `typescript > python > go > rust > java`, falling back to `'typescript'`
- [ ] The `python` profile has `capability: 'full'`, Python source globs, `pytest` framework/command, `_test.py` test extension, and a `parseTestOutput` that reads the pytest-json-report schema
- [ ] The `go`, `rust`, and `java` profiles have `capability: 'stub'`, real detection/config/path-mapping, generic prompt fragments, `parseTestOutput` returning `null`, and `'unsupported'` for all three runners
- [ ] No profile performs file I/O at module load; `detectLanguage` reads via `core/reader.ts`

## Scenarios

### Scenario 1: Resolve profile for a config without a language field

**Steps:**
1. Call `resolveProfile({ ...app })` for an app object with no `language` key.

**Expected Results:**
- Returns the `typescript` profile.

### Scenario 2: featureFromPath matches legacy deriveFeature for TypeScript

**Steps:**
1. With the `typescript` profile, call `featureFromPath('/repo/src/core/sub/reader.ts', '/repo', profile)`.

**Expected Results:**
- Returns `sub/reader` (leading `src` dropped, `core` area dropped, `.ts` stripped).

### Scenario 3: Detect Python by marker file

**Steps:**
1. A directory contains `pyproject.toml` and `*.py` files but no `package.json`.
2. Call `detectLanguage(dir)`.

**Expected Results:**
- Returns `'python'`.

### Scenario 4: Fallback to TypeScript

**Steps:**
1. A directory has no recognized marker files.
2. Call `detectLanguage(dir)`.

**Expected Results:**
- Returns `'typescript'`.

## Security Notes

- Detection reads only manifest/marker files and counts globbed paths; it never executes project code.

## Dependencies

- `src/core/reader.ts` (`fileExists`, `readFile`, `expandGlobs`)
- `src/core/types.ts` (`AppConfig`, `AppSources`)
- Consumed by: `init`, `status`, `reverse-generate`, `gap-analysis`, `forward-generate`, `security`, `matrix`, `heal`, `code-quality`, `dep-check`, `scaffold`
