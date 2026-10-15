---
id: workspaces
kind: capability
title: Workspaces - Multi-Repo and Monorepo
parent: system
value: Teams that split one system across several repos or packages can treat it as one system, so a change in one place shows what else must be re-checked.
status: active
sources:
  - "src/core/workspace.ts"
  - "src/core/workspace-heuristics.ts"
  - "src/core/monorepo.ts"
  - "src/core/contracts.ts"
  - "src/pipelines/contracts.ts"
  - "src/pipelines/impact.ts"
  - "src/pipelines/workspace-drift.ts"
  - "src/cli/commands/contracts.ts"
  - "src/cli/commands/impact.ts"
  - "src/cli/commands/workspace.ts"
  - "src/core/workspace-units.ts"
tests:
  - "tests/core/monorepo.test.ts"
  - "tests/core/workspace-heuristics.test.ts"
  - "tests/core/claims.test.ts"
  - "tests/pipelines/init.test.ts"
  - "tests/core/workspace-units.test.ts"
  - "tests/pipelines/workspaces.test.ts"
docs:
  - "README.md"
history:
  - 2026-10-15-functional-specs-and-four-pillars
---

# Workspaces - Multi-Repo and Monorepo

## Problem & Value
Real systems are rarely one repo with one package. A web app calls an API in another repo, a test repo drives both, a docs repo describes them, and a monorepo may hold a dozen packages. A spec checker that sees one repo at a time cannot tell you that changing a provider's interface breaks a consumer elsewhere, and a tool that creates one set of specs per package recreates the file-level granularity problem one level up.

This capability lets several repos, or several packages in one monorepo, be treated as one system. It records which repos take part and what role each plays, detects monorepo packages and their test commands, keeps a graph of the contracts between specs across repos, and answers the question "if this spec changes, what else is affected and what should I re-check?". The planned half unifies repos and packages into a single idea of a unit so that checking, drift, testing, serving and security all work per unit and per capability.

## Users & Journeys
- A platform lead runs `specguard workspace init` in a folder of sibling repos to register them with sensible roles and then reviews the manifest.
- A developer declares in a spec that it depends on another repo's spec, runs `specguard contracts`, and gets the cross-repo graph.
- A provider-API developer runs `specguard impact <spec>` before changing an interface and sees every consumer spec, by depth, with suggested drift commands.
- A release manager runs `specguard workspace drift --since origin/main` to check consumer repos whose providers changed.
- A developer in a pnpm monorepo runs `specguard init` and gets each package's test command recognised.
- An architect runs `check` at a workspace root and sees the system, its units (repos or packages) and the capabilities that span them.

## Requirements
- [ ] A workspace manifest at `.specguard/workspace.json` lists repos with a path and a role of consumer, provider, test or docs, an optional description, and an optional catalog directory; it is found by walking up from any child directory and unknown fields are preserved <!-- claim: workspace-manifest -->
- [ ] A missing manifest is a clear "not found" configuration error and an invalid or schema-failing manifest is a configuration error; repos without their own SpecGuard config load with no config rather than failing <!-- claim: manifest-errors -->
- [ ] `workspace init` registers sibling repos that have a SpecGuard config, deriving each repo key from the directory name alone and each role from the repo's contents (test frameworks, UI or server dependencies, API schema files, language markers) and never from a platform-specific name; it never overwrites an existing manifest and fails with guidance when no repo is found <!-- claim: workspace-init-heuristics -->
- [ ] `workspace status` shows each repo with its role, spec count, incoming and outgoing contract edges and configuration health, plus contract health (verified versus stale edges and a breakdown by edge type), and tells the user to build the graph when none exists <!-- claim: workspace-status -->
- [ ] Monorepo detection reads pnpm, Yarn and npm workspaces, Nx, Turbo and Lerna configuration, expands package globs honouring exclusions, reports the package manager, and records each package's name, directory, test framework and whether it has a test script; a single-package repo is reported as not a monorepo <!-- claim: monorepo-detection -->
- [ ] Each monorepo package gets a test command that runs only that package's tests through the repo's own tooling (Nx, Turbo, pnpm, Yarn or npm), and `init --single` opts out of per-package handling <!-- claim: per-package-test-command -->
- [ ] The contract graph is stored in `.specguard/contracts.json` as nodes (a spec in a repo, identified `<repo>::<specPath>`) and directed edges from consumer to provider with a type of graphql, rest, iframe, upload, event, test or docs, a surface list, a last-verified time and a source <!-- claim: contract-graph-model -->
- [ ] `contracts` builds edges from structured contract blocks in spec Dependencies sections, from importers supplied by enabled plugins and, only with `--with-llm`, from free-text dependencies of specs that have no structured block; lines that do not match the format are skipped <!-- claim: contract-sources -->
- [ ] Building the graph is idempotent and incremental: existing edges are preserved and surface items merged, `--force` rebuilds from scratch, `--repo <key>` restricts to one repo, validation problems such as an edge naming a missing node are warnings that do not fail the command, and the file is written atomically <!-- claim: contracts-idempotent -->
- [ ] `impact` accepts a node id, a workspace-relative path or an absolute path, walks consumers breadth-first to a depth limit (default 6), separates direct from transitive consumers with the connecting edge type and surface, and `--upstream` also lists the providers the target depends on <!-- claim: impact-blast-radius -->
- [ ] `impact` suggests a drift command for each affected consumer repo and an "update docs" suggestion for docs-type edges, reports "no downstream consumers" with exit 0, and exits 1 with an example id format for an unresolvable target or with guidance when no graph exists; it never modifies files <!-- claim: impact-suggestions -->
- [ ] `workspace drift` finds repos with changes since a git ref (default the previous commit), maps changed files to graph nodes, runs drift in the affected consumer repos for the dependent specs, supports `--force` and `--repo`, and exits 3 when any consumer has drifted <!-- claim: workspace-drift -->
- [ ] A claim can be referenced across repos as `repo:specKey#claim` (or `specKey#claim` within the current repo), so a journey or proof can depend on a claim in another repo <!-- claim: cross-repo-claim-refs -->
- [ ] A workspace-level `.specguard/.env` supplies shared keys to every repo in the workspace, with a per-repo `.specguard/.env` taking precedence and real environment variables never overwritten <!-- claim: shared-env -->
- [ ] A workspace is a set of units, where a unit is a repo or a package (`kind: repo|package`) listed under `units` in the manifest and a manifest may mix both; existing `repos` manifests load unchanged as units of kind repo, a repo-kind unit is also visible under `repos`, and a key listed as both is rejected <!-- claim: units -->
- [ ] A claim ref that names a package unit (`web:capabilities/auth#login`) means the workspace root's claim: proofs and test tags carrying it are stored and found under the unprefixed ref, and journey references through a package unit resolve; refs naming a separate repo are left alone. Planned: a capability may also live inside one unit's own spec tree <!-- claim: unit-claim-refs -->
- [ ] Detection also covers Go (`go.work`), Cargo workspaces and uv workspaces besides JavaScript ones, and a repo may hold several; `init` writes one app per ecosystem over every package's sources plus a units manifest carrying each package's test command, instead of one app per package, with glob negations kept at the front <!-- claim: more-ecosystems -->
- [ ] `check` reports each unit's source files, unowned files and the capabilities touching it (a capability spanning packages appears in each, and gets one drift verdict); `test run` runs each package unit's own command, only named units with `--unit`, or with `--affected [--since <ref>]` the changed units plus every unit that depends on them, running everything when a changed file is outside every unit; `serve` exposes the rollup at `/api/v1/units`. Planned: security findings carry the unit key <!-- claim: unit-aware-pipelines -->
- [ ] Dependencies between units, read from each unit's own manifest (package.json, go.mod, Cargo.toml, pyproject.toml), become `package` contract edges with source `workspace`, rebuilt on every `contracts` run so a removed dependency disappears; `impact` accepts a unit or a file inside one, and reports the capabilities with code in the affected units as well as the units themselves <!-- claim: package-edges -->

## Scenarios
### Scenario 1: Register a multi-repo system
**Steps:**
1. A folder contains a web app, an API repo, a browser test repo and a docs repo, each with its own SpecGuard config.
2. The user runs `specguard workspace init`.

**Expected Results:**
- `.specguard/workspace.json` lists four repos with keys from their directory names.
- The web app is a consumer, the API a provider, the test repo a test repo and the docs repo docs, judged from their contents.
- Re-running the command reports that the manifest exists and changes nothing.

### Scenario 2: Build the graph and ask about impact
**Steps:**
1. The web app's spec lists a contracts block pointing to an API spec with a GraphQL surface.
2. The user runs `specguard contracts`, then `specguard impact <api-repo>::specs/mutations/designer.md`.

**Expected Results:**
- `contracts.json` holds an edge from the web app spec to the API spec with the mutation names as its surface.
- Impact lists the web app spec as a direct consumer with the surface items and suggests running drift in the web app repo.
- A node with no consumers prints "No downstream consumers found" and exits 0.

### Scenario 3: Cross-repo drift after a provider change
**Steps:**
1. A provider spec changes on a branch.
2. The user runs `specguard workspace drift --since origin/main`.

**Expected Results:**
- The command finds the changed provider spec, looks up its consumers and runs drift in each consumer repo.
- It reports each consumer as drifted, no drift, skipped or error, and exits 3 if any consumer drifted.

### Scenario 4: Monorepo initialisation
**Steps:**
1. A pnpm repo lists `packages/*`, containing `packages/web` and `packages/api`.
2. The user runs `specguard init`.

**Expected Results:**
- Both packages are detected with their test frameworks, and the test commands use `pnpm --filter <name> test`.
- With `--single`, one app covers the whole repo instead.
- A repo without workspaces is treated as a single package.

### Scenario 5: Unknown target
**Steps:**
1. The user runs `specguard impact unknown/path.md`.

**Expected Results:**
- The output explains that the target cannot be resolved and shows the valid node id format.
- The command exits 1 and no file is changed.

### Scenario 6: One capability across two packages
**Steps:**
1. A capability's sources cover `packages/web/**` and `packages/api/**` in a monorepo.
2. A file in `packages/api` changes and the user runs `test run --affected` and `drift` at the workspace root.

**Expected Results:**
- The change maps to the owning unit and then to the capability, which receives one drift verdict.
- Only the affected units' tests run, and a proof recorded through `api:capabilities/auth#logout` is stored as the root claim.

## Security & Data Considerations
- File reads and git commands are bounded to the repos listed in the manifest; paths are resolved relative to the workspace root and the manifest cannot cause reads outside it by default.
- Monorepo detection only reads configuration files and never runs project code or package scripts.
- The graph and manifest contain repo names, spec paths and API surface names, but no secrets. LLM extraction runs only on explicit request (`--with-llm`) and sends spec text, so it should be avoided for sensitive specs.
- Shared environment files may hold API keys; they are git-ignored by `init`, and real environment variables always win over file values.
- `workspace drift` runs the SpecGuard CLI in sibling repos; only repos named in the manifest are touched.

## Interfaces
- CLI: `specguard workspace init [--name]`, `specguard workspace status`, `specguard workspace drift [--since <ref>] [--force] [--repo <key>]`, `specguard contracts [--force] [--with-llm] [--repo <key>]`, `specguard impact <target> [--max-depth <n>] [--upstream]` (target: a node id, a unit, or a file); `specguard test run [--unit <keys...>] [--affected] [--since <ref>]`; `specguard init` (and `--single`) detects monorepos and writes the units manifest.
- MCP tools: `specguard_contracts`, `specguard_impact`, `specguard_workspace_status`, `specguard_workspace_drift`.
- Files: `.specguard/workspace.json` (name, repos with path, role and description, optional catalog), `.specguard/contracts.json` (version, generatedAt, nodes, edges), workspace-level `.specguard/.env`. `units` map in the manifest (path, kind, role, packageName, ecosystem, test command and framework); `.specguard/trace.json` and `GET /api/v1/units` carry the per-unit rollup.
- Spec syntax: a contracts block in the Dependencies section, delimited by `<!-- contracts:start -->` and `<!-- contracts:end -->`, with lines like `<repoKey>::<specPath> [<type>: <surface>, ...]`; claim refs `repo:specKey#claim`.
- Exit codes: 0 success, 1 missing manifest or unresolvable target, 3 drift detected in a consumer.

## Out of Scope
- Managing git operations, branches or releases across repos.
- Automatically editing consumer code or specs when a provider changes; impact only reports and suggests.
- Replacing a monorepo build tool; SpecGuard calls Nx, Turbo and package managers to run tests but does not orchestrate builds.
- Detecting runtime service dependencies by tracing traffic; edges come from declared blocks, plugin importers, optional LLM extraction and (planned) package manifests.
