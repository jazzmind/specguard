---
id: 2026-10-15-functional-specs-and-four-pillars
date: 2026-10-15
kind: prompt+plan
author: Wes Sonnenreich
source: claude-code
affects:
  - system
---

# Functional specs, master system spec, and the four pillars

## Prompt (verbatim)

I want to look at specguard and how it generates specs. I feel like the specs are very granular and linked very closely to individual code files. I would prefer to have our specs be higher level - functional - where a single spec file links to multiple code files and covers functionality linked to user/business value. There needs to be a high-level master spec that describes the entire system, the problems it solves and the value it creates, then summarizes and links to the functional components that deliver the value.

As an example, AI portal now has 329 specs. This is an informational web portal with a training CMS and a few other features. There should be ~10-15 high level functional specs for this portal. It's fine to fan out the functional specs into backend/frontend or other sub groupings. Specs need to link to tests & docs so the key functionality of specguard is preserved.

I'm also concerned specguard itself has gotten very complicated - there are a lot of features. The philosophy is that code is fluid but specs, and the tests that ensure conformance, are the source of truth. It has the following key functional aspects:
1) create/maintain specs for systems. We should also maintain a history of requirements as the code evolves. E.g. this prompt, and the plans that get generated, should be part of the history of the specguard repo.
2) ensure & run conformance tests that prove the current code delivers against the specs. This includes agentic tests that use tools like playwright and LLM analysis to validate functionality against the problem/value. 
3) generate human and AI readable documentation for the system. This incudes user docs and developer docs as well as spec audits like the traceability matrix. Present these via API such that a viewer can retrieve and format the docs dynamically. E.g. user docs shouldn't be a static generation from the specs but rather generated on the fly from the specs using a fast llm like haiku/luna. 
4) run security scans that can also consider the specs and look for issues that are due to spec-level problems as well as code level. The scans can generate remediation plans which can be managed by other systems to automate remediation.

## Follow-up decisions

- Multi-repo support (contracts, impact, workspace) stays in core and also extends to monorepos.
- Code quality, git commit helpers and the feature catalog become generalized plugins. Nothing references any one customer platform directly.
- Docs consumer is `specguard serve` plus a small web UI.
- Requirement history is captured by hooks plus an explicit `history add` command.
- Scope: the SpecGuard redesign plus the AI Portal migration.

## Plan (approved 2026-10-15)

# SpecGuard 0.2: functional specs, four pillars, AI Portal migration

## Context

SpecGuard's founding principle is that **code is fluid, while specs and the conformance tests that prove them are the source of truth.** The tool has drifted from that principle in two ways.

**1. Specs are file-shaped, not value-shaped.**
- `reverse` writes one spec per source file and derives the spec key from the file path (`src/pipelines/reverse-generate.ts:207-267`, `src/core/language-profiles.ts:432`).
- Drift ties source to specs by file name (`src/pipelines/drift.ts:316-331`). The matrix ties tests and docs to specs by basename (`src/pipelines/matrix.ts:85,103`).
- Nothing records the problem a system solves or the value it creates, so agentic validation can only judge against acceptance-criteria bullets.
- **Result in AI Portal:** 485 spec files.
  - 164 of them describe `node_modules` packages (`zod` alone accounts for 140), because the scan has no default excludes.
  - 31 just mirror test folders.
  - Module paths are wrong (`app/` prefix on `lib/` code), and `specs/db/` is stale since the move to DynamoDB.
  - There are 0 claim anchors and 0 `@claim` tags, so nothing is actually linked to tests.
  - The product is really about 13 capabilities.

**2. The tool has outgrown its pillars.**
- About 27K lines of `src`, 29 commands, 30 MCP tools, and a 7.7K-line VS Code extension.
- Spec health is computed five separate ways (`status`, `gap-analysis`, `drift`, `align`, `matrix`), with `analyze` on top.
- Security runs as three overlapping paths (`security`, `deps`, `remediate`).
- Fix plans come in four incompatible formats.
- Docs are static per-spec LLM rewrites with no API.
- There is no requirement history beyond git.

**Goal.** Rebuild around four pillars, with a hierarchical, functional spec model:
- **P1 Specs and history:** a master SYSTEM spec; about 10–15 capability specs, each linked to many code files, tests and docs; and a requirement history holding prompts, plans and decisions.
- **P2 Conformance:** generated and existing tests plus agentic Playwright/LLM verification, all feeding one proof ledger and judged against requirements *and* problem/value.
- **P3 Docs:** a `specguard serve` HTTP API and a small web UI. User and dev docs are generated on demand by a fast model; traceability and audit views come from the same API.
- **P4 Security:** code-level and spec-level scans producing one published `RemediationPlan` JSON schema that other systems can consume. `remediate` executes those plans.

**Decisions taken:**
- Multi-repo support (contracts, impact, workspace) **stays in core and extends to monorepos**, using one workspace model in which a unit is either a repo or a package (Phase 8).
- quality, git-commit and feature-catalog become **generalized plugins**.
- **Nothing names Practera.**
- The docs consumer is `serve` plus a web UI.
- History is captured through hooks plus an explicit command.
- Scope covers the SpecGuard redesign plus the AI Portal migration.

**Release.** Ship as **0.2.0 (breaking)**, published under the npm `next` dist-tag until AI Portal migrates cleanly. This matters because `action.yml:33` defaults to `version: latest`. The parser keeps reading v1 specs, so repos that haven't migrated keep working.

---

## Phase 0: Record intent (dogfood)

1. Create `specs/history/2026-10-15-functional-specs-and-four-pillars.md` in SpecGuard. It holds this prompt verbatim, this approved plan, and the decisions above. Frontmatter fields: `id`, `date`, `kind: prompt+plan`, `author`, `affects`, `source: claude-code`.
2. Draft `specs/SYSTEM.md` as prose only:
   - the problem: code drifts from intent, and AI-written code makes it worse
   - the users: developers, coding agents, reviewers, auditors, security
   - the value it creates
   - the four pillars and the non-goals
   - a capability list

   Its frontmatter becomes machine-checked in Phase 1.

## Phase 1: Spec model v2 (P1 foundation)

**Format.** YAML frontmatter, parsed with the existing `yaml` dep. **Lists must be block lists, with globs quoted.** Flow lists with `{a,b}` or a leading `*` are a YAML error, so the parser reports a clear message instead.

```yaml
---
id: training-learner-journey          # must equal the file's basename; specKey = id
kind: capability                      # system | capability | component | journey
title: AI Mastery Training — Learner Journey
parent: system                        # capability id for components
value: Employees build practical AI skills through guided, gated lessons.
status: active
sources:
  - "lib/training/**"
  - "app/api/training/{modules,activities,progress}/**"
tests:
  - "test/e2e/lesson-flow.spec.ts"
docs:
  - "docs/training/**"
history:
  - 2026-10-15-functional-specs-and-four-pillars
---
```

**Capability sections:**
- `## Problem & Value` (required)
- `## Users & Journeys`
- `## Requirements` (claims, `- [ ] … <!-- claim: id -->`)
- `## Scenarios`
- `## Security & Data Considerations`
- `## Interfaces`
- `## Out of Scope`
- `## Components`

`kind: journey` keeps its existing World, Actors, Invariants and `verifies:` semantics (`src/core/claims.ts:192-217`). `SYSTEM.md` contains Problem, Users, Value, Capability Map, Architecture Overview and Non-goals.

**Code changes:**
- `src/core/types.ts`: add `SpecKind`. Make `sources`, `tests` and `docs` `string[]`; `sources` is a comma-split string today (`spec-key.ts:76-82`, `types.ts:36`), so update every caller. Add `parent`, `value` and `history`.
- `src/core/spec-parser.ts`: parse frontmatter first and fall back to `parseMetaComment`. Note that `parseMetaComment` (`:36`) grabs the *first* HTML comment, so it must skip the frontmatter case. Map `Acceptance Criteria` to `Requirements`.
- New `src/core/spec-graph.ts`, which loads every spec into a tree and provides:
  - an **id→file index**, used by `locateSpec` in `proof.ts:179-222` in place of path derivation
  - `specsForFile(path)`, which can return several specs or none ("unowned")
  - `ownedFiles(spec)`
  - validation: exactly one SYSTEM, known parents, filename equal to `id`, no duplicate claim ids (make `duplicateClaimIds` at `claims.ts:39` a hard gate), and the capability count at or below `granularity.maxCapabilities`
- `spec-key.ts`: `declaredSources` becomes the single file→spec resolver for every pipeline.
- **Workspace-aware from day one:** every spec graph node carries a `unit` (default: the repo itself), and `specsForFile` takes workspace-relative paths. Monorepo and multi-repo support (Phase 8) then plugs in without reworking the graph.
- **Default excludes** in `config.ts`, always applied: `node_modules`, `dist`, `.next`, `build`, `coverage` and `.git`. The `tests` source group no longer feeds spec generation. Also fix the `featureFromPath` doc/code mismatch.
- **Claim-scoped staleness.** Today any change to the spec or file hash marks every proof stale (`proof-ledger.ts:54-59`). With capability-sized specs that would trip CI constantly, because `proof-stale` is a default fail-on gate (`action/run-gates.mjs:25`). The fix: a proof records the **claim hash**, computed over the claim text plus the normative sections (Problem & Value, Requirements, Interfaces) and leaving out frontmatter such as `history`/`sources`. File staleness comes from claim-level drift verdicts (Phase 4), not from raw file hashes.
- **Model tiers:** add `llm.models: { fast, frontier }`. The pipelines that need them are `summarize`, `docs`, `history` and `spec-review` (`config.ts:83-99`). The defaults are the LiteLLM aliases `fast` and `frontier`.
- **SpecGuard's own migration** (moved here from Phase 0, because it needs this parser):
  - Write 9 capability specs:
    - `spec-authoring`
    - `requirement-history`
    - `traceability-and-drift`
    - `conformance-testing`
    - `agentic-verification`
    - `documentation-api`
    - `security-and-remediation`
    - `workspaces` (multi-repo and monorepo)
    - `integration-surfaces`
  - Move the 104 v1 specs to `specs/_archive/v1/`.
  - Collapse the 6 apps in `.specguard/config.json` into one.
  - This hand migration becomes the golden reference for `consolidate`.

## Phase 2: Generating and migrating specs (P1)

All of this sits under `specguard spec …`. `reverse` and `import` stay as aliases.

**`spec draft`** works as map → cluster → synthesize:
1. **Inventory**, with no LLM: tree, routes, handlers, README/CLAUDE.md, existing specs, tests and docs.
2. **Summarize:** the `fast` model writes a summary per file, cached by content hash in `.specguard/cache/summaries.json`.
3. **Cluster:** the `frontier` model proposes SYSTEM and a capability map (id, value, globs, rationale), bounded by `granularity.target` (default 8–15). It writes `.specguard/spec-map.md` for human review, deliberately outside `plans/` because the extension lists that folder (`host.ts:981`). `--yes` skips the review.
4. **Synthesize** each capability from its file summaries plus key interface files.

This reuses `llmGenerateObject`, `writer.ts`, and the concurrency in `reverse-generate.ts`.

**`spec consolidate`** migrates v1 specs to v2. It clusters existing specs and then merges their requirements. Claim handling is a **one-shot rewrite, not runtime aliasing.** Runtime aliasing can't keep proofs alive, because ledger lookup is exact-key (`proof.ts:434`) and ingest requires the anchor in the located file (`proof.ts:323`).
- **Slug rules:**
  - keep the slug if it is unique within the capability
  - if two bullets have identical text, merge them and map both old refs to the one claim
  - otherwise prefix the old leaf name (`<leaf>-<slug>`, within the 48-character cap)
  - never use encounter-order numeric suffixes (`claims.ts:66-71`)
- **Rewrite** `@claim` tags in tests and journey `verifies:` refs.
- **Rekey** the proof ledger rows (left `stale`, which is honest) and the drift registry.
- **Write `.specguard/claim-migration.json`** as the report. For one release, `results ingest` accepts old refs through this map, so CI results and cross-repo `repo:` refs still carrying old tags keep working.
- **Archive** the v1 specs, and delete specs whose module resolves under excluded paths.
- In AI Portal there are no claims to preserve, so claims are assigned fresh by `spec claims`.

**Other commands:**
- `spec import`: the existing `import.ts`, which now targets a capability and records a history entry.
- `spec claims`: the existing `claims assign/list`.
- `spec index`: regenerates the marked Capability Map region of SYSTEM.md using the `root-doc-sync` markers (`src/core/root-doc-sync.ts`). Prose stays human-owned.

## Phase 3: Traceability model (backbone for P1, P2 and P3)

**Trace model.** New `src/core/trace.ts` builds one model: system → capability → claim, with tests, proof verdict, staleness, docs, last history entry and drift. Inputs:
- the spec graph
- owned files
- `tests:` globs and `@claim` tags (`buildClaimTestIndex`, `claim-tags.ts:118`)
- the proof ledger
- docs globs
- history
- the drift registry

It is written to `.specguard/trace.json`. **Through 0.2.x it also writes the legacy views derived from it:**
- `traceability.json`
- `alignment.json`, which `run-gates.mjs:195` reads
- `analysis.json`, `fix-plan.json`, `gaps.json`, `code-quality.json` and `dep-check.json`, which the extension reads at `host.ts:396,407,454,910-911`

That keeps the extension and the Action working unchanged.

**`specguard check`** replaces `status`, `gap-analysis`, `matrix`, `analyze` and `align`:
- views: `--coverage`, `--gaps`, `--matrix [--csv]`, `--drift`, `--align`
- every old command stays as an alias with **identical args, `--json` shape and exit codes**
- `status` stays indefinitely, because the existing hooks match the substring `specguard status` (`scaffold.ts:291`)

**Capability drift with claim-level output:**
1. Get the git diff (`-U2 --diff-algorithm=histogram`) and map changed files to capabilities with `specsForFile`.
2. Filter out lockfiles, generated files and snapshots. Test diffs are handled separately.
3. Rank the remaining files by interface relevance: routes, handlers, exported-signature changes.
4. Pack them into chunks of about 40k characters. A file over budget is reduced to its hunk headers plus changed exports.
5. Every chunk gets the full Requirements (with claim ids) plus Problem & Value. The output is `{drifted, affectedClaims[], unspecifiedBehaviour[]}`.
6. Merge the chunk results as a union, up to a per-capability chunk cap. Above the cap, report "too large, review manually" with the file list.

`affectedClaims` drives claim-level staleness. `unspecifiedBehaviour` and unowned changed files both show up as spec gaps.

## Phase 4: Requirement history (P1)

**Storage.** New `src/core/history.ts` and `src/pipelines/history.ts`. Entries are committed under `specs/history/YYYY-MM-DD-<slug>.md`.

**Commands:**
- `history add --prompt|--plan <file>|--decision|--affects`: when `--affects` is missing, the `fast` model proposes which capabilities are affected, using the text plus the diff. It also updates the `history:` back-refs in those capabilities. Claim hashes exclude frontmatter, so this does not mark proofs stale.
- `history log [--capability]`: shows the timeline.
- `history inbox`: reads the hook's JSON from stdin, redacts it, and prints nothing.
- `history capture`: also reads stdin.

**Hooks** are opt-in via `init --history-hooks`, and enabled for SpecGuard and AI Portal:
- Generalize `mergeClaudeSettings` (`scaffold.ts:275-319`) from one hardcoded hook to a table of `{event, matcher?, marker, command}`, keeping the idempotent merge and `--update-hooks` rules.
- **`UserPromptSubmit` → `history inbox`:**
  - Stdout is injected into the model's context, so the command must print nothing.
  - It uses the resolved local binary (no `npx` cold start) and ends with `|| true`.
  - It parses real JSON. The current hook uses `sed` (`scaffold.ts:264`), which breaks on quotes and newlines.
  - It appends to `.specguard/history/inbox.jsonl` (uncommitted, size-capped like `activity-hook.ts`), keyed by `session_id` and `cwd`.
- **`PostToolUse` on `ExitPlanMode` → `history capture`:**
  - Reads the plan from `tool_input.plan`, falling back to `transcript_path`.
  - Pairs it with prompts **from the same `session_id`**, so concurrent sessions don't cross-contaminate.
  - Writes one committed entry. Prompts that never lead to a plan are not committed.
  - Verify during implementation that the hook fires only when the plan is approved.
- **Redaction** with `createRedactor(…, 'text')` (`src/core/redact.ts:79`) happens both at inbox write and at capture.

**Reporting.** `check` flags capabilities whose sources changed with neither a history entry nor a spec edit.

## Phase 5: Conformance (P2)

- **`test generate`:** `forward-generate.ts`, now driven by capability Scenarios. Output goes to `<testOutput>/<capability>/…` with `@claim` tags.
- **`test run`:** runs the configured test command and then ingests the results (`results.ts`, test-runner adapters) in one step. `results ingest` and `proof ingest/status` stay as they are, because they are the entry point for CI and external systems.
- **`test heal`:** `heal.ts`, unchanged.
- **`verify`:** `validate.ts`, using the Playwright adapters and guardrails, with three changes:
  1. Goals are built per capability from Users & Journeys and Scenarios, so the agent drives complete journeys.
  2. The judge also receives **Problem & Value**. It returns per-claim verdicts plus a capability-level judgement: does the observed behaviour deliver the stated value? Gaps become findings.
  3. Verdicts are written to the proof ledger through `ingestVerdicts` (`proof.ts:294`) with `evidence: agentic`. Today they live only in `validation-history.json`.

## Phase 6: Documentation API and web UI (P3)

**Server.** `specguard serve [--port 4317]` lives in a new `src/server/`, built on `node:http`. It binds to localhost, has no new framework dependency, and is read-only.

**Endpoints** under `/api/v1`, all derived from the trace model and the spec graph:
- `GET /system`, `/capabilities`, `/capabilities/:id`, `/capabilities/:id/history`, `/history/:id`
- `GET /trace` (the matrix) and `GET /audit` (coverage, stale proofs, drift, gaps, unowned files)
- `GET /docs/:audience/:id` and `/docs/:audience/system`, where the audience is `user`, `dev` or `agent`:
  - Docs are generated **on demand** by `llm.models.fast`. `llm.ts` has no streaming (`:369-394`) and replay doesn't cover streams, so responses are not streamed.
  - Results are cached in `.specguard/cache/docs/` by `(specHash, audience, promptVersion)`, with single-flight so identical concurrent requests produce one LLM call.
  - Budgets are **per request**. The budget in `llm-runtime.ts:26` is process-wide, and a long-running server would exhaust it.
  - The `user` audience leaves out claims and internals, `dev` adds sources, interfaces and tests, and `agent` is a compact structured form.
- `GET /security/plans`, `/security/plans/:id`
- `doc-generate.ts` folds into this shared generator.

**Web UI.** A small static SPA served at `/`, reusing the extension's React webview pieces where they fit (`extension/src/webview/`). Views:
- system overview
- capability detail: value, requirements with proof status, tests, docs and history
- user and dev docs
- matrix and audit
- security plans

**Deferred to a follow-up:**
- the VS Code extension becoming a thin API client. It keeps working through the legacy views in the meantime.
- write endpoints
- OpenAPI
- static `docs build`

## Phase 7: Security and remediation (P4)

**`specguard security scan`** merges `security --with-sast`, `deps` and remediate's detection into one detector set. It reuses:
- `adapters/docker.ts` and the Semgrep call in `security.ts`
- `npm-audit.ts` and `pip-audit.ts`
- `pipelines/remediate/` detection: advisory, ecosystems, gitleaks

**New spec-level review**, using the `spec-review` model per capability. It reads Problem & Value, Users, Requirements, Interfaces, and Security & Data, and flags:
- missing authz or data-classification requirements
- unspecified abuse cases or rate limits
- contradictory requirements
- interfaces with no owning claim
- code findings that reveal a spec gap

Finding types are `spec`, `code`, `dependency` and `secret`.

**`RemediationPlan` schema.** `src/core/remediation-schema.ts` is a Zod schema, also exported as JSON Schema to `schemas/remediation-plan.v1.json`. Each item has:
- finding refs and severity
- capability and claim links
- affected files
- change type: `code`, `spec`, `dependency` or `config`
- verification, meaning the claims that must stay proven
- status: `open → planned → in-progress → fixed → verified | wont-fix`
- `externalRef`

Plans go to `.specguard/security/plans/<id>.json` and are served by the API. They replace `fix-plan.json`, the per-pipeline `plans/*.md` and the ad-hoc remediate report; `plan-writer.ts` renders markdown from the schema. External systems consume plans from the files or the API, and update status with `specguard security plan set-status` (an HTTP write endpoint is deferred).

**`security fix <planId|--all>`** is the existing `remediate` executor (worktree patching plus the proof-ledger behaviour verdict). It now consumes plan items and updates their status. When a `spec`-type item is fixed, it writes a history entry.

## Phase 8: Workspaces: multi-repo and monorepo, one model

**One model.** A **workspace** is a set of **units**, and a unit is either a separate repo or a package inside a monorepo. `.specguard/workspace.json` (`src/core/workspace.ts`) gains `units: { <key>: { path, kind: repo|package, role } }`. The existing `repos` map is read as units of kind `repo`, so current manifests keep working. A repo can be both: a multi-repo workspace can contain a monorepo, whose packages become nested units.

**Spec hierarchy across units:**
- The workspace-root `specs/SYSTEM.md` describes the whole system.
- A capability can live at the workspace root, for cross-cutting functionality whose `sources` span units (for example `apps/web/**` plus `packages/api/**`). It can also live in a unit's own `specs/` when it is local to that unit.
- A unit may have its own `kind: system` spec for a subsystem, whose `parent` is the workspace SYSTEM.
- Claim refs generalize the existing `repo:specKey#claim` prefix (`claims.ts:140-144`) to `unit:specKey#claim`. Journeys can then verify claims across packages as well as across repos.

**Monorepo detection** moves out of `init` and becomes a shared workspace service:
- Keep the JS detection in `src/core/monorepo.ts` (pnpm, yarn, npm workspaces, Nx, Turbo, Lerna).
- Add uv/Poetry workspaces (`pyproject.toml`), Go `go.work`, and Cargo `[workspace]`, through the language profiles (`src/core/language-profiles.ts`).
- `testCommandFor` gains the matching per-ecosystem commands.
- `init` stops generating one config app per package (`src/pipelines/init.ts:60-73`), which recreated the per-file granularity problem at package level. Instead it writes one config plus a units manifest, and `spec draft` clusters capabilities across packages by function, not by package.

**Pipelines that become unit-aware:**
- **`check` and the trace model:** coverage and gaps roll up per unit and per system. `unowned` is reported per unit.
- **Drift:** changed files map to units and then to capabilities. A capability that spans packages gets one drift verdict.
- **`test run`:** runs only the affected units' tests, using Nx/Turbo filters or per-package commands from `testCommandFor`. It ingests results per unit.
- **`contracts` and `impact`:** edges connect capabilities, not files or repos.
  - Internal package dependencies (workspace deps in package manifests, `go.work`, Cargo paths) generate edges automatically, under a new `package` edge type.
  - `impact <file|capability>` gives the capability-level blast radius across packages and repos.
  - Replace the platform-flavoured examples in the `contracts.ts` header with generic ones.
- **`serve`:** run at a workspace root, it shows the system, then units, then capabilities, and adds `GET /api/v1/units`.
- **`security scan`:** runs per unit; findings and plan items carry the unit key.

**Commands:** `workspace {init,status,drift}` keeps its names. `workspace init` detects a monorepo, multi-repo siblings, or both.

**Proving ground:** a monorepo fixture in tests (pnpm plus Turbo, two apps and a shared package). For a real repo, check `deploykit` (which has `webui/` and `sandbox/`) and use it if it qualifies. It must not be migrated as part of this plan without asking first.

## Phase 9: Simplify the surface: plugins and cuts

**Core commands:**
- **Specs:** `init`, `spec {draft,consolidate,import,claims,index}`, `history {add,inbox,capture,log}`, `check`
- **Conformance:** `test {generate,run,heal}`, `results ingest`, `proof {ingest,status}`, `verify`
- **Docs:** `serve`
- **Security:** `security {scan,fix,plan}`
- **Workspaces (core):** `workspace {init,status,drift}`, `contracts` and `impact`, covering multi-repo and monorepo (Phase 8).

**Plugins.** Generalize `src/plugins/types.ts` with the extension points `commands` (CLI and MCP), `detectors`, `discoverers`, `externalIdAdapters`, `resultSources` and `docRenderers`.
- Plugin-registered commands mean config must load before commander parses (`src/cli/index.ts:613`).
- npm plugins (`specguard-plugin-<name>`) load only from an explicit `{name, package}` allowlist in config, because importing a package runs its code. Built-ins keep loading by name (`src/plugins/index.ts:36`).

**Moves to plugins:**
- **`quality`:** eslint, knip and ruff, plus `code-quality.ts`. It registers `quality` and a scan detector.
- **`git`:** `git-ops.ts`, `commit` and the changelog. History supersedes the changelog for intent.
- **`feature-catalog`:** `catalog.ts`, `feature-state.ts` and `features --state`. The generalizations:
  - channels become configurable instead of the fixed `ui|api|mcp`
  - features map to capability ids
  - the legacy-traceability importer becomes a generic CSV/JSON importer driven by a column map
- **Delete `src/plugins/practera/`.** Its layout becomes a neutral example config in `docs/examples/`. A test asserts that no `practera` string appears in `src/`, `extension/src` or `action/`.

**Delete:**
- dead `stubs.ts`
- `analyze`, `plan-fix` and `scaffold` (`scaffold` becomes `init --update`)
- `deps` (now part of `security scan`)

The legacy aliases go after 0.2.x, except `status`.

**Regenerate templates.** The scaffold templates (`scaffold.ts:165`), the generated `SKILL.md` and `/goal`, and the CLAUDE.md command table all still reference `gap-analysis`, `analyze` and `reverse`. Regenerate them, and run `init --update` in SpecGuard, AI Portal and the hub.

**MCP** (`src/mcp/server.ts`): about 15 tools mirroring core, plus `read_spec`, `write_spec`, `get_trace` and `history_add`. Plugins add their own.

**Action:** gates become `check`, `test run`, `verify` and `security scan`, and remediate becomes `security fix`. The old gate names map to the new ones for 0.2.x.

**Target size:** core `src` around 18–20K lines, about 14 top-level commands, about 15 MCP tools.

## Phase 10: Migrate AI Portal

Read `apps/ai-portal/CLAUDE.md` and `AGENTS.md` first. This work happens on its own branch, after Phases 1–3 are published to `next`.

1. **Config:** pin `specguard-ai@next`, set `testOutput` to `test/`, set `granularity.target` to 10–15, and enable history hooks.
2. **Clean up:** delete the 164 `node_modules` specs and the stale `specs/db/`.
3. **Consolidate:** run `spec consolidate` with a seeded map, reviewed in `.specguard/spec-map.md` before synthesis.

   | # | Capability | Main code |
   |---|---|---|
   | 1 | Identity & Access | auth, server-auth, role-rank, guest-user, login, api/auth, api/admin/users |
   | 2 | Portal Shell & Platform | layout, brand, feature flags, fetchApi, otel, health/version |
   | 3 | Data Platform & Seeding | lib/ddb, lib/seed, lib/data, admin/seed |
   | 4 | AI Services & Guardrails | lib/ai, ai-security, rate-limit, email, token budgets |
   | 5 | AI Policy Guidance | policy walkthrough, acknowledgement, policy chatbot |
   | 6 | Governed Documents (Docs CMS) | lib/docs, lib/content, api/documents |
   | 7 | AI Toolkit Catalog | lib/toolkit, api/toolkit, api/admin/toolkit |
   | 8 | Use-Case Intake & Risk Triage | lib/intake, api/intake |
   | 9 | Ideas Marketplace | ideas, voting, duplicates, usecase |
   | 10 | Governance Oversight & Vendor Insights | audit, vendors, vendor-requests |
   | 11 | Company Dictionary & Quiz | lib/dictionary, dictionary-quiz |
   | 12 | Training: Learner Journey | modules, lessons, gating, coach, agents/rag, progress (frontend and backend components) |
   | 13 | Training: Engagement & Content Ops | gamification, benchmark, portfolio, admin/training-content |

   The `unit/`, `integration/` and `e2e/` spec dirs become Scenarios and `tests:` links.
4. **Claims and history:** run `spec claims` to assign fresh ids, then tag the existing 43 test files with `@claim` (LLM-proposed and reviewed). Write `SYSTEM.md`. Seed history from `docs/plans/` (training phases 1–7) and from this migration.
5. **Verify:** run `check`, `test run`, and `verify` against `npm run dev`. Then run `serve` and review the docs and audit.

---

## Execution order and PR boundaries

The order is Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Each phase is its own PR off `main` in `utilities/specguard`. Each PR must pass `npm test`, `npm run lint`, `npm run typecheck`, and a self-run of `check`/`drift` (or the pre-0.2 equivalents until Phase 3 lands). Publish to `next` after Phase 3, and to `latest` after Phase 10 succeeds. Phases 4–8 can partly overlap. Phase 8 depends only on Phases 1 and 3.

## Verification

- **Unit tests** for:
  - frontmatter parsing, the YAML error messages, and the v1 fallback (including a v1 file that has only claim comments)
  - spec-graph ownership, overlaps and validation, and id→file lookup
  - claim hashing (an edit to `history:` or `sources:` does not mark proofs stale)
  - the consolidate slug rules and ledger rekeying
  - the trace model, and legacy-view parity (snapshots of each legacy JSON before and after)
  - chunked drift
  - the hook merge table
  - `history inbox`/`capture` with fixture JSON, covering concurrent sessions and redaction
  - `RemediationPlan` round-trip and JSON Schema export
  - server routes on an ephemeral port, including single-flight and the per-request budget
  - plugin loading: built-in, allowlisted npm, and the error for unknown or unlisted names
  - workspaces:
    - a legacy `repos` manifest loads as units
    - monorepo detection for pnpm, Turbo, Nx, uv, `go.work` and Cargo fixtures
    - a capability spanning two packages is owned correctly and gets one drift verdict
    - `test run` runs only the affected packages
    - automatic `package` contract edges, and `impact` across package and repo boundaries
    - `unit:specKey#claim` resolution, including a journey that verifies claims in two units
  - the no-`practera` grep test
- **LLM paths** (draft, consolidate, drift, verify, docs, spec-review, history affects) are tested through the existing replay mechanism.
- **Compatibility:** `action/run-gates.mjs` runs unchanged against the 0.2 CLI on a fixture repo, and the extension loads its views from the legacy files.
- **Metacircular:** on SpecGuard itself:
  - `check` shows 9 capabilities, 0 unowned `src/` files, and its 21 tags and 5 proofs rekeyed
  - `serve` renders SpecGuard's user, dev and audit docs
  - `security scan` emits a valid plan
  - `specs/history/` contains this prompt and plan, linked from the affected capabilities
- **AI Portal:**
  - 485 specs become 1 SYSTEM spec plus about 13 capabilities
  - 0 specs reference `node_modules`
  - every test file is either owned or tagged
  - `verify` runs the Training Learner Journey end to end with Playwright and records agentic proofs
  - `/api/v1/docs/user/system` returns a coherent user guide generated by the `fast` model
