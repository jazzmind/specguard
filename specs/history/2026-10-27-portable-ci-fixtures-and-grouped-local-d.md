---
id: 2026-10-27-portable-ci-fixtures-and-grouped-local-d
date: 2026-10-27
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Portable CI fixtures and grouped local development and release commands"
affects:
  - spec-first-changes
  - integration-surfaces
  - proof-store
---
# Portable CI fixtures and grouped local development and release commands

## Decision

Reproduce the GitHub failures with init.defaultBranch=master and the clean npm nested fdir layout. Explicitly initialize test repositories on main and normalize module labels by the innermost node_modules package, preserving version distinctions. Add executable layout regressions. Group Make help into local usage, development, validation and publishing; distinguish dependency setup from installing the CLI, detect VS Code on macOS and verify packaging without publishing a release. Use npm ci for all three dependency sets locally and in the workflows, and stop reinstalling webview dependencies during builds so packaging uses the installed lockfile versions.
