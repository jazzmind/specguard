---
id: team-server
kind: capability
title: Local-first operation with an optional team server
parent: system
value: SpecGuard works fully on one machine, and when a team server exists it also gives everyone shared proof from CI, shared documents and shared plans, without anyone depending on it.
status: active
sources:
  - "src/core/snapshot.ts"
  - "src/pipelines/publish.ts"
  - "src/pipelines/team.ts"
  - "src/cli/commands/publish.ts"
  - "src/cli/commands/server.ts"
  - "src/cli/commands/login.ts"
  - "src/client/**"
  - "src/server/project.ts"
  - "src/server/central/**"
  - "extension/src/api/**"
tests:
  - "tests/pipelines/publish.test.ts"
  - "tests/pipelines/team.test.ts"
  - "tests/server/projects.test.ts"
  - "tests/server/ui.test.ts"
  - "tests/server/central.test.ts"
  - "tests/server/hardening.test.ts"
  - "tests/server/backend-contract.test.ts"
  - "tests/server/puller.test.ts"
  - "tests/client/*.test.ts"
  - "extension/src/api/*.test.ts"
docs:
  - "docs/team-server.md"
history:
  - 2026-10-29-app-manager-role-mapping
  - 2026-10-29-project-onboarding
  - 2026-10-15-local-first-specguard-with-an-optional-t
  - 2026-10-22-0-3-phase-1f-workspaces-on-the-team-serv
  - 2026-10-22-intent-catch-up-for-the-2026-10-19-chang
  - 2026-10-22-security-hardening-from-audit-sast-and-p
  - 2026-10-22-header-role-fix-and-spec-level-security
---

# Local-first operation with an optional team server

## Problem & Value
A tool that checks code against its specs is most useful when everyone sees the same answer. A developer's laptop knows their working tree and nothing else. CI knows what was pushed, but its results vanish with the build. Auditors, product owners and reviewers have no checkout at all. Putting everything on a server would make SpecGuard useless on a plane, in a fresh clone, or the moment the server is down; keeping everything local leaves the team without a shared record of what is proven, what is stale, and which security findings are being worked.

This capability keeps one engine and gives it two homes. The local command line is always complete. A team server is optional: it holds what CI publishes, serves the same API the local `serve` does, shares generated documents and remediation plans, and attributes model spend to the person who asked. Every client (the command line, the MCP server, the VS Code extension, the web UI) talks to the same project-scoped API, and uses the server when it answers and local files when it does not. Git remains the source of truth for specs and requirement history; the server only indexes and aggregates them.

## Users & Journeys
- A developer runs `specguard check` and sees the team's CI proofs next to their own local ones, and keeps working unchanged when the server is unreachable.
- CI runs `specguard publish` after the tests, so the server shows the proof state of the commit that was pushed.
- A security lead reads the open findings from the server, and a tracker marks items in progress or fixed through the API without overwriting anyone else's change.
- An auditor or product owner with no checkout reads the system guide, capability docs and traceability from the server's web UI.

## Requirements
- [ ] With an explicitly configured app-role header and a trusted proxy that overwrites it, a verified DeployKit app manager maps to a SpecGuard maintainer, never an admin. An absent opt-in, untrusted peer, unknown role, wrong domain or invalid bearer token cannot gain permission from that header. <!-- claim: app-manager-role-mapping -->
- [ ] With no project selected, the team server shows the accessible project directory and an empty-state creation flow; maintainers can create persistent projects before first publish on either backend. Project-scoped credentials see only their project and cannot create projects. Tokens remain accessible without project data and default to the selected project. The extension opens browser onboarding independently of its connection, accepts a verified token, then lets the user select or create a project and securely saves the token and repo connection. <!-- claim: project-onboarding -->
- [ ] `specguard publish` writes one snapshot file holding the spec and history markdown, the trace model, the proof rows, the newest remediation plan and the contract graph, tagged with the project name, repository, branch, commit, origin and engine and hash versions; it never includes source code, working-tree files outside the spec tree, or prompts that were not committed as history, and it redacts credentials from every file; with `--push` or `--server` it also sends the snapshot to the project's team server, and a refusal or an unreachable server fails the command while the file is still written <!-- claim: publish-snapshot -->
- [ ] A snapshot is validated before it is written or accepted: the project name is a safe identifier, every file is a markdown file inside the spec tree (no absolute paths, `..` or backslashes), the trace model has its required shape, an unknown version is refused, and anything over the size limit is refused <!-- claim: snapshot-validation -->
- [ ] The API serves every project under `/api/v1/projects/:project/...`, lists projects at `/api/v1/projects`, and on a server with one project also serves the same routes without the prefix; a server with several projects answers an unprefixed route with a pointer to the prefixed form; besides the existing routes it serves specs with their file (and one spec's markdown), coverage per capability and unit, the document list, the contract graph and unresolved findings, and the web UI works under a path prefix and across projects <!-- claim: project-scoped-api -->
- [ ] The API reports `apiVersion`, `engineVersion`, `hashVersion` and whether it accepts writes on `/health` and `/version`, so a client can refuse to mix incompatible data <!-- claim: version-handshake -->
- [ ] A registry that is not writable (the local `serve`) answers every write with 405; on a writable one a plan item is changed with `PATCH` by a signed-in maintainer, the change is attributed to them, a stale `If-Match` version is refused with 409 and writes nothing, and a lifecycle violation is refused with 422 <!-- claim: guarded-writes -->
- [ ] A team server keeps its state behind one backend interface (snapshots, plans per project, a document cache per project, tokens, an audit trail and model usage), implemented for files and for Postgres and held to the same contract tests; a project is shown from its newest snapshot on the default branch, else its newest overall; concurrent edits to plans lose nothing, with Postgres using a revision check and retry instead of row locks <!-- claim: team-server-storage -->
- [ ] Every route except `/health` needs a credential: a token (a person's, a project's CI token, or the operator's bootstrap token) or, for browsers, the sandbox's signed-in user header, which reads and mints a person's own tokens but never grants an administrative power; a bad token is refused even when the header is present; a project-scoped credential reaches only its project; nobody mints a token more powerful than their own, admin tokens come only from the admin route; tokens are stored as hashes, shown once, revocable by their owner, and audited; changes made from a browser session need the `X-Requested-With` header <!-- claim: team-server-auth -->
- [ ] A project's CI token or a maintainer publishes a snapshot over HTTP, creating the project on first publish; the snapshot's plan is merged with the stored one, so statuses and tracker references that people set on the server survive a republish, an item marked fixed that a scan sees again reopens, and unresolved items the new plan lacks are kept unless that plan was made from the stored one <!-- claim: team-server-publish -->
- [ ] Documents on a team server are generated once per spec content, audience, prompt version and model and shared by everyone, and each generation runs in its own model scope with the requester's name, the project and the gateway's labels, so spend is attributed to the person who asked and recorded per user and project <!-- claim: team-server-docs -->
- [ ] The server fetches the `specguard-evidence` artifacts CI uploaded for each configured repository on a timer, publishes the snapshot inside under the configured project with the commit and branch taken from the workflow run, skips what it already has and artifacts that are expired, oversized, invalid or from forks, and reports one repository's failure without stopping the others <!-- claim: artifact-puller -->
- [ ] The server answers MCP over HTTP at `/mcp` for token holders only, as read-only tools (projects, system, capability, spec, audit, coverage, docs, history, findings, plans) that go through the same API as the same identity, so access rules, project scoping and redaction are the API's <!-- claim: remote-mcp -->
- [ ] Commands that can use a server resolve it from config or the environment, check its health with a short timeout and a compatible API version, and otherwise behave locally: reads fall back silently and say which source they used; a shared write goes to the server or, with none, is written locally and marked local-only; a server that answers but refuses (bad token, no permission, lifecycle violation) is an error and never a quiet switch to local; `server.mode: required` makes an unreachable server an error and `off` never contacts it; `check --team`, the plan commands, the MCP plan tool and the VS Code extension all follow this, and a token saved by `login` is checked against the server before it is kept <!-- claim: local-first-fallback -->
- [ ] When `SPECGUARD_TRUSTED_PROXIES` lists addresses (exact, or IPv4 CIDR ranges) the sign-in header is honoured only from a connection that comes from one of them, so a container that reaches the server directly cannot sign in as anyone or become a maintainer by naming one; a token works from anywhere; the server warns at startup when it is not set <!-- claim: trusted-proxies -->
- [ ] The sign-in header never makes a maintainer on its own: without `SPECGUARD_TRUSTED_PROXIES` it signs in a read-only viewer whoever it names (it can read and mint viewer tokens, and cannot write, change plan items, define a workspace or mint a maintainer token), and only through a trusted proxy does naming a listed maintainer email or carrying an explicitly configured, proxy-verified app-manager role make the session a maintainer; it is never an admin <!-- claim: header-is-viewer-without-proxy -->
- [ ] Each caller (the signed-in user, or the connecting address when there is no credential) is limited to a number of API requests a minute (600 for a signed-in caller, 60 with no credential), and the routes that can start a model call to fewer (30 a minute for `/docs/`); a caller over a limit gets `429` with `Retry-After`, a refused request is not counted, health is never limited, and the limits are set with `SPECGUARD_RATE_LIMIT_PER_MIN`, `_DOCS_PER_MIN` and `_ANON_PER_MIN` <!-- claim: server-rate-limits -->
- [ ] The server keeps an audit trail of what changes through its API (token creation and revocation, plan item status changes, workspace definitions, published snapshots) with who did it, and of every refused attempt to change something (no credential, or a role too low) with the reason; reads are not recorded <!-- claim: server-audit-trail -->

## Scenarios
### Scenario 1: CI publishes a commit
**Steps:**
1. CI runs the tests and ingests the results.
2. CI runs `specguard publish`.

**Expected Results:**
- One snapshot file exists with the spec files, trace, proofs and plan.
- The file contains no source code and no credential values.

### Scenario 2: Two people update a finding at once
**Steps:**
1. Two trackers read the same plan item at version 2.
2. Both send a status change with `If-Match: 2`.

**Expected Results:**
- The first succeeds and the item moves to version 3.
- The second receives 409 and the item keeps the first change.

## Security & Data Considerations
Only specs, history entries, trace data, proof rows and plans leave a machine, and only when `publish` runs. Source code and uncommitted prompts never do. Credentials are redacted from every file before the snapshot is written, and again from every response the API serves. Writes require a signed-in maintainer; the user recorded on a change is the authenticated one, never a name sent in the request body.

## Interfaces
- CLI: `specguard publish [--out <file>] [--project <name>] [--push] [--server <url>] [--token <t>]`, `specguard server [--port] [--host] [--base-path] [--data-dir]`, `specguard login|logout [--server <url>] [--token <t>]`, `specguard check --team`.
- Server: `/mcp` (MCP over HTTP, token only), `POST /api/v1/projects/:project/snapshots`, `GET|POST|DELETE /api/v1/tokens`, `POST /api/v1/admin/tokens`.
- API: `GET /api/v1/projects`, `GET /api/v1/projects/:project/{system,capabilities,specs,specs/:id,coverage,trace,audit,units,contracts,findings,docs,security/plans}`, `PATCH /api/v1/projects/:project/security/plans/:plan/items/:item`.
- Config: `server: { url, project, tokenEnv, mode, timeoutMs }`.
- Files: `.specguard/publish/snapshot.json`.

## Out of Scope
- Running tests on the server: tests need the project's own environment, so CI runs them and publishes the result.
- Holding anyone's working tree: the server reads only published snapshots.
- Not built yet: live change notifications (clients poll or watch files), reading the cross-repo contract graph from the server when sibling repos are not checked out (`impact` and `contracts` still read local files), and running `verify` on the server against deployed apps (deployed sandbox apps sit behind email sign-in, so it needs a service identity first).
