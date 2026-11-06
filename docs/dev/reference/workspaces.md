---
title: "Workspaces - Multi-Repo and Monorepo (developer reference)"
audience: dev
source: "specs/capabilities/workspaces.md"
generated: true
---
<a id="workspaces-multi-repo-and-monorepo"></a>
# Workspaces: Multi-Repo and Monorepo

<a id="purpose"></a>
## Purpose

Real systems span several repos or several packages in one monorepo. A checker that sees one repo at a time cannot tell that changing a provider's interface breaks a consumer elsewhere. A tool that makes one spec set per package recreates the file-level granularity problem one level up.

This capability lets several repos, or several packages in one monorepo, be treated as one system. It does four things:

- Records which repos or packages take part and what role each plays.
- Detects monorepo packages and their test commands.
- Keeps a graph of contracts between specs across repos.
- Answers "if this spec changes, what else is affected and what should I re-check?"

The model unifies repos and packages into a single idea of a **unit** (`kind: repo|package`). Checking, drift, testing, serving and security then work per unit and per capability.

<a id="responsibilities"></a>
## Responsibilities

- **Manifest and resolution:** maintain `.specguard/workspace.json`, locate it from child directories, `--workspace`, `SPECGUARD_WORKSPACE` or a `.code-workspace` file, and report configuration errors.
- **Registration:** `workspace init` and `workspace sync` register repos with keys from directory names and roles from repo contents. Ignored entries are handled uniformly.
- **Monorepo detection:** read pnpm, Yarn, npm, Nx, Turbo, Lerna, Go, Cargo and uv workspace config, and generate per-package test commands.
- **Contract graph:** build and store `.specguard/contracts.json`, from structured blocks, plugin importers, optional LLM extraction and unit manifests.
- **Impact and drift:** compute blast radius with suggestions, and run drift in affected consumer repos.
- **Unit-aware pipelines:** per-unit `check`, `test run`, `serve` and security plan items.
- **Rollup:** combine per-repo results locally and on a team server.
- **Shared environment and keys:** workspace and user `.env` files and the `key` command.
- **Business organization:** journeys, groups and steps over specs and claims, with model-assisted drafting.

<a id="interfaces"></a>
## Interfaces

<a id="cli"></a>
### CLI

| Command | Notes |
|---|---|
| `specguard workspace init [--name]` | Also `--from <file>` and `--recursive`. |
| `specguard workspace status` | |
| `specguard workspace drift [--since <ref>] [--force] [--repo <key>]` | |
| `specguard workspace sync` | |
| `specguard workspace ignore\|unignore <key>` | |
| `specguard workspace publish [--name n] [--server url]` | |
| `specguard contracts [--force] [--with-llm] [--repo <key>]` | Also `--max-llm-specs`. With the `contract-mappings` plugin, `contracts-map` is available (see integration-surfaces). |
| `specguard impact <target> [--max-depth <n>] [--upstream]` | Target is a node id, a unit, or a file. |
| `specguard test run [--unit <keys...>] [--affected] [--since <ref>]` | |
| `specguard init [--single]` | Detects monorepos and writes the units manifest. |
| `specguard check --workspace [path] [--refresh]` | Prints the rollup. |
| `specguard serve --workspace [path]` | |
| `specguard key set` / `key status` | |

<a id="mcp-tools"></a>
### MCP tools

`specguard_contracts`, `specguard_impact`, `specguard_workspace_status`, `specguard_workspace_drift`.

<a id="http"></a>
### HTTP

- `GET /api/v1/units`
- `GET /api/v1/workspace` (local, read-only)
- `PUT /api/v1/workspaces/<name>`
- `GET /api/v1/workspaces[/<name>]`
- `GET /api/v1/workspaces/<name>/rollup`

<a id="files"></a>
### Files

- `.specguard/workspace.json`: name, `repos` (path, role, description, optional catalog), and a `units` map (path, kind, role, packageName, ecosystem, test command and framework).
- `.specguard/contracts.json`: version, generatedAt, nodes, edges.
- `.specguard/rollup.json`
- `.specguard/trace.json`: carries the per-unit rollup.
- `.specguard/.env` at workspace and repo level, and the per-user `~/.config/specguard/.env`.

<a id="spec-syntax"></a>
### Spec syntax

A contracts block in the Dependencies section:

```
<!-- contracts:start -->
<repoKey>::<specPath> [<type>: <surface>, ...]
<!-- contracts:end -->
```

Claim refs are `repo:specKey#claim`, or `specKey#claim` within the current repo.

<a id="exit-codes"></a>
### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | Missing manifest or unresolvable target. |
| 3 | Drift detected in a consumer. |

`check --workspace` exits with the worst per-repo outcome (validation failed, drift, missing specs).

<a id="requirements"></a>
## Requirements

<a id="business-organization"></a>
### Business organization
- **workspace-business-journeys**: A workspace has a maintained business overview and ordered journeys, groups and steps linking application-qualified features, specs and claims across repositories. The CLI and editor can create, edit, reorder and remove organization without renaming specs or claim IDs. They show missing references and draft/reviewed status independently of proof, and reject saves against an outdated revision.
- **journey-draft-review**: Automatic drafting uses configured model access and existing specs/catalogs only and rejects invented references. It writes a reviewable proposal instead of changing active organization. On refresh it preserves existing descriptions, order and references and marks journeys with newly added steps draft. It refuses to apply a proposal after organization or catalog inputs change.

<a id="manifest-and-registration"></a>
### Manifest and registration
- **workspace-manifest**: The manifest at `.specguard/workspace.json` lists repos with a path, a role (consumer, provider, test or docs), an optional description and an optional catalog directory. It is found by walking up from any child directory, and unknown fields are preserved.
- **manifest-errors**: A missing manifest is a clear "not found" configuration error. An invalid or schema-failing manifest is a configuration error. Repos without their own SpecGuard config load with no config rather than failing.
- **workspace-init-heuristics**: `workspace init` registers sibling repos that have a SpecGuard config. The key comes from the directory name alone. The role comes from the repo's contents (test frameworks, UI or server dependencies, API schema files, language markers), never from a platform-specific name. It never overwrites an existing manifest and fails with guidance when no repo is found.
- **workspace-status**: `workspace status` shows each repo with role, spec count, incoming and outgoing contract edges and configuration health. It also shows contract health (verified versus stale edges, with a breakdown by edge type) and tells the user to build the graph when none exists.
- **units**: A workspace is a set of units (`kind: repo|package`) under `units`, and a manifest may mix both. Existing `repos` manifests load unchanged as units of kind repo. A repo-kind unit is also visible under `repos`. A key listed as both is rejected.
- **workspace-ignore**: A repo or unit entry may carry `ignore: true` (with optional `ignoreReason`). Loading moves ignored entries from `repos` and `units` into `ignored`, so every pipeline (contracts, impact, drift, trace, test run, security, proofs, rollup) skips them without its own check. A key under both `repos` and `units` is still rejected. `workspace ignore|unignore <key>` edits the raw manifest without normalising it.
- **workspace-resolve**: Workspace-level commands take `--workspace <path>` or `SPECGUARD_WORKSPACE`, naming a `workspace.json`, its folder, its `.specguard` folder or a `.code-workspace` file (JSON with comments). A `.code-workspace` keeps its manifest in `<its folder>/.specguard-workspaces/<name>` unless its `specguard.workspaceManifest` setting says otherwise. Per-repo state such as the proof ledger never follows the flag.
- **workspace-sync**: `workspace sync` and `workspace init --from <file>` register the folders of a `.code-workspace` as repos (key from folder name, role from contents, identity by real path). Folders with no SpecGuard config are added as ignored with reason `auto:no-config`, and the ignore is lifted once a config appears. Missing folders are reported, and dropped folders are removed or ignored. Sync never changes an entry it did not create or a field edited by hand. `workspace init --recursive` searches nested folders and stops at a repo.
- **workspace-sync-overlay**: A folder with no config of its own but covered by an overlay is a normal repo unit, not `auto:no-config`. It records `configVia: overlay` in an optional unit field (manifests without it load unchanged). The scan, rollup and role guess read config, trace and proofs from the overlay. A git root whose overlay entry names an app folder inside it counts as covered. A monorepo root whose apps each have an entry (ambiguous) does not.
- **workspace-sync-retire**: A unit sync marked `auto:no-config` is retired on the next sync once an overlay covers it, and `configVia` is dropped when the overlay stops covering it. A unit a person marked ignore by hand (any other reason, or an entry sync did not create) is never touched.
- **plugin-commands-from-workspace**: When no config is found at or above the directory but a workspace manifest is, plugin commands are those of the plugins enabled by the union of the workspace repos' configs, the same rule `contracts` uses.

<a id="monorepo-detection-and-units"></a>
### Monorepo detection and units
- **monorepo-detection**: Detection reads pnpm, Yarn and npm workspaces, Nx, Turbo and Lerna config and expands package globs honouring exclusions. It reports the package manager and records each package's name, directory, test framework and whether it has a test script. A single-package repo is reported as not a monorepo.
- **per-package-test-command**: Each package gets a test command that runs only its tests through the repo's own tooling (Nx, Turbo, pnpm, Yarn or npm). `init --single` opts out of per-package handling.
- **more-ecosystems**: Detection also covers Go (`go.work`), Cargo workspaces and uv workspaces, and a repo may hold several. `init` writes one app per ecosystem over every package's sources, plus a units manifest carrying each package's test command, with glob negations kept at the front.
- **unit-claim-refs**: A claim ref naming a package unit (`web:capabilities/auth#login`) means the workspace root's claim. Proofs and test tags carrying it are stored and found under the unprefixed ref, and journey references through a package unit resolve. Refs naming a separate repo are left alone. *Planned:* a capability may also live inside one unit's own spec tree.
- **cross-repo-claim-refs**: A claim can be referenced as `repo:specKey#claim` (or `specKey#claim` in the current repo), so a journey or proof can depend on a claim in another repo.
- **unit-aware-pipelines**: `check` reports each unit's source files, unowned files and the capabilities touching it. A capability spanning packages appears in each and gets one drift verdict. `test run` runs each package unit's command, only named units with `--unit`, or with `--affected [--since <ref>]` the changed units plus every unit that depends on them. It runs everything when a changed file is outside every unit. `serve` exposes the rollup at `/api/v1/units`, and security plan items carry the unit key.

<a id="contract-graph-impact-and-drift"></a>
### Contract graph, impact and drift
- **contract-graph-model**: `.specguard/contracts.json` stores nodes (a spec in a repo, id `<repo>::<specPath>`) and directed consumer-to-provider edges. Edge types are graphql, rest, iframe, upload, event, test or docs. Each edge has a surface list, a last-verified time and a source.
- **contract-sources**: `contracts` builds edges from structured blocks in Dependencies sections, from importers supplied by enabled plugins and, only with `--with-llm`, from free-text dependencies of specs with no structured block. Non-matching lines are skipped.
- **contracts-idempotent**: Building is idempotent and incremental: existing edges are preserved and surface items merged. `--force` rebuilds from scratch and `--repo <key>` restricts to one repo. Validation problems such as an edge naming a missing node are warnings that do not fail the command. The file is written atomically.
- **contracts-llm-cap**: `contracts --with-llm` states before sending that only each spec's Dependencies section goes to the model (and to which provider and model) and lists each spec it sends. It stops at `--max-llm-specs` (default 50), naming the specs not sent.
- **contract-node-ids-consistent**: Nodes are named `<repo>::<repo-relative spec path>` in every pass, never by spec key, so a spec found by a block and by the model is one node. Earlier graphs are corrected with `contracts --force`.
- **package-edges**: Dependencies between units, read from each unit's manifest (package.json, go.mod, Cargo.toml, pyproject.toml), become `package` edges with source `workspace`. They are rebuilt on every `contracts` run so removed dependencies disappear. `impact` accepts a unit or a file inside one and reports the capabilities with code in the affected units as well as the units.
- **impact-blast-radius**: `impact` accepts a node id, a workspace-relative path or an absolute path. It walks consumers breadth-first to a depth limit (default 6) and separates direct from transitive consumers with the connecting edge type and surface. `--upstream` also lists the providers the target depends on.
- **impact-suggestions**: `impact` suggests a drift command per affected consumer repo and an "update docs" suggestion for docs-type edges. It reports "no downstream consumers" with exit 0, and exits 1 with an example id format for an unresolvable target or with guidance when no graph exists. It never modifies files.
- **workspace-drift**: `workspace drift` finds repos with changes since a git ref (default the previous commit) and maps changed files to graph nodes. It runs drift in the affected consumer repos for the dependent specs, supports `--force` and `--repo`, and exits 3 when any consumer has drifted.

<a id="rollup-serving-and-server"></a>
### Rollup, serving and server
- **workspace-rollup**: Per repo and in total, the rollup combines coverage, claims proven, failed, stale and unproven, claims by test layer, open security items by severity from the newest plan, documentation freshness and intent gaps (recorded in the trace by `check`). A state says why a repo has no numbers. Ignored repos are listed and add nothing to totals.
- **workspace-check**: `check --workspace [path]` prints the rollup and writes `.specguard/rollup.json`. With `--refresh` it first runs `check` in each active repo. The exit code is the worst per-repo outcome.
- **workspace-serve**: `serve --workspace [path]` serves every active repo as a project and the rollup at `GET /api/v1/workspace`, read-only.
- **server-workspace**: A team server keeps named workspaces (projects with key, role and ignore flag; file and Postgres storage). A maintainer with an unscoped token defines them with `PUT /api/v1/workspaces/<name>`. They are readable at `GET /api/v1/workspaces[/<name>]`. `GET /api/v1/workspaces/<name>/rollup` combines each project's newest snapshot like the local rollup (no snapshot shows as `no-trace`; ignored projects are listed, not counted). A token limited to one project may not define a workspace and sees only one made of that project alone.
- **workspace-publish**: `workspace publish [--name n] [--server url]` defines the workspace on the team server from the manifest. Each repo is named by the manifest's `server.projects` map, else its own `server.project`, else its folder. Ignored repos are flagged. A missing server or a refusal is reported and fails the command. Each repo still publishes its own snapshot.

<a id="environment-and-keys"></a>
### Environment and keys
- **shared-env**: A workspace-level `.specguard/.env` supplies shared keys to every repo. A per-repo `.specguard/.env` takes precedence, and real environment variables are never overwritten.
- **user-env**: A per-user `~/.config/specguard/.env` (or `$XDG_CONFIG_HOME/specguard/.env`) supplies keys to every workspace and repo at the lowest precedence, below the repo's and workspace's file and below real environment variables.
- **key-command**: `specguard key set` saves the model API key (`llm.apiKeyEnv`, default `ANTHROPIC_API_KEY`) into the user's, workspace's or repo's `.env` with mode 600. It reads the key from a hidden prompt, stdin or `--from-env`, never from an argument. It replaces an existing line, refuses a multi-line value and never prints the key. `key status` says which files define it without showing it. `config.json` only ever names the variable.
- **env-permission-warning**: When `.specguard/.env` is readable by other users, the CLI warns, naming the file and the fix (`chmod 600`). It never prints a value and still loads the file.

<a id="code-map"></a>
## Code map

The grouping below is inferred from file names.

- **Manifest, units, sync, rollup:** `src/core/workspace.ts`, `src/core/workspace-heuristics.ts`, `src/core/workspace-units.ts`, `src/core/workspace-sync.ts`, `src/core/workspace-rollup.ts`
- **Monorepo detection:** `src/core/monorepo.ts`
- **Contract graph:** `src/core/contracts.ts`, `src/pipelines/contracts.ts`
- **Impact, drift, publish:** `src/pipelines/impact.ts`, `src/pipelines/workspace-drift.ts`, `src/pipelines/workspace-publish.ts`
- **Business organization:** `src/core/experience.ts`, `src/cli/commands/experience.ts`
- **Environment and keys:** `src/core/env.ts`, `src/cli/commands/key.ts`
- **CLI commands:** `src/cli/commands/contracts.ts`, `src/cli/commands/impact.ts`, `src/cli/commands/workspace.ts`, `src/cli/commands/workspace-check.ts`

The capability owns 19 files.

<a id="tests"></a>
## Tests

- `tests/core/experience.test.ts`, `tests/cli/experience.test.ts`
- `tests/core/monorepo.test.ts`
- `tests/core/env.test.ts`, `tests/cli/key.test.ts`
- `tests/core/workspace-heuristics.test.ts`
- `tests/core/claims.test.ts`
- `tests/pipelines/init.test.ts`
- `tests/core/workspace-units.test.ts`
- `tests/pipelines/workspaces.test.ts`
- `tests/core/workspace-sync-overlay.test.ts`
- `tests/pipelines/contracts-node-ids.test.ts`
- `tests/plugins/commands-workspace.test.ts`

Scenarios the spec expects to hold:

- **Register a multi-repo system:** `workspace init` lists four repos with roles judged from contents, and re-running changes nothing.
- **Build the graph and ask about impact:** a contracts block yields an edge with the mutation names as surface, and `impact` lists the consumer and suggests drift.
- **Cross-repo drift:** `workspace drift --since origin/main` reports each consumer as drifted, no drift, skipped or error, and exits 3 on any drift.
- **Monorepo initialisation:** a pnpm repo gets `pnpm --filter <name> test`, and `--single` yields one app.
- **Unknown target:** `impact unknown/path.md` exits 1, shows the id format and changes no file.
- **One capability across two packages:** a change in `packages/api` yields one drift verdict for the capability, runs only the affected units' tests, and stores a proof via `api:capabilities/auth#logout` as the root claim.

<a id="security-and-data"></a>
## Security and data

- File reads and git commands are bounded to the repos in the manifest. Paths resolve relative to the workspace root, and by default the manifest cannot cause reads outside it.
- Monorepo detection only reads configuration files and never runs project code or package scripts.
- The graph and manifest hold repo names, spec paths and API surface names, with no secrets.
- LLM extraction runs only on explicit `--with-llm` and sends only each spec's Dependencies section. Avoid it for sensitive specs.
- Shared environment files may hold API keys. `init` git-ignores them, real environment variables always win, and `.env` files written by `key set` are mode 600. The CLI warns about group- or world-readable `.env` files.
- `workspace drift` runs the SpecGuard CLI in sibling repos, and only repos named in the manifest are touched.
- On the team server, a token scoped to one project cannot define a workspace.

<a id="extending-it"></a>
## Extending it

The spec describes these extension points only:

- **New contract sources:** edges can come from importers supplied by enabled plugins, which `contracts` consumes. Importers are read from the plugins enabled across the workspace repos' configs.
- **Plugin commands at a workspace root:** these follow the union-of-repos rule in `plugin-commands-from-workspace`.
- **New ecosystems:** `more-ecosystems` and `monorepo-detection` define the current set (JavaScript tooling, Go, Cargo, uv). A new ecosystem would need detection, per-package test command generation and a unit-manifest dependency reader for `package-edges`.
- **New edge types:** the graph model fixes the types to graphql, rest, iframe, upload, event, test, docs and `package`.

Constraints to preserve when changing code:

- Keep node ids `<repo>::<repo-relative spec path>`.
- Keep graph building idempotent and the file write atomic.
- Keep `impact` read-only.
- Handle ignored entries only through manifest loading, not in individual pipelines.
- Leave entries and fields sync did not create untouched.

The spec does not describe internal APIs beyond these points.
