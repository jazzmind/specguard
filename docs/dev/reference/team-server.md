---
title: "Local-first operation with an optional team server (developer reference)"
audience: dev
source: "specs/capabilities/team-server.md"
generated: true
---
<a id="local-first-operation-with-an-optional-team-server"></a>
# Local-first operation with an optional team server

<a id="purpose"></a>
## Purpose

SpecGuard works fully on one machine. When a team server exists, it also gives everyone shared proof from CI, shared documents and shared plans, and nobody depends on it.

A laptop knows only its own working tree. CI results vanish with the build. Auditors, product owners and reviewers have no checkout. Putting everything on a server would make SpecGuard useless offline, in a fresh clone, or during an outage. Keeping everything local leaves the team without a shared record of what is proven, what is stale and which security findings are being worked.

This capability keeps one engine and gives it two homes:

- **Local command line:** always complete.
- **Team server:** optional. It holds what CI publishes, serves the same API as local `serve`, shares generated documents and remediation plans, and attributes model spend to the person who asked.

Every client (CLI, MCP server, VS Code extension, web UI) talks to the same project-scoped API. Clients use the server when it answers and local files when it does not. Git remains the source of truth for specs and requirement history. The server only indexes and aggregates them.

Typical journeys:

- A developer runs `specguard check` and sees CI proofs next to local ones, and keeps working if the server is unreachable.
- CI runs `specguard publish` after the tests, so the server shows the proof state of the pushed commit.
- A security lead reads open findings from the server. A tracker marks items in progress or fixed through the API without overwriting anyone else's change.
- An auditor or product owner with no checkout reads the system guide, capability docs and traceability in the web UI.

<a id="responsibilities"></a>
## Responsibilities

- Build, validate and write a publish snapshot, and optionally push it to a team server.
- Serve a project-scoped API (locally read-only, on a team server writable), including version handshake and guarded writes.
- Store team-server state behind one backend interface (files or Postgres).
- Authenticate and authorise callers: tokens, the proxy sign-in header, roles, rate limits, audit trail.
- Merge published plans with stored ones so human-set state survives republishing.
- Generate shared documents once per content and attribute model spend to the requester.
- Pull CI evidence artifacts on a timer.
- Accept, store, retain and safely serve test-run evidence.
- Expose read-only MCP over HTTP.
- Let clients fall back to local files when the server is absent, without hiding refusals.

Out of scope:

- Running tests on the server. CI runs them and publishes the result.
- Holding anyone's working tree. The server reads only published snapshots.
- Not built yet:
  - live change notifications (clients poll or watch files);
  - reading the cross-repo contract graph from the server when sibling repos are not checked out (`impact` and `contracts` still read local files);
  - running `verify` on the server against deployed apps (this needs a service identity first, because deployed sandbox apps sit behind email sign-in).

<a id="interfaces"></a>
## Interfaces

**CLI**
- `specguard publish [--out <file>] [--project <name>] [--push] [--server <url>] [--token <t>]`
- `specguard server [--port] [--host] [--base-path] [--data-dir]`
- `specguard login|logout [--server <url>] [--token <t>]`
- `specguard check --team`

**Server**
- `/mcp` (MCP over HTTP, token only)
- `POST /api/v1/projects/:project/snapshots`
- `GET|POST|DELETE /api/v1/tokens`
- `POST /api/v1/admin/tokens`

**API**
- `GET /api/v1/projects`
- `GET /api/v1/projects/:project/{system,capabilities,specs,specs/:id,coverage,trace,audit,units,contracts,findings,docs,security/plans}`
- `PATCH /api/v1/projects/:project/security/plans/:plan/items/:item`
- `GET /api/v1/projects/:project/publish-state`
- `/health` and `/version`

**Config:** `server: { url, project, tokenEnv, mode, timeoutMs }`

**Environment:** `SPECGUARD_TRUSTED_PROXIES`, `SPECGUARD_RATE_LIMIT_PER_MIN`, `SPECGUARD_RATE_LIMIT_DOCS_PER_MIN`, `SPECGUARD_RATE_LIMIT_ANON_PER_MIN`. The spec names the last two as `_DOCS_PER_MIN` and `_ANON_PER_MIN`.

**Files:** `.specguard/publish/snapshot.json`

<a id="requirements"></a>
## Requirements

<a id="identity-roles-and-access"></a>
### Identity, roles and access

- **app-manager-role-mapping**: With an explicitly configured app-role header and a trusted proxy that overwrites it, a verified DeployKit app manager maps to a SpecGuard maintainer, never an admin. An absent opt-in, untrusted peer, unknown role, wrong domain or invalid bearer token cannot gain permission from that header.
- **team-server-auth**:
  - Every route except `/health` needs a credential: a token (a person's, a project's CI token, or the operator's bootstrap token) or, for browsers, the sandbox's signed-in user header.
  - The header reads and mints a person's own tokens but never grants an administrative power.
  - A bad token is refused even when the header is present.
  - A project-scoped credential reaches only its project.
  - Nobody mints a token more powerful than their own, and admin tokens come only from the admin route.
  - Tokens are stored as hashes, shown once, revocable by their owner, and audited.
  - Changes made from a browser session need the `X-Requested-With` header.
  - A refusal because the sign-in header was missing, from an untrusted address or outside the allowed domain says which, and the web UI shows that text.
- **trusted-proxies**:
  - When `SPECGUARD_TRUSTED_PROXIES` lists addresses (exact, or IPv4 CIDR ranges), the sign-in header is honoured only from a connection that comes from one of them.
  - An entry may be a host name, re-resolved every 30 seconds so a proxy that restarts with a new address stays trusted.
  - A container that reaches the server directly therefore cannot sign in as anyone or become a maintainer by naming one.
  - A token works from anywhere.
  - The server warns at startup when the variable is not set.
- **header-is-viewer-without-proxy**:
  - The sign-in header never makes a maintainer on its own.
  - Without `SPECGUARD_TRUSTED_PROXIES` it signs in a read-only viewer whoever it names. That viewer can read and mint viewer tokens, and cannot write, change plan items, define a workspace or mint a maintainer token.
  - Only through a trusted proxy does naming a listed maintainer email, or carrying an explicitly configured, proxy-verified app-manager role, make the session a maintainer.
  - It is never an admin.
- **server-rate-limits**:
  - Each caller (the signed-in user, or the connecting address when there is no credential) is limited per minute: 600 for a signed-in caller, 60 with no credential.
  - Routes that can start a model call have lower limits: 30 a minute for `/docs/`.
  - A caller over a limit gets `429` with `Retry-After`. A refused request is not counted, and health is never limited.
  - The limits are set with `SPECGUARD_RATE_LIMIT_PER_MIN`, `_DOCS_PER_MIN` and `_ANON_PER_MIN`.
- **server-audit-trail**: The server records what changes through its API, with who did it: token creation and revocation, plan item status changes, workspace definitions and published snapshots. It also records every refused attempt to change something (no credential, or a role too low) with the reason. Reads are not recorded.

<a id="projects-and-api"></a>
### Projects and API

- **project-onboarding**:
  - With no project selected, the team server shows the accessible project directory and an empty-state creation flow.
  - Maintainers can create persistent projects before first publish on either backend.
  - Project-scoped credentials see only their project and cannot create projects.
  - Tokens remain accessible without project data and default to the selected project.
  - The extension opens browser onboarding independently of its connection, accepts a verified token, then lets the user select or create a project and securely saves the token and repo connection.
  - The address and project come from the extension's own settings on every read (no cache), so a change shows at once.
  - The sidebar's Team server row opens the server. Each repo row has an action that opens that repo's project page on it (`?project=<name>`), and a command does the same for the active repo.
- **project-scoped-api**:
  - The API serves every project under `/api/v1/projects/:project/...` and lists projects at `/api/v1/projects`.
  - On a server with one project it also serves the same routes without the prefix. A server with several projects answers an unprefixed route with a pointer to the prefixed form.
  - Besides the existing routes it serves specs with their file (and one spec's markdown), coverage per capability and unit, the document list, the contract graph and unresolved findings.
  - The web UI works under a path prefix and across projects.
- **version-handshake**: The API reports `apiVersion`, `engineVersion`, `hashVersion` and whether it accepts writes on `/health` and `/version`, so a client can refuse to mix incompatible data.
- **guarded-writes**:
  - A registry that is not writable (the local `serve`) answers every write with 405.
  - On a writable one, a plan item is changed with `PATCH` by a signed-in maintainer, and the change is attributed to them.
  - A stale `If-Match` version is refused with 409 and writes nothing.
  - A lifecycle violation is refused with 422.
- **remote-mcp**: The server answers MCP over HTTP at `/mcp` for token holders only, as read-only tools (projects, system, capability, spec, audit, coverage, docs, history, findings, plans). They go through the same API as the same identity, so access rules, project scoping and redaction are the API's.

<a id="snapshots-and-publishing"></a>
### Snapshots and publishing

- **publish-snapshot**:
  - `specguard publish` writes one snapshot file holding the spec and history markdown, the trace model, the proof rows, the newest remediation plan and the contract graph.
  - The file is tagged with the project name, repository, branch, commit, origin, and engine and hash versions.
  - It never includes source code, working-tree files outside the spec tree, or prompts that were not committed as history, and it redacts credentials from every file.
  - With `--push` or `--server` it also sends the snapshot to the project's team server. A refusal or an unreachable server fails the command, while the file is still written.
- **snapshot-validation**: A snapshot is validated before it is written or accepted:
  - the project name is a safe identifier;
  - every file is a markdown file inside the spec tree (no absolute paths, `..` or backslashes);
  - the trace model has its required shape;
  - an unknown version is refused;
  - anything over the size limit is refused.
- **publish-digest-check**:
  - A snapshot has a digest (`snapshotDigest`): a hash per section (specs, trace, proof rows, plans, contracts) and per spec file.
  - The digest ignores `createdAt`, `engineVersion`, `trace.generated` and the commit.
  - Two snapshots with the same content have the same `total`, and a change to one section changes only that section's hash.
  - The server computes the digest itself on every put and returns it, computing it on demand for snapshots stored before digests existed.
- **publish-state-check**:
  - `publish --check` builds the snapshot in memory and compares its digest with the server's latest (`GET /projects/:p/publish-state`). It uploads nothing.
  - It prints a `specguard-publish-check/1` result with `needsPublish`, the reasons, and the added, removed and modified spec files.
  - The reasons are: never published, specs, trace, proofs, plans, contracts changed, a newer run, incomplete evidence.
  - It exits 0 when up to date and 9 when a publish is needed.
  - Against a server without `publish-state` it falls back to comparing commits and says `exact: false`.
- **team-server-publish**:
  - A project's CI token or a maintainer publishes a snapshot over HTTP, creating the project on first publish.
  - The snapshot's plan is merged with the stored one, so statuses and tracker references that people set on the server survive a republish.
  - An item marked fixed that a scan sees again reopens.
  - Unresolved items the new plan lacks are kept, unless that plan was made from the stored one.
- **artifact-puller**:
  - The server fetches the `specguard-evidence` artifacts CI uploaded for each configured repository on a timer.
  - It publishes the snapshot inside under the configured project, with the commit and branch taken from the workflow run.
  - It skips what it already has, and artifacts that are expired, oversized, invalid or from forks.
  - It reports one repository's failure without stopping the others.
- **publish-back-compat**: Snapshot version and payload are unchanged, and an older server ignores the extra fields. A client that finds a server without the new routes degrades as the checks above describe.

<a id="storage-and-documents"></a>
### Storage and documents

- **team-server-storage**:
  - A team server keeps its state behind one backend interface: snapshots, plans per project, a document cache per project, tokens, an audit trail and model usage.
  - The interface is implemented for files and for Postgres, and both are held to the same contract tests.
  - A project is shown from its newest snapshot on the default branch, else its newest overall.
  - Concurrent edits to plans lose nothing. Postgres uses a revision check and retry instead of row locks.
- **team-server-docs**: Documents are generated once per spec content, audience, prompt version and model, and shared by everyone. Each generation runs in its own model scope with the requester's name, the project and the gateway's labels, so spend is attributed to the person who asked and recorded per user and project.

<a id="evidence"></a>
### Evidence

- **evidence-upload-protocol**:
  - `publish --push --evidence` sends the newest run (or `--run`) as a manifest of the report data plus evidence files.
  - The server answers which sha256 blobs it lacks. The client uploads only those, in chunks of at most the server's `chunkBytes`, resuming from the server's offset after an interruption.
  - The run is committed only when every blob is verified.
  - A run whose missing bytes exceed `--max-evidence-mb` stops before uploading.
  - A file over the server's per-file cap also stops before uploading, unless `--skip-oversized` is given, which records it as omitted.
  - A server without the `evidence` feature gets the snapshot and then a clear upgrade error.
- **evidence-limits-and-retention**:
  - The server verifies each uploaded blob's sha256 and discards a partial upload whose hash does not match.
  - It refuses chunks, files and runs over its caps with a structured error.
  - It keeps the last `keepRuns` runs per project (default 5). It deletes blobs no kept run refers to, and partial uploads older than a day.
  - Blobs are scoped to the project so one project cannot learn what another holds.
- **evidence-serving-safety**:
  - Reports and evidence are served only to callers allowed to read the project.
  - The HTML is rendered from the stored report data by the same renderers the CLI uses.
  - Evidence is looked up by manifest path and never joined to a filesystem path.
  - Images and video are inline. Traces and every other type download as attachments.
  - Every blob response carries `nosniff` and a sandboxing content-security-policy, and byte ranges are honoured.
- **server-test-report**: The web UI lists a project's published runs with their totals and opens the report of a run, and a workspace's rollup report, from the same pages the CLI writes. Links to local files are never sent to the server.
- **evidence-backend-storage**: Evidence blobs are stored through the backend interface. The file backend keeps them as files. The Postgres backend keeps them as chunked rows, so a database-only deployment needs no volume. Both pass the same contract tests (append, finalize with hash verification, range read, garbage collection).

<a id="client-behaviour"></a>
### Client behaviour

- **local-first-fallback**:
  - Commands that can use a server resolve it from config or the environment, check its health with a short timeout and a compatible API version, and otherwise behave locally.
  - Reads fall back silently and say which source they used.
  - A shared write goes to the server or, with none, is written locally and marked local-only.
  - A server that answers but refuses (bad token, no permission, lifecycle violation) is an error and never a quiet switch to local.
  - `server.mode: required` makes an unreachable server an error, and `off` never contacts it.
  - `check --team`, the plan commands, the MCP plan tool and the VS Code extension all follow this.
  - A token saved by `login` is checked against the server before it is kept.

<a id="code-map"></a>
## Code map

Sources:
- `src/core/snapshot.ts`, `src/core/publish-contract.ts`
- `src/pipelines/publish-evidence.ts`, `workspace-publish.ts`, `publish.ts`, `team.ts`
- `src/cli/commands/publish.ts`, `server.ts`, `login.ts`
- `src/client/**`
- `src/server/project.ts`, `src/server/central/**`
- `extension/src/api/**`

Owned files: 35.

<a id="tests"></a>
## Tests

- Pipelines: `tests/pipelines/publish.test.ts`, `team.test.ts`, `publish-check.test.ts`, `publish-evidence.test.ts`
- Core: `tests/core/snapshot-digest.test.ts`
- Server: `tests/server/evidence.test.ts`, `evidence-e2e.test.ts`, `projects.test.ts`, `ui.test.ts`, `central.test.ts`, `hardening.test.ts`, `backend-contract.test.ts`, `puller.test.ts`
- Client: `tests/client/*.test.ts`
- Extension: `extension/src/api/*.test.ts`

Scenarios the spec expects to hold:

- **CI publishes a commit.** After CI runs the tests, ingests the results and runs `specguard publish`:
  - one snapshot file exists with the spec files, trace, proofs and plan;
  - the file contains no source code and no credential values.
- **Two people update a finding at once.** Two trackers read the same plan item at version 2 and both send a status change with `If-Match: 2`:
  - the first succeeds and the item moves to version 3;
  - the second receives 409 and the item keeps the first change.

<a id="security-and-data"></a>
## Security and data

- Only specs, history entries, trace data, proof rows and plans leave a machine, and only when `publish` runs. Source code and uncommitted prompts never do.
- Credentials are redacted from every file before the snapshot is written, and again from every response the API serves.
- Writes require a signed-in maintainer. The user recorded on a change is the authenticated one, never a name sent in the request body.
- The sign-in header is trusted only from configured proxies, and never confers admin. See **trusted-proxies** and **header-is-viewer-without-proxy**.
- Tokens are stored as hashes. Evidence is scoped per project and served with `nosniff` and a sandboxing content-security-policy.

<a id="extending-it"></a>
## Extending it

The spec defines these constraints; it does not describe extension procedures beyond them.

- **Storage:** new persistent state belongs behind the single backend interface. Implement it for both the file and Postgres backends and hold both to the shared contract tests (`tests/server/backend-contract.test.ts`). Concurrent plan edits must not lose data, and Postgres uses a revision check and retry rather than row locks.
- **API routes:** serve them under `/api/v1/projects/:project/...`, with the unprefixed form on a single-project server. Every route except `/health` needs a credential, and project-scoped credentials must stay confined to their project.
- **Writes:** a non-writable registry answers 405. On a writable one, a write must be attributed to the authenticated maintainer, audited (including refusals), and, for plan items, honour `If-Match` (409) and lifecycle rules (422).
- **Snapshots:** keep the snapshot version and payload unchanged so older servers ignore extra fields (**publish-back-compat**). Any new section should be considered for `snapshotDigest`, which must keep ignoring `createdAt`, `engineVersion`, `trace.generated` and the commit.
- **Clients:** follow **local-first-fallback**. Reads fall back silently and name the source, and a refusal is never a silent switch to local. New server features must degrade clearly against a server that lacks them, as `publish --check` and `--evidence` do.
- **MCP tools:** remote MCP tools stay read-only and go through the same API as the caller's identity, so they inherit its access rules, scoping and redaction.
- **Model calls:** a new route that can start a model call needs a lower rate limit than the general one, and its spend must be attributed to the requester and project.
- **Deferred work:** the items listed under Responsibilities as not built yet are open extension points, with the `verify`-on-server item blocked on a service identity.
