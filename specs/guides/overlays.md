---
id: overlays
kind: journey
title: "Quickstart: overlays"
audience: user
order: 12
useCase: Keep the specs, config and test results for several repositories in one separate repository, and write nothing into the applications.
related:
  - workspaces
  - platform-foundation
---

# Quickstart: overlays

## Goal
Keep SpecGuard's config, specs and test results for a whole system in one separate "overlay" repository, so the application repositories stay untouched.

## Prerequisites
- The application repositories checked out side by side.
- An empty git repository for the overlay, for example `shop-specs`.

## Steps
### Lay out the overlay
The overlay holds one config per application, and each config's `apps[].repo` points out to the real repository, relative to the folder that holds `.specguard/`:

```
shop-specs/                          (a git repo)
  apps/api/.specguard/config.json    apps: [{ "name": "api", "repo": "../../../shop-api", "specDir": "specs", ... }]
  apps/api/specs/   apps/api/tags/
  apps/web/.specguard/config.json    apps: [{ "name": "web", "repo": "../../../shop-web", ... }]
```

### Register it once per machine
```bash
specguard overlay add ../shop-specs
specguard overlay list
```

`add` scans the overlay, shows what it covers and what it skipped, and registers it in the per-user registry (`~/.config/specguard/overlays.json`, mode 600). Nothing is written into the application repositories: specs, the proof ledger, caches and the edit guard's index and log all live in the overlay.

### Work from an application repository
```bash
cd ../shop-api
specguard overlay resolve .
specguard check
```

Run from inside `shop-api`, a command loads the overlay app's config exactly as if you had run it from `shop-specs/apps/api`, and `check` and `status` say so on their first line. `overlay resolve` explains which config, overlay and app a directory uses, or why none.

### Keep it current
```bash
specguard overlay refresh
specguard overlay remove ../shop-specs
```

Refresh after configs are added, moved or deleted.

### Resolution rules
For a directory the order is: the repository's own `.specguard/config.json` (up to the git boundary); then `SPECGUARD_CONFIG`; then overlay entries (`SPECGUARD_OVERLAY` roots first, then the registry), taking the entry whose repo is the deepest ancestor-or-equal of the directory. A repository's own config always wins. If two overlay configs name the same repository, SpecGuard stops with an error that names both and how to pick (`--config` or `SPECGUARD_CONFIG`); it never guesses.

Without registering, `SPECGUARD_OVERLAY=<dir>[:<dir>...]` names overlay roots scanned on the fly (handy in plugin or MCP configs), and `SPECGUARD_CONFIG=<path to a config, or its folder>` names one config for every directory.

### Choose where generated files go
An overlay is also a good home for end-to-end tests and docs shared by several applications. Choose the destination per application and kind:

```bash
specguard outputs --json
specguard outputs --app api --kind tests.e2e --directory ../../e2e/journeys
specguard generate --app api --all --type e2e --framework playwright
```

Kinds are `specs`, `tests.unit`, `tests.integration`, `tests.e2e`, `docs` and `plans`. The choice is remembered per application and kind in `.specguard/output-locations.json` under the config root, and it does not move proof state. Changing a spec root copies its Markdown into the new root and keeps the originals.

## Outcome
Application repositories carry no SpecGuard files, yet running SpecGuard from inside any of them behaves as if they did. In a workspace, an overlay-covered folder counts as a normal repository.

## Related
- [Multiple repositories](multi-repo.md)
- [Contracts](contracts.md)
