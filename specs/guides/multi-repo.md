---
id: multi-repo
kind: journey
title: "Quickstart: multiple repositories"
audience: user
order: 11
useCase: Treat several repositories or monorepo packages as one system, with one combined picture and some repositories left out.
related:
  - workspaces
  - integration-surfaces
---

# Quickstart: multiple repositories

## Goal
Treat a frontend, a backend and supporting repositories as one system: one workspace, one combined `check`, and a deliberate list of what is left out.

## Prerequisites
- Each repository you want included is set up on its own (`specguard init` or `specguard start`; see [one repository](single-repo.md)).
- Either a folder that contains the repositories, or a VS Code `.code-workspace` file that lists them.

## Steps
### Monorepos first
A monorepo needs no workspace. `specguard init` detects pnpm, Yarn, npm, Nx, Turbo, Lerna, Go `go.work`, Cargo and uv workspaces, writes one app per ecosystem over every package's sources, and lists each package as a unit in `.specguard/workspace.json` with its own test command. Use `--single` to treat the repo as one app instead. Capabilities cut across packages, so specs follow functionality, not package layout. `specguard test run --affected` runs only the changed units and the units that depend on them.

```bash
specguard init
specguard test run --affected
```

### Create the workspace
From a `.code-workspace` file, or by finding repositories in a folder tree:

```bash
specguard workspace init --from ~/Code/shop.code-workspace
specguard workspace init --recursive --depth 3
```

The manifest is `.specguard/workspace.json`. When you use a `.code-workspace`, it is kept next to that file in `.specguard-workspaces/<name>/.specguard/workspace.json`, because several `.code-workspace` files often share one folder. In VS Code, opening the `.code-workspace` offers to create it for you.

### Leave repositories out
Shared tooling that is not a product does not belong in the picture:

```bash
specguard workspace ignore hub --reason "shared tooling, not a product"
specguard workspace unignore hub
```

Ignore is respected everywhere: contracts, impact, drift, security, proofs, the rollup and the server view skip an ignored repo. Folders with no `.specguard/config.json` are added as ignored (`auto:no-config`) and are un-ignored automatically once a config appears.

### Keep it in step with the folders
```bash
specguard workspace sync --from ~/Code/shop.code-workspace
specguard workspace status
```

`sync` adds new folders and retires dropped ones. It changes only entries it created and only the fields it wrote, so a role or description you edited by hand is kept. The extension does this whenever you add or remove a folder.

### See the whole system
```bash
specguard check --workspace ~/Code/shop.code-workspace --refresh
```

One row per repository: source ownership, claims proven, failed, stale and missing a layer, open security items, stale docs and intent gaps. The result is also written to `.specguard/rollup.json`. `--refresh` runs `check` in each repository first; without it the numbers are whatever each repository last recorded, and a repository whose ledger is newer than its trace is marked as lagging. Point any workspace-level command at a manifest with `--workspace <path>` or `SPECGUARD_WORKSPACE`.

### Connect the repositories
A change in one repository often matters to another. Build the contract graph and check drift across it; see [Contracts](contracts.md) and [Drift](drift.md).

### Organize the business view
Group repositories' capabilities into business journeys for presentation (workspace dashboard, **Business journeys**), or from the shell:

```bash
specguard experience --workspace ~/Code/shop.code-workspace --json
specguard experience --workspace ~/Code/shop.code-workspace --action draft
```

A journey holds ordered steps with expected outcomes and links to specs or claims across applications, such as `api:capabilities/payment#charge-once`. Draft proposals are stored in `.specguard/experience.draft.json` until applied, and removing organization never deletes specs, code or tests.

### A worked monorepo configuration
For an npm-workspaces monorepo with two packages and a root Playwright suite, the config is one app per test suite. Replace the placeholders:

```jsonc
{
  "apps": [
    {
      "name": "api", "repo": "apps/api", "language": "typescript", "framework": "vitest",
      "specDir": "specs/api", "testOutput": "apps/api/test/", "stripPrefix": "src/",
      "sources": { "api": ["src/**/*.ts"], "tests": ["test/**/*.test.ts"] },
      "exclude": ["src/**/*.test.ts"],
      "test": { "command": "npm run test --workspace @acme/api", "reporter": "vitest" }
    },
    {
      "name": "e2e", "repo": ".", "language": "typescript", "framework": "playwright",
      "specDir": "specs/e2e", "testOutput": "e2e/journeys/",
      "sources": { "api": [], "tests": ["e2e/journeys/**/*.spec.ts"] },
      "test": { "command": "npx playwright test --reporter=list,json", "reporter": "playwright" }
    }
  ],
  "paths": { "specsRoot": "specs", "proofLedger": ".specguard/proofs.json" },
  "llm": { "provider": "anthropic", "model": "<model>", "apiKeyEnv": "ANTHROPIC_API_KEY", "allowImages": false }
}
```

- **Path bases.** `sources`, `exclude` and `collapse` globs, and the `sources:` globs in a spec header, resolve relative to the app's `repo`, not the config root. A root-relative pattern is still accepted, with one warning per pattern; write repo-relative globs to avoid it. `stripPrefix` keeps a feature key from dropping a path segment.
- **One spec key.** A spec's key is its path under `paths.specsRoot` without the extension, whichever app owns it: `specs/api/services/messaging.md` is `api/services/messaging` in claim refs, tags, the drift registry, `matrix`, `align`, `status` and the ledger.
- **Source hashes come from the spec.** `results ingest` hashes the files a spec lists in `sources:` into each ledger row, so editing a source stales the claims of exactly the specs that list it.
- **The `test` blocks** tell `heal` and `test run` how to run each app. With no `resultsFile` SpecGuard adds the reporter flags itself and reads the file; with one, the command runs verbatim and must write it.
- **Ignore generated state.** Do not commit `.specguard/auth/`, `.specguard/evidence/` or `.specguard/reports/`; `.specguard/proofs.json` and `.specguard/trace.json` are generated, so regenerate them with `specguard test run`.
- **Login for browser checks.** An `auth.profiles` entry with the `storageState` strategy reads `.specguard/auth/admin.json` and, when it is missing, logs in with environment variables and creates it. Other strategies are `header`, `token` and `script`. `llm.allowImages: false` keeps screenshots from the model, and DOM, accessibility text and console errors are always redacted first.

### Organize an application's features and specs
In an application dashboard, **Specs, Organize features and specs** shows catalog features and specs with Change group and ordering arrows; it is saved beside the application's resolved config, including an overlay config. Unassigned entries inherit grouping and order from journey steps in the nearest workspace manifest, and an explicit placement wins. Reorganizing changes presentation, never identities or file names. **Draft or update from specs** proposes an overview, groups and journeys with the application's configured model, **Review draft diff** compares it with the current organization, and **Apply draft** activates it; a reference that does not exist is refused, and a proposal cannot be applied after its inputs changed.

```bash
specguard experience --config /path/to/overlay/apps/api --json
```

## Outcome
One workspace manifest, an explicit ignore list, and a combined `check` that shows every repository side by side. Per-repo state, including each repository's proof ledger, never follows the `--workspace` flag.

## Related
- [Overlays](overlays.md)
- [Contracts](contracts.md)
- [Collaborating with a team](team-collaboration.md)
