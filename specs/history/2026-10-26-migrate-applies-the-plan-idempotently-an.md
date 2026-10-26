---
id: 2026-10-26-migrate-applies-the-plan-idempotently-an
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Migrate applies the plan idempotently and resumably"
affects:
  - platform-foundation
---
# Migrate applies the plan idempotently and resumably

## Decision

Migration applies the pure plan. `specguard migrate` gathers the repository's facts read-only, prints the plan by default, and with `--yes` applies only the steps the tool may take itself, in a fixed order, each checking its own done-condition so a rerun changes nothing. Generated proof files stop being tracked but stay on disk, committed proof rows are marked provisional with a backup and a manifest of inverse operations, per-file specs are archived with `git mv` so history follows them, and config keys and guard hooks are added only where absent, by inserting text rather than rewriting the user's file. Drafting and tagging belong to the host agent and approval, committing and pushing to the person, so all of them are printed as exact commands. Because a repository between the archive and the end of the draft has no specs of either kind, progress is kept in a state file that lets a rerun recognise a migration under way. Exit codes: 0 when nothing is left, 12 while agent work is pending, 14 when only steps for the person remain, 2 on refusing a dirty tree. The per-file spec loader is reached through a thin `src/legacy/index.ts` barrel so a later plugin split can move it without touching migrate.
