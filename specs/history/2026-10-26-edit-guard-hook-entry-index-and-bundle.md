---
id: 2026-10-26-edit-guard-hook-entry-index-and-bundle
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Edit guard hook entry, index and bundle"
affects:
  - spec-first-changes
  - integration-surfaces
---
# Edit guard hook entry, index and bundle

## Decision

The agent edit guard now has its working parts. A single entry reads the host's PreToolUse payload, finds the project, and loads an ownership index that is cached under a stat-only fingerprint and rebuilt in process when a spec, a change record or the config moves. It asks the pure decision table and prints the host's JSON: a deny carries `permissionDecision`, an allow with advice carries only `additionalContext` so it never skips the user's permission prompt. It fails open with a visible notice (or closed under `hooks.onError: "deny"`), logs bounded JSONL under the ignored cache directory, and runs as a committed single-file bundle that a test keeps in step with the sources. The plugin's hook entries, `specguard hook pre-tool-use|build-index|doctor|log`, `init --codex` (hooks and execpolicy rules written into the repository, the Codex plugin itself left hook-free) and the `--harness claude` settings merge all use that one entry. The index builder judges a change's red from its red record alone (the tests the red run covered are the lock set, checked live against the recorded tests hash) and a change's approvals from the base spec with the pure core, so it does not depend on the change pipeline; it does not re-derive the changed-claims hash, which `change status` and CI still check.
