---
id: 2026-10-15-local-first-specguard-with-an-optional-t
date: 2026-10-15
kind: prompt+plan
author: "Wes Sonnenreich"
source: manual
title: "Local-first SpecGuard with an optional team server"
affects:
  - team-server
---
# Local-first SpecGuard with an optional team server

## Prompt

I want to understand - what part of specguard can/should run on sandbox or a central server, what parts run locally? In an ideal world, a user can install specguard into claude code/desktop via hooks and mcp and vs code via extension that can use a server if exists but fall back locally if it doesn't. [Then: plan this. Make sure we include in this new plan all the unfinished work from the previous plan. Then: build.] Decisions: the server pulls CI artifacts from GitHub; auth is deploykit identity plus server-issued tokens; the VS Code extension reads data through the API while runs stay local; ship 0.2 first.

## Plan

# SpecGuard 0.3: local-first with an optional team server (plus the rest of 0.2)

## Context

SpecGuard 0.2 is built: functional capability specs, four pillars, plugins and the AI Portal migration. It sits as one unpushed commit on each feature branch:
- SpecGuard: `feat/v2-phase-0-history-and-system-spec`
- AI Portal: `specguard/functional-specs`

npm `latest` is still 0.1.2.

Wes asked which parts of SpecGuard should run centrally and which locally. The target: install SpecGuard into Claude Code (hooks plus MCP), Claude Desktop (MCP) and VS Code (extension), use a server when one exists, and fall back to local when it doesn't. He also asked that this plan carry every unfinished item from the 0.2 plan.

**Principle.** There is one engine and two hosts.
- The local CLI is always complete, whether a server exists or not.
- The server shares state, caches and slow or costly work. It is never required.
- Git stays the source of truth for specs and requirement history.
- Every client (MCP, VS Code, web UI) talks to the same `/api/v1/projects/:project/...`, served either by a local `specguard serve` or by the central server.

**Facts that shape the design** (from exploration):

*SpecGuard today*
- `serve` is one repo per process, read-only, unauthenticated and loopback-only (`src/server/index.ts`, `api.ts`).
- There is no storage abstraction: about 239 hard-coded `.specguard` paths.
- `ProofRecord` (`src/core/proof-ledger.ts:16-41`) has no origin or branch, and the claim hash (`src/core/claim-hash.ts`) is unversioned.
- LLM spend and config are process-global (`llm-runtime.ts`). Model calls carry no user metadata. The base URL can only be set through env.
- The summary cache key leaves out the model.
- The VS Code extension reads legacy `.specguard/*.json` files and parses the CLI's text output (`extension/src/dashboard/host.ts`, `sidebar.ts`, `workspace-state.ts`).

*Sandbox (deploykit)*
- No EntraID. Edge identity is deploykit's email sign-in, passed to apps as an `X-Deploykit-Email` header.
- Restricted apps block machine callers, so the API app must be public at the edge and do its own token auth. This mirrors `project-tracker-api`.
- No persistent volumes. Each app gets its own Postgres through `{{DK_DB_URL}}`.
- The app must serve under its path prefix, and the health check is prefix-aware.
- Per-user LiteLLM keys exist (`POST /api/v1/me/litellm-key`), and `http://litellm:4000` is reachable inside the network.
- GitHub-hosted runners and webhooks cannot reach the sandbox. Outbound access to GitHub is unconfirmed (it may need `https_proxy=http://proxy.plymouthrock.com:8080`).

**Decisions (Wes):**
- The server **pulls CI artifacts** from GitHub.
- Auth is **deploykit identity plus server-issued tokens**.
- The extension gets **data through the API while runs stay local**.
- **Ship 0.2 first**: its leftovers become Phase 0.

---

## Phase 0: Finish and ship 0.2 (carry-over from the previous plan)

1. **Release.**
   - Push both branches and open PRs (SpecGuard to `main`; AI Portal to its main).
   - Publish `specguard-ai@0.2.0` under the `next` dist-tag. Keep `action.yml`'s default at `latest` until AI Portal runs green on `next`, then promote it.
2. **Cut the command surface** (the old Phase 9, plus claim `integration-surfaces#…planned-surface`).
   - Delete `analyze`, `plan-fix` and `deps`, along with their pipelines, MCP tools and tests: `src/pipelines/analyze.ts`, `plan-fix.ts`, `dep-check.ts`.
   - Make `scaffold` an alias of `init --update`. Keep `status`, `drift`, `matrix` and `gap-analysis` as aliases through 0.2.x.
   - Trim the MCP server (`src/mcp/server.ts`, 35 tools today) to about 15 core tools, and register old names as deprecated aliases for one release.
   - Target size for `src`: 20–22K lines (33.7K today).
3. **Plugin extension points** (claim `planned-plugin-extensions`). Add `detectors` (fed into `security scan`) and `docRenderers` (fed into `DocService`) to `src/plugins/types.ts`. Load npm plugins only from a `{name, package}` allowlist in config.
4. **`spec import` into a capability.** It targets an existing capability and records a history entry. Change `src/pipelines/import.ts` and remove the "Planned" wording from the claim.
5. **Unit-aware security.**
   - Plan items carry a `unit` key: add an optional field to the `remediation-schema.ts` schema and fill it using `unitOfFile`.
   - Unit-local spec trees stay **deferred** and remain marked Planned in the spec.
6. **Spec hygiene.**
   - Mark claim `history-mcp-tool` as built (the tool exists at `server.ts:923`).
   - Fix the summary cache key to include the model and prompt version (`src/pipelines/spec-synth.ts:23,69`).
7. **Templates.** Run `specguard init --update` in the hub. Read the hub `CLAUDE.md` first: its SpecGuard section still lists `gap-analysis` and `analyze`.
8. **Finish AI Portal** (`apps/ai-portal`; read its `CLAUDE.md` and `AGENTS.md` first).
   - Run `test run` again with dynamodb-local up, to prove the 13 DDB-backed claims.
   - Run `verify` on the Training Learner Journey end to end against `npm run dev`.
   - Check that `GET /api/v1/docs/user/system` returns a coherent guide from the `fast` model.
   - Enable `--history-hooks`.
   - Decide on `--rewrite-source-refs` by asking Wes; it touches app source comments.
   - Pin `specguard-ai@next`.
9. **Dogfooding checks that were never run.**
   - `security scan` on SpecGuard itself produces a valid plan.
   - `serve` renders SpecGuard's user, dev and audit docs with the fast model.
   - Read-only check: does `deploykit` (with `webui/` and `sandbox/`) work as a monorepo proving ground? **Do not migrate it without asking.**

## Phase 1: Core foundations for a local-first engine

1. **State stores** (`src/core/state/`). Narrow interfaces, each with a file implementation (today's behaviour) and later a Postgres one:
   - `LedgerStore`: `read()`, `update(fn)`.
   - `PlanStore`: `list`, `read`, `update(id, fn, expectedVersion)`.
   - `ContentCache`: `get`/`put` by content key, used for docs, summaries and drift assessments.
   - `UsageSink`.

   Move to them:
   - `readLedger` and `ingestVerdicts` (`src/pipelines/proof.ts:282,325`)
   - `readPlan`, `writePlan` and `runPlanSetStatus` (`src/pipelines/security-plan.ts`)
   - `DocService` caching (`src/server/docs.ts:136`)
   - `summarizeFiles` (`spec-synth.ts:83`)
   - drift assessments

   The existing atomic `writeFile` (`src/core/writer.ts:20`) stays the file primitive. The direct `writeFileSync` calls in `drift-registry.ts` and `drift-assessments.ts` switch to it.
2. **Proof provenance.**
   - `ProofRecord` gains `origin: 'local'|'ci'|'server'`, `branch`, `repo` (slug), `commit` (alias of `repoSha`), `actor` and `hashVersion`.
   - `ProofLedger` moves to version 2. `readLedger` reads v1 as `origin: 'local'` and stops rejecting it. Ingest fills these fields from `GITHUB_*` env when it runs in CI.
   - `effectiveVerdict` is unchanged. CI gates count only `origin: 'ci'` proofs once a server is configured.
3. **Hash and engine versions.** Add a `HASH_VERSION` constant in `claim-hash.ts`, recorded on proofs. `/health` returns `{apiVersion, engineVersion, hashVersion}`. Clients refuse to mix proofs whose `hashVersion` differs.
4. **LLM per-request scope.**
   - Spend accounting moves into the existing AsyncLocalStorage (`runWithPipeline`, `llm-runtime.ts:50`), carrying `{spend, budget, user, tags}`. The `DocService.exclusive` gate is then removed.
   - Config lives per context instead of the global `configureLlm`, so one server process can serve many projects.
   - Pass `user` and tags through to LiteLLM (OpenAI-compatible `user` field and metadata) for spend attribution.
   - Add `llm.baseUrl` to the config schema (`src/core/config.ts:83`).
5. **Config and env.**
   - Add `server: { url?, project?, tokenEnv? = 'SPECGUARD_TOKEN', mode?: 'auto'|'off'|'required', timeoutMs? }` to `configSchema` and `SpecGuardConfig`. Env `SPECGUARD_SERVER` overrides it.
   - Move the `.specguard/.env` loader from `src/cli/index.ts:18-52` into `src/core/env.ts`, so the MCP server loads it too.

## Phase 2: Project-scoped API and the local server

1. **Refactor `Api`** (`src/server/api.ts`) to take a `ProjectSource`:
   - `LocalProjectSource`: config plus working tree, which is today's behaviour.
   - `SnapshotProjectSource`: published snapshot plus stores, used by the server.
2. **Canonical routes** become `/api/v1/projects/:project/...`. Today's unprefixed routes stay as aliases for the local project, so the current UI keeps working.
3. **New read routes**, needed by the extension and by agents:
   - `coverage`: per unit and per app, with spec file paths and test existence
   - `specs`: list with file paths
   - `docs` list
   - `contracts`
   - `findings`: lint from the quality plugin, and security plan items
   - `version`
   - `events`: Server-Sent Events. Locally this comes from a file watcher; centrally from snapshot arrival.
   - `activity`: local only.
4. **Write routes**, authorised in Phase 3:
   - `POST snapshots` (publish)
   - `POST proofs:ingest`
   - `PATCH security/plans/:id/items/:item` with `If-Match` against the item version, returning 409 on conflict. This builds on `runPlanSetStatus` and `canTransition`.
5. **Server plumbing.**
   - `serve` gains `--base-path`, plus `--host 0.0.0.0` for containers.
   - The UI (`src/server/ui.ts:46`) reads a base path that is injected at render time.
   - Plan reads go through `readPlan`, which closes the unvalidated `plans()` path at `api.ts:173`.
6. **`specguard publish`** builds a snapshot:
   - metadata: repo, branch, commit, engine and hash versions
   - spec files (content), system and capability graph, trace model
   - ledger rows for this commit
   - plans
   - history index (entries' frontmatter and bodies)
   - `contracts.json`

   It writes the snapshot to `--out <file>`, or POSTs it to the server. The redactor runs before anything leaves the machine. Working-tree content and inbox prompts are never included.

## Phase 3: Central server (`specguard server`)

1. **Entry point and hosting.**
   - New entry `src/server/central/`, using the same `Api` with `SnapshotProjectSource`.
   - **Postgres stores** through `DATABASE_URL`, with versioned SQL migrations in `src/server/central/migrations/`.
   - Tables: `projects`, `snapshots`, `proofs` (indexed by origin, branch and commit), `plans`/`plan_items` (version column), `content_cache`, `history_entries`, `tokens` (stored hashed), `audit_log`, `usage`.
   - New dependencies: `pg` and `fflate` (to read artifact zips).
2. **Auth middleware.**
   - A bearer token (personal, or a per-project CI/service token with scopes) takes precedence. Otherwise `X-Deploykit-Email` identifies a browser user.
   - Roles: `viewer`, `maintainer` (per project) and `admin` (`ADMIN_EMAILS` env).
   - Browser writes need the same origin plus a custom header (CSRF protection).
   - The token page `/tokens` lets a signed-in user mint, list and revoke tokens. `specguard login --server <url>` opens it and stores the token in `~/.config/specguard/credentials.json` (mode 0600).
   - **Known risk to document:** other containers on `deploykit-net` can forge `X-Deploykit-Email`, so the server must not trust that header for admin actions. Admin actions require a token. Propose a deploykit follow-up for a signed identity header, without changing deploykit in this plan.
3. **GitHub artifact puller.**
   - An in-process loop per project polls the GitHub Actions API for completed runs that carry the `specguard-evidence` artifact.
   - It downloads and unzips the artifact and imports `.specguard/publish/snapshot.json` and the ledger with `origin: 'ci'`, the run's `head_sha` and `head_branch`. Runs are de-duplicated by run id.
   - Env: `GITHUB_TOKEN` (fine-grained, `actions:read`) and `https_proxy`.
   - **Verify outbound access to GitHub from an app container first.** If it is blocked, the push API with an internal runner is the fallback; that is already built in Phase 2.
4. **Action changes** (`action.yml`, `action/run-gates.mjs`).
   - Add a `publish` gate that runs `specguard publish --out .specguard/publish/snapshot.json` before the upload step.
   - Add optional `server-url` and `server-token` inputs for a direct push from runners that can reach the server.
5. **Docs on the server.** `DocService` uses `ContentCache` from Postgres, so each spec/audience/prompt/model combination is generated once for the whole team. Model calls go through `http://litellm:4000` with the server's key, `user` set to the requester's email, and per-request budgets.
6. **Remote MCP.**
   - Streamable-HTTP MCP at `/mcp` with token auth and read-only tools: system, capabilities, trace, docs, history search, plans.
   - Claude Desktop on the internal network connects to it directly. claude.ai cannot reach the internal sandbox; document that.
7. **Deploy to the sandbox.**
   - Add `deploy/sandbox/Dockerfile` (node:20-alpine, multi-stage, like `project-tracker/backend/Dockerfile`).
   - Add `.deploykit/apps.json` in the SpecGuard repo:
     - id `specguard`, port 4317, prefix `/specguard`, health `/specguard/api/v1/health`
     - `env_vars`: `DATABASE_URL={{DK_DB_URL}}`, LiteLLM URL and key, `GITHUB_TOKEN`, `https_proxy`, `ADMIN_EMAILS`
     - visibility public (the server does its own auth)
   - Deploy through the deploykit skill or MCP only after asking.

## Phase 4: Local clients use the server with fallback

1. **`src/client/`.**
   - `resolveServer(config)`: config or env, then a health probe (default 800 ms timeout, cached for the process), then a version check.
   - `SpecGuardClient`: typed fetch with token and timeout.
2. **Fallback policy**, tested as a table:
   - **Reads** (check, team proofs, docs, plans, impact): use the server, else local, silently. `--json` output carries `source: 'server'|'local'`.
   - **Shared writes** (plan status, external refs): go to the server; without one, write locally and warn `[local-only]`.
   - **`mode: 'required'`**, used in CI: an unreachable server is an error.
   - **CI gates** never use a local ledger when a server is configured.
3. **CLI.**
   - `check --team`, and `proof status` show CI proofs next to local ones.
   - `security plan set-status` writes through the server.
   - `impact` and `contracts` use the server's cross-repo view when the local workspace lacks the sibling repos.
4. **Local MCP** (`src/mcp/server.ts`).
   - Load env through the new loader.
   - The shared-state tools (`proof_status`, `security_plan`, `check` team view, `impact`) go through the client with fallback.
   - Working-tree tools stay local.
5. **Hooks are unchanged and stay local and silent.** `history inbox` never contacts the server.

## Phase 5: VS Code extension uses the API

1. **Connection.**
   - New `extension/src/api/client.ts`.
   - New `extension/src/api/local-server.ts`: spawns the bundled `dist/cli.js serve --port 0` and reads `specguard serving <url>` from stdout. One process per workspace, disposed on deactivate.
   - New settings: `specguard.serverUrl` and `specguard.serverMode`. The token lives in VS Code SecretStorage, set by a "SpecGuard: Sign in to server" command.
2. **Views moved to the API.**
   - Replace the direct reads in `host.ts`, `sidebar.ts`, `coverage-parse.ts` and `workspace-state.ts`:
     - coverage tree and status bar
     - specs, docs, matrix (now the claim and capability trace)
     - workspace and contracts
     - findings and security plans
   - Live updates use the `events` SSE route, replacing the extension's file watchers wherever the server supplies the same events.
3. **Runs stay local.** Runs keep spawning the local CLI, with the pipeline list updated to `check`, `spec draft/tag`, `test run`, `verify`, `security scan` and `history add`. The LLM and `.env` settings editor stays a local file edit.
4. **Removed views.** Drop the analyze recommendations, fix-plan and `.specguard/plans/*.md` views; their commands are deleted in Phase 0. Retire the legacy `.specguard/*.json` view writers in 0.3.
5. **Version gate.** Warn when `engineVersion` differs from what the extension expects.

## Phase 6: Agentic verification on the server (optional, last)

- `POST /projects/:p/verify-runs` (maintainers only) runs `verify` in a Playwright-capable worker image against a deployed sandbox app, and records `origin: 'server', evidence: 'agentic'` proofs.
- Triggered manually or by a client after deploykit's `watch_deploy` reports done.
- Open question for Wes before building: deployed apps sit behind email OTP. Testing them means either a service identity from deploykit or going straight to the container (`dk-<id>:<port>`) with an injected identity header.

## Specs and history (SpecGuard governs itself)

- Record this conversation and plan as `specs/history/2026-10-15-local-first-team-server.md`.
- Add a capability `specs/capabilities/team-server.md` covering the server, auth, puller, publish, remote MCP and fallback.
- Update the claims in:
  - `conformance-testing`: proof origin
  - `security-and-remediation`: plan write API and unit key
  - `documentation-api`: project routes and SSE
  - `integration-surfaces`: MCP trim, client fallback, extension
  - `workspaces`: server cross-repo view
- Run `specguard check`, `drift` and `test run` after each phase.

## Critical files

**SpecGuard core and server**
- `src/server/{api,index,docs,ui}.ts`
- new `src/server/central/`, `src/client/`, `src/core/state/`, `src/core/env.ts`
- `src/core/{proof-ledger,claim-hash,llm,llm-runtime,config,types}.ts`
- `src/pipelines/{proof,results,security-plan,security-scan,spec-synth,import}.ts`
- `src/mcp/server.ts`, `src/cli/index.ts`

**CI and deploy**
- `action.yml`, `action/run-gates.mjs`, `deploy/sandbox/Dockerfile`, `.deploykit/apps.json`

**Extension**
- `extension/src/{dashboard/host.ts,sidebar.ts,workspace-state.ts,dashboard/coverage-parse.ts}`, `extension/package.json`

## Verification

- **Unit tests:**
  - file and Postgres stores against one shared contract suite (Postgres through a test container or `pg-mem`)
  - ledger v1 to v2 read, and the `hashVersion` mismatch refusal
  - per-request LLM spend under concurrency
  - client fallback table: server up, down, version mismatch and `mode: 'required'`
  - auth: token scopes, role checks, header-only identity refused for admin actions, CSRF rule
  - plan `If-Match` conflict returns 409
  - puller against recorded GitHub API fixtures and a sample artifact zip
  - `publish` redaction, and that no working-tree content leaves
  - remote MCP tool listing
  - extension API client and local-server spawn (vitest)
- **Local end to end:**
  1. Postgres in Docker, then `specguard server`.
  2. `specguard publish` from SpecGuard and AI Portal.
  3. `check --team` shows `source: server`.
  4. Stop the server: the same command falls back with `source: local`.
  5. VS Code pointed at the server, then with the setting removed (local spawn).
- **Sandbox:**
  1. Confirm outbound GitHub access from a container.
  2. Deploy `specguard` (after asking) and sign in through deploykit to mint a token.
  3. Run the Action on SpecGuard's repo. The puller imports the run, and proofs show `origin: ci` with the run's commit.
  4. Fetch `/specguard/api/v1/projects/specguard/docs/user/system` twice: the second fetch hits the cache, with spend attributed in LiteLLM.
  5. Claude Desktop connects to `/specguard/mcp`.
- **Phase 0:**
  - `npm test`, lint and tsc pass.
  - `npx specguard-ai@next --version` reports 0.2.0.
  - The AI Portal acceptance checks from the old plan (DDB proofs, Playwright journey, docs guide) pass.
