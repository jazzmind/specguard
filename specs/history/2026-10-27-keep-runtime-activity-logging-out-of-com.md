---
id: 2026-10-27-keep-runtime-activity-logging-out-of-com
date: 2026-10-27
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Keep runtime activity logging out of commits and repair legacy tracked logs"
affects:
  - platform-foundation
  - integration-surfaces
  - security-and-remediation
---
# Keep runtime activity logging out of commits and repair legacy tracked logs

## Decision

Activity logging must not create another working-tree change after a commit. Writers share a best-effort helper that honors existing ignores or adds a path-specific local Git info/exclude entry, including nested projects and worktrees, without changing versioned files or the index. Commit scopes always refuse activity-log.json, including explicit scopes. Migration detects and untracks legacy tracked activity logs with --yes while keeping their content on disk. The affected existing repo can be untracked once without deleting its log.
