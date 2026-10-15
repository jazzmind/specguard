# Monorepo detection

<!--
  module: src/core/monorepo.ts
  type: core
  status: draft
-->

## Overview

`specguard init` used to write one `app` for the whole repo. `detectMonorepo` reads pnpm, Yarn and npm workspaces, Nx, Turbo, and Lerna configuration and lists the workspace packages, so `init` can write one app per package with the command that runs only that package's tests.

## Acceptance Criteria

- [ ] pnpm (`pnpm-workspace.yaml`), Yarn/npm (`package.json` `workspaces`, array or `{packages}`), and Lerna (`lerna.json`) globs are expanded to packages, honouring `!` exclusions <!-- claim: workspace-globs -->
- [ ] `nx.json` and `turbo.json` are detected as tools; without explicit globs they look under `apps/`, `packages/`, `libs/`, `services/` <!-- claim: nx-turbo -->
- [ ] The package manager comes from `pnpm-workspace.yaml`/`pnpm-lock.yaml`, `yarn.lock`, or `packageManager`, defaulting to npm <!-- claim: package-manager -->
- [ ] `testCommandFor` returns `npx nx test <name>`, `npx turbo run test --filter=<name>`, `pnpm --filter <name> test`, `yarn workspace <name> test`, or `npm test --workspace=<name>` <!-- claim: test-command -->
- [ ] `init` writes one app per package with `repo`, `specDir`, `testOutput`, `framework`, and a `test` block, unless `--single` is given or the language is not TypeScript <!-- claim: init-per-package -->
- [ ] A single-package repo returns null and `init` writes one app as before <!-- claim: single-package -->

## Scenarios

### Scenario 1: pnpm workspace

**Steps:**
1. `pnpm-workspace.yaml` lists `packages/*`, with `packages/web` and `packages/api`
2. Run `specguard init`

**Expected Results:**
- Two apps are written, with `test.command` `pnpm --filter <name> test`
