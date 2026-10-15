# Version

<!--
  module: src/core/version.ts
  type: core
  status: draft
-->

## Overview

The CLI has one version source: `package.json`. A bundled CLI (the one inside the VS Code extension) cannot read it, so the build injects the same value with `--define:__SPECGUARD_VERSION__`. `specguard --version --json` reports it so the extension can warn when an installed CLI does not match what the extension was built against.

## Acceptance Criteria

- [ ] `cliVersion()` returns the injected `__SPECGUARD_VERSION__` when the build defined it, else the `version` in `package.json`, and never a hard-coded fallback <!-- claim: single-source -->
- [ ] `specguard --version` prints the version and `specguard --version --json` prints `{ "name": "specguard-ai", "version": "<v>", "node": "<node version>" }` on one line <!-- claim: version-json -->
- [ ] The MCP server reports the same version <!-- claim: mcp-version -->
- [ ] The extension build injects the root `package.json` version into both the bundled CLI and the extension host, and the extension warns once per session when the CLI it resolves reports a different version <!-- claim: extension-mismatch-warning -->

## Scenarios

### Scenario 1: Bundled CLI

**Steps:**
1. Build the CLI with `--define:__SPECGUARD_VERSION__="1.2.3"`
2. Run `specguard --version`

**Expected Results:**
- It prints `1.2.3`
