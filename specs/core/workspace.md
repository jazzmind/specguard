# Workspace

<!-- module: src/core/workspace.ts -->
<!-- type: core -->
<!-- status: stable -->

## Overview

The workspace module provides the workspace manifest loader and related utilities. A workspace manifest (`<workspace>/.specguard/workspace.json`) sits one level above individual per-repo `.specguard/config.json` files and registers every repo participating in the system.

The workspace manifest enables workspace-level pipelines (`contracts`, `impact`, `workspace drift`) to operate across multiple repos without requiring a monorepo structure.

## Acceptance Criteria

- [ ] `loadWorkspace(cwd)` walks up from `cwd` to find `.specguard/workspace.json`
- [ ] Throws `ConfigNotFoundError` when no manifest is found in any ancestor directory
- [ ] Throws `ConfigInvalidError` when the file is not valid JSON or fails schema validation
- [ ] Stamps `rootDir` (the dir containing `.specguard/`) on the loaded manifest
- [ ] `loadWorkspaceWithConfigs(cwd)` augments each repo with its loaded SpecGuard config
- [ ] Repos without a `.specguard/config.json` get `specGuardConfig: null` (not an error)
- [ ] `resolveRepoPath(manifest, repoKey)` returns the absolute path of a repo
- [ ] `hasWorkspace(cwd)` returns boolean without throwing
- [ ] Unknown fields in manifest are preserved (passthrough schema)
- [ ] An optional `catalog` path, relative to the workspace root, names the shared feature catalog directory
- [ ] `workspaceRepoKey(dirName)` derives a repo key from the directory name alone: lowercase, non-alphanumeric runs become `-`, with no platform prefix stripped <!-- claim: generic-repo-key -->
- [ ] `guessRepoRole(dir)` derives `test`, `docs`, `provider`, or `consumer` from the repo's contents (its SpecGuard config frameworks, `package.json` dependencies, OpenAPI/GraphQL schema files, language markers), never from the directory name <!-- claim: role-from-content -->

## Scenarios

### Scenario 1: Load workspace manifest
**Steps:**
1. `.specguard/workspace.json` exists at workspace root
2. Call `loadWorkspace('/workspace/admin-app')` (starting from a child repo)
**Expected Results:**
- Walks up and finds the manifest at the workspace root
- `manifest.rootDir` is set to the workspace root
- `manifest.repos` contains all registered repos

### Scenario 2: Missing manifest
**Steps:**
1. No `.specguard/workspace.json` exists in any ancestor
2. Call `loadWorkspace(cwd)`
**Expected Results:**
- Throws `ConfigNotFoundError`

### Scenario 3: Repos with and without SpecGuard
**Steps:**
1. Workspace has 3 repos: 2 with `.specguard/config.json`, 1 without
2. Call `loadWorkspaceWithConfigs(cwd)`
**Expected Results:**
- All 3 repos returned
- 2 have `specGuardConfig` populated, 1 has `specGuardConfig: null`

## Dependencies

### Internal
- `src/core/config.ts` — loadConfig
- `src/core/reader.ts` — readFile, fileExists
- `src/core/errors.ts` — ConfigNotFoundError, ConfigInvalidError
