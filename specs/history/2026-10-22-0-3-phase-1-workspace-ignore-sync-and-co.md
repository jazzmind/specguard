---
id: 2026-10-22-0-3-phase-1-workspace-ignore-sync-and-co
date: 2026-10-22
kind: prompt+plan
author: "Wes Sonnenreich"
source: manual
title: "0.3 phase 1: workspace ignore, sync and combined view"
affects:
  - workspaces
  - traceability-and-drift
  - documentation-api
---
# 0.3 phase 1: workspace ignore, sync and combined view

## Prompt

Build SpecGuard 0.3 (Wes, 2026-10-22: "build it"). Phase 1: let SpecGuard ignore repos in a workspace (hub is ignored in the sandbox workspace) and give one combined picture across repos. Workspace manifest stays canonical, auto-synced from the VS Code .code-workspace; the combined view is built locally first (check --workspace, serve --workspace, extension Workspace panel), the server-side workspace view later.

## Plan

# SpecGuard 0.3: combined workspace view, plugin management, test layers, self-healing CI

## Context
SpecGuard 0.2 is in `~/Code/utilities/specguard`. `specguard-ai@0.2.0` is on npm, and local `main` matches `origin/main` at 739b0ff, so there was nothing to pull. Within a single repo it does a lot: a proof ledger tied to claims, browser verify, security scan with a remediation plan, `remediate` with a PR, and a team server. It doesn't fit how Wes actually works:

- **Workspaces**
  - No `.specguard/workspace.json` exists anywhere under `~/Code`.
  - Repos sit two levels down (`apps/*`, `utilities/*`) and are grouped by `~/Code/workspaces/*.code-workspace`.
  - `workspace init` only scans direct child folders.
  - Repo `ignore` is read only by the extension (`extension/src/workspace-state.ts:223`), so hub can't be excluded from CLI analysis.
  - Nothing combines coverage, tests, security or docs across repos; the server holds one project per repo.
- **Test layers**
  - The ledger holds one row per claim (`src/pipelines/proof.ts:~380`). `evidence` is stored but never read.
  - A browser `verify` FAIL overwrites a proven verdict earned by tests, and the next test run overwrites it back (`src/pipelines/validate.ts:252`).
  - The layer chosen with `generate --type` is lost after generation.
  - Security stub tests carry no claim tags, so they never prove anything.
- **CI and self-healing**
  - `init` doesn't scaffold a workflow.
  - The Action posts no PR comment and emits no SARIF.
  - `affected: true` passes `--affected` with no `--since` (`action/run-gates.mjs:151`), so the PR's changes are never what gets tested.
  - `heal` only rewrites tests. App bugs are reported, then dropped.
  - `remediate` only handles dependency and Semgrep fixes.
- **Plugins**
  - The extension knows nothing about plugins.
  - It hard-codes the `quality` and `commit` actions, which fail when those plugins are off. Heal's auto-commit breaks without the `git` plugin (`extension/src/dashboard/host.ts:301`).
  - Plugins carry no metadata, and there's no `plugin` CLI or API.

**Wes's decisions (2026-10-22)**
- `workspace.json` is the source of truth, and the extension keeps it in sync with the `.code-workspace`.
- The combined view comes to the local CLI, serve and extension first, then the server.
- Self-healing may **auto-merge only low-risk dependency fixes**. App fixes always go to a human.
- All four areas are in scope; the release is 0.3.0.

**Compatibility rule:** nothing bumps a stored file version. The ledger stays at v1, and so do the snapshot and trace. `workspace.json` stays passthrough. Every change adds fields. `fileLedgerStore` (`src/core/state/ledger-store.ts:27`) rejects other versions, and the ledger is committed, so a version bump would break pinned Actions and older CLIs.

**Process (repo `CLAUDE.md`):** update the spec first in each phase, add `specguard history add`, write the code and tests, then run `specguard test run` and `specguard check`. LLM calls go through `src/core/llm.ts`, and file I/O goes through `reader.ts`/`writer.ts`.

---

## Phase 0: Hygiene
- Fix three tests that time out at 5s only when the full suite runs (they pass alone): `tests/pipelines/check.test.ts` (intent-gap advisory), `tests/pipelines/history.test.ts` (gap-lifecycle) and `tests/pipelines/publish.test.ts` (snapshot paths). Give each its own timeout or make the setup cheaper. Don't raise the global timeout.
- Remove the 3 committed `.vsix` files from `extension/` and gitignore `*.vsix`.
- Merge the extension's two CLI resolvers (`extension/src/dashboard/cli.ts:28` and `extension/src/commands.ts:375`) into the first one.
- Have the version check and MCP registration use the active root instead of `workspaceFolders[0]` (`extension.ts:96`, `mcp-registration.ts:32`).
- After this, re-prove the 70 stale claims and record intent for the 3 intent gaps (platform-foundation, requirement-history, team-server).

## Phase 1: Workspace, ignore, sync and the combined view
Spec: `specs/capabilities/workspaces.md`, plus `team-server.md` for step 1f.

**1a. Schema and ignore** (`src/core/workspace.ts:80-109`)
- Add to `repoSchema` and `unitSchema`: `ignore`, `ignoreReason` (`auto:no-config` | `auto:removed` | free text), `origin` (`manual|code-workspace|scan`), `folderName` and `syncedValues`.
- Add at the top level:
  - `source: {codeWorkspace, mode: auto|prompt, autoIgnoreUnconfigured: true, syncedAt}`
  - `server: {workspace?, projects?}`
- **Single filter point:** `normalizeUnits` (`:185`) moves ignored entries into a new `manifest.ignored`. Every repo loop then inherits the filter: contracts, impact, workspace-drift, trace, test-run, security-scan, proof, claims, feature-state and the MCP tools.
- Add an `activeGraph()` helper that drops contract nodes from ignored repos.
- `locateSpec` reports "repo is ignored" instead of not finding the spec.
- Writers edit raw JSON. They never serialize the normalized object.

**1b. Finding the manifest**
- New `resolveWorkspaceManifest(cwd, explicit?)` accepts a manifest path, a directory, or a `.code-workspace` file.
- Lookup order: the `--workspace <p>` flag, then `SPECGUARD_WORKSPACE`, then walking up from cwd.
- **Workspace-level commands only.** `ledgerRoot` (`proof.ts:90`), `env.ts` and per-repo `loadWorkspace` keep walk-up. Without that, every repo's ledger would be written to the workspace root.

**1c. Sync with `.code-workspace`** (new `src/core/workspace-sync.ts`, pure `syncFromCodeWorkspace(raw, cws)`; CLI `workspace sync`)
- **Manifest location**
  - Default: `<cwsDir>/.specguard-workspaces/<name>/.specguard/workspace.json`, one directory per `.code-workspace`, because 5 of them share `~/Code/workspaces`.
  - The link is stored once in the `.code-workspace` under `settings["specguard.workspaceManifest"]`, written with `jsonc-parser` `modify()`, which keeps comments.
  - Add the `jsonc-parser` dependency to both the CLI and the extension.
- **Identity:** a repo is matched by its realpath, not its key.
- **Added folders**
  - Each becomes a repo unit with a role from `guessRepoRole` (`workspace-heuristics.ts`).
  - A folder with no `.specguard/config.json` is added with `ignore: true, ignoreReason: auto:no-config`.
  - **Hub** has a config, so it gets ignored once by hand, either from the extension's "Ignore" action or with `workspace ignore hub`. The ignore persists.
- **Removed folders:** deleted if untouched since the last sync; otherwise set to `ignore` with `auto:removed`.
- **Hand edits are never overwritten:** sync only changes fields still equal to `syncedValues`. Writes are atomic and abort if the file's mtime changed during the read-modify-write.
- **Init**
  - `workspace init --from <x.code-workspace>` creates the manifest, links it and syncs.
  - `workspace init --recursive [--depth 3]` stops at `.git` or a config, skips hidden folders and `node_modules`, and adds unconfigured repos as ignored. It replaces the direct-children scan at `src/cli/commands/workspace.ts:59`.
- Add `workspace ignore|unignore <key>`.

**1d. Rollup** (new pure `src/core/workspace-rollup.ts`, `rollupRepo()`, shared by local and server)
- **Reads only existing artifacts:** `trace.json`, the proof ledger, and `readPlanFile(dir,'latest')`.
- **Per repo:** coverage %, claims proven/failed/stale/unproven/incomplete, a per-layer tally (Phase 3), open security items by severity, docs with/stale, intent gaps, freshness, and state (`ok|no-config|no-trace|unreadable`).
- **Trace additions:** `trace.json` gains `gaps: {intent, docsStale}`, which `check` already computes, so the server can produce the same rollup without git.
- **Where it shows up**
  - **CLI:** `check --workspace [p] [--refresh]`. `--refresh` runs `runCheck` in each active repo first. It writes `<root>/.specguard/rollup.json` (a generated state path). The exit code is the worst among the repos.
  - **Serve:** `serve --workspace` registers every active repo as a project and adds `GET /api/v1/workspace`. That route must come before the default-project fallback at `src/server/api.ts:131`.

**1e. Extension**
- `workspace-state.ts:217-249` reads `units` as well as `repos`.
- On activation and `onDidChangeWorkspaceFolders` it offers to link and then auto-syncs.
- A new **Workspace overview** view shows one row per repo with coverage, layer chips and security counts, plus Ignore/Unignore actions and a "Refresh all" button that runs `check --workspace --refresh`.
- The `**/specs/**` file watcher is scoped to active repos.

**1f. Server, the last step of this phase; can be cut**
- A workspace store holds `{name, projects:[{project,key,role,ignore}]}`: file backend plus an `sg_workspaces` table in Postgres.
- Routes: `GET/PUT /api/v1/workspaces[/:n]` and `GET /api/v1/workspaces/:n/rollup`, which runs `rollupRepo` over each project's latest snapshot.
- New `workspace publish` command.
- **Auth:** PUT requires a maintainer and an unscoped token. Project-scoped tokens get 403 unless the workspace contains only that project.

## Phase 2: Plugin management
Spec: `integration-surfaces.md`. Add claims for plugin listing and management and for the extension's Plugins view. Rename the misleading `planned-plugin-extensions` claim id with `claim-migration`.

- **Catalog**
  - New `src/plugins/catalog.ts` holds `BUILTIN_PLUGINS: {id, title, description, provides[], requires?, configKey?}[]`. It's metadata only, so the lazy `import()` and the esbuild glob in `src/plugins/index.ts` stay as they are.
  - A test keeps the catalog in step with the plugin directories.
  - Add an optional `meta` field on `SpecGuardPlugin` (`src/plugins/types.ts:255`) for npm plugins.
- **CLI:** `plugin list [--json]` shows enabled state, source, contributed commands/MCP tools and load errors. Also add `plugin enable|disable <id>` and `plugin add <id> --package <pkg> [--install]`.
  - These edit the raw `config.json` of the repo itself.
  - A new `disabledPlugins: string[]` config key lets a repo turn off a plugin inherited through `extends`, which replaces arrays wholesale (`config.ts:351`).
  - `add` checks the existing `NPM_NAME` rule, needs the `--install` confirmation, and warns that a plugin runs third-party code.
- **API and MCP:** `GET /api/v1/plugins` on local serve (read-only; informational on the team server) and a read-only `plugin_list` MCP tool.
- **Extension**
  - Add a **Plugins** tree view: built-ins plus configured npm plugins, each with a description, an enabled toggle, contributed commands and load errors. It has Enable/Disable/Add actions; Add shows a modal with the package name and the third-party code warning.
  - After a change:
    - restart the local serve (`hub.reset()`), because the loader keeps a module-level cache;
    - prompt to restart MCP;
    - rebuild the action lists.
  - Remove the hard-coded `quality`/`commit` actions (`protocol.ts:197-241`, `pipelines-view.ts`). Plugin commands now come from `plugin list --json`.
  - Heal's auto-commit runs only when `git` is enabled.
  - The 4 `validate*` variants that all run the same `validate` collapse into one command (`commands.ts:106-132`).

## Phase 3: Test layers and CI scaffold
Spec: `conformance-testing.md`, `traceability-and-drift.md`, `agentic-verification.md`.

**3a. Layered proofs** (new `src/core/test-layers.ts`; `src/core/proof-ledger.ts`)
- **Layers:** `unit | integration | e2e | security | functional`, plus `unclassified` for old rows. An `unclassified` row never satisfies a required layer.
- **Ledger rows:** each `ProofRecord` keeps its current top-level fields as the combined verdict, and adds `layers?: Partial<Record<Layer, LayerProof>>`.
  - Each `LayerProof` has its own staleness inputs and up to 20 test ids.
  - `layersOf()` reads old rows, with no rewrite on read.
- **`effectiveClaimProof(record, current, required)`** returns `{verdict, layers, missing, complete}`:
  - any failed or error layer → the claim fails;
  - otherwise a stale required layer → stale;
  - otherwise any proven layer → proven.
  - With nothing required, the result is exactly today's.
- **Required layers** come from capability frontmatter, never the claim comment, because a change there would change claim hashes and older parsers' anchors. Precedence:
  1. the claim's entry in `layers: {default, claims: {id: [...]}}`;
  2. the frontmatter default;
  3. the app's `proof.requiredLayers`;
  4. the top-level `proof.requiredLayers`.
  - `proof.enforceLayers: off|warn|fail` defaults to `warn`.
- **How a test gets its layer.** The first rule that matches wins:
  1. an `@layer:` tag on the test, or a `// [layer: x]` comment at the top of the file;
  2. the per-app `test.layers` globs;
  3. the layer of the suite that ran it (`test.suites[]`);
  4. `results ingest --layer`;
  5. the Playwright runner, which means e2e;
  6. path conventions;
  7. otherwise unit.
- **Who writes which layer**
  - `verify` always writes `functional`.
  - `generate --type` writes the `[layer:]` comment.
  - Security test generation (`src/pipelines/security.ts`) now passes the claims to the prompt and tags them.
- **Ingest** (`proof.ts:380` and `results.ts`) merges into `row.layers[L]` and recomputes the top-level fields instead of replacing the row. This fixes the bug where verify and test runs keep overwriting each other.
- **What reads the layers.** Only additive fields:
  - `trace.ts` adds `layers`, `required` and `missing` per claim, `layerCounts` as a separate field (the totals loops sum numeric `counts`), and an `incomplete` count.
  - `check` and `proof status` add `[proof-incomplete]` lines and a `LAYERS:` line. The `PROOFS:` line stays byte-identical.
  - `/coverage` adds `layerCoverage`.
  - The extension adds per-layer chips.
  - The Action's `parseProofCounts` gets the new `proof-incomplete` fail-on rule.
- **Known degradation:** a pre-0.3 CLI that writes a row drops its `layers`. The row is still valid. Note this in the release notes.

**3b. Verify → Playwright.** A passing `verify` saves the click/fill actions it executed and turns them into a Playwright spec, through the existing `generate --type e2e` path. The spec is tagged with the claims and `[layer: e2e]`. Add the `navigate`, `assertText` and `waitFor` actions to `validate.ts:115-123` so the generated tests are worth having, and stop silently swallowing failed actions.

**3c. CI scaffold and feedback**
- **`init --ci github`** (`src/core/scaffold.ts`) writes `.github/workflows/specguard.yml`:
  - **PR job:** check, then `test run --affected --since origin/${base}`, then security scan, then proof with `fail-on` incl. `proof-incomplete`, then publish.
  - **Optional `verify` job** against a URL input; start-the-app support is a follow-up.
  - **Scheduled `remediate` job.**
- **Fix `--affected`:** `run-gates.mjs:151` passes `--since` from `GITHUB_BASE_REF`. Add an `affected-since` input to `action.yml`.
- **PR feedback**
  - One sticky PR comment (upserted by a marker) with deltas against the base for coverage, claims by layer and new findings.
  - SARIF export from the RemediationPlan (`security scan --sarif`), uploaded with `github/codeql-action/upload-sarif`.

## Phase 4: Self-healing loop for app bugs, and auto-merge policy
Spec: `security-and-remediation.md` and `conformance-testing.md`. Its claim `pr-modes-no-merge` and the "a person always merges" text must be amended through `history add`.

**4a. App-fix items**
- These become remediate items with a new change type `app` (`src/core/remediation-schema.ts:24`):
  - failures `heal` classifies as app bugs (today they exit 7 and are dropped);
  - freshly failed layers in the ledger;
  - verify FAIL reports.
- **Write allowlist:** the owning capability's owned files minus tests and specs (`remediate/apply.ts`).
- **Fixer input:** the counterexample, claim text and failing test output, through `code-fix.ts`.
- **Verdict:** reuse `computeVerdict` with `intendedFlips`. Target claims may flip from failed to proven; every other claim must hold in every layer where it was proven.
- **PRs:** app fixes always go to a normal PR (draft unless the verdict is PRESERVED) and are **never auto-merged**.
- **Entry point:** `specguard remediate --from failing` (tests/ledger) and `--from verify`. Also an Action input in the scheduled job.

**4b. Auto-merge policy** (new pure `src/core/auto-merge-policy.ts`, `autoMergeDecision()`)
- A fix is eligible only if **all** of these hold:
  1. Change type is dependency, and the diff touches only that ecosystem's manifest or lockfiles.
  2. It's a patch bump, or a minor bump at version 1.0 or above, and the package isn't in `denyPackages`.
  3. The verdict is PRESERVED, with no inconclusive reasons, no flaky tests among the selected ones, and at least 1 selected test.
  4. Every claim proven at baseline is **re-proven** in each required layer (or each layer that had evidence) with the new dependency fingerprint. A layer that can't be rerun in the worktree (functional, or e2e with no suite) makes the fix ineligible.
  5. Risk is low and breaking-change analysis is negative.
  6. Three opt-ins are all set: `remediate.autoMerge.enabled`, `--auto-merge`, and the Action input.
- **Enforcement** in `src/pipelines/remediate/ship.ts`:
  - Confirm the base branch has required status checks, via `gh api …/branches/:b/protection/required_status_checks`, and refuse otherwise.
  - Then run `gh pr merge --auto --squash` and record the decision in `report.json` and the PR body.
  - The scaffolded workflow must use a PAT or GitHub App token, since PRs opened with `GITHUB_TOKEN` don't trigger CI.

---

## Order and cut lines
Phase 0 → 1a–1e → 2 → 3a → 3c → 1f → 3b → 4a → 4b.

Each step ends green (`npm run ci`, `specguard test run`, `specguard check`) with history entries recorded. If the round has to shrink, cut 1f, 3b and 4a in that order; they stay on the roadmap. 4b depends on 3a, because auto-merge requires re-proof in each layer.

## Verification
- **Unit tests (pure functions, table tests)**
  - **`effectiveClaimProof` / `layersOf`:** use a fixture copied from SpecGuard's own `.specguard/proofs.json`. With no layers required, `PROOFS:` must be byte-identical to today's.
  - **Ingest:** a verify FAIL followed by a test run must leave the claim failed.
  - **Layer classification:** precedence order.
  - **Sync:** the 3-way merge matrix (JSONC with comments, renames, duplicate basenames, missing folders, hand edits kept).
  - **Ignore/env:** `SPECGUARD_WORKSPACE` doesn't move the ledger root.
  - **Auto-merge policy:** decision table.
  - **Gating:** a fake `gh` confirms `pr merge --auto` runs only when the PR is eligible and the base branch is protected.
- **Back-compat tests:** a 0.2 ledger, trace and snapshot load unchanged; Action `run-gates` works with an old CLI (`incomplete` = 0); server snapshot round-trip.
- **Metacircular check:** declare `layers` on one SpecGuard capability and run `test run` and `check` against SpecGuard itself.
- **End-to-end on the real workspace:**
  1. `workspace init --from ~/Code/workspaces/sandbox.code-workspace`, then `workspace ignore hub`.
  2. `check --workspace --refresh`. Confirm hub is absent and each configured repo (ai-portal, deploykit, specguard, …) shows coverage, layers and security counts.
  3. Open the sandbox workspace in VS Code. Confirm the Workspace overview and Plugins views, toggle `feature-catalog` on and off, and confirm the action list updates without a reload.
- **CI:** run `init --ci github` on a throwaway branch of a test repo, open a PR, and confirm the sticky comment, the SARIF upload and that `--affected` runs only the changed units.
- **Remediate:** use a fixture repo with a vulnerable patch-level dependency and a protected branch. Confirm auto-merge is armed. With an app-bug fixture, confirm a normal PR is opened and auto-merge is not armed.

## Critical files
- **Ledger and proofs:** `src/core/proof-ledger.ts`, `src/pipelines/proof.ts`, `src/pipelines/results.ts`, `src/core/trace.ts`
- **Workspace:** `src/core/workspace.ts`, `src/cli/commands/workspace.ts`
- **Plugins:** `src/plugins/index.ts`, `src/plugins/types.ts`
- **Verify and CI:** `src/pipelines/validate.ts`, `src/core/scaffold.ts`, `action/run-gates.mjs`, `action.yml`
- **Remediate:** `src/pipelines/remediate/{ship,apply,code-fix,verify}.ts`, `src/core/remediation-schema.ts`
- **Server:** `src/server/api.ts`
- **Extension:** `extension/src/{workspace-state,sidebar,commands,pipelines-view}.ts`, `extension/src/dashboard/{host,protocol}.ts`
- **New files:** `src/core/{test-layers,workspace-sync,workspace-rollup,auto-merge-policy}.ts`, `src/plugins/catalog.ts`
