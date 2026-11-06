---
id: team-collaboration
kind: journey
title: "Quickstart: collaborating with a team"
audience: user
order: 20
useCase: Give everyone the same view of proof state, documents and security findings through an optional team server.
related:
  - team-server
  - workspaces
  - documentation-api
---

# Quickstart: collaborating with a team

## Goal
Show a whole team the same proof state, generated documents and security findings, without making anyone depend on a server.

## Prerequisites
- Projects set up and running in CI (see [QA automation](qa-automation.md)).
- A team server address and a token, or permission to run one.

## Steps
### What lives where
SpecGuard works fully on one machine. The team server is optional; if it is down, commands fall back to local files.

| | On your machine | On the team server |
|---|---|---|
| Specs and requirement history | in git (the source of truth) | a copy, from the last published snapshot |
| `check`, `test run`, `verify`, `spec ...` | always run here, on your working tree | never: they need your code and your test environment |
| Proofs | your own, marked `local` | CI's, marked `ci`, per commit and branch |
| Generated documents | generated on request when there is no server | generated once for the whole team and shared |
| Remediation plans and their statuses | a file under `.specguard/security/plans/` | the shared plan; trackers update it through the API |
| Prompts captured by hooks | here, never uploaded | never |

Only specs, history entries, the trace model, proof rows and the newest plan leave a machine, and only when `specguard publish` runs.

### Connect a project
Open the server address in your signed-in browser. With no project selected, the home page lists the projects you can access; select one to create a token, or create a project first (needs maintainer access). A new project shows "Awaiting first publish" until CI publishes a snapshot.

```bash
specguard login --server https://specguard.example.com
```

or set `SPECGUARD_SERVER` and `SPECGUARD_TOKEN`. In VS Code use **SpecGuard: Sign in to Team Server**, paste the token into the secure prompt, and select or create a project. A project-scoped token can select only its own project. Then point the project at the server:

```json
{ "server": { "url": "https://specguard.example.com", "project": "portal", "mode": "auto" } }
```

`mode: auto` uses the server when it answers and local files when it does not; `required` (for CI) treats an unreachable server as an error; `off` never contacts it.

### Publish from CI
Add the `publish` gate to the action:

```yaml
- uses: jazzmind/specguard@v0
  with:
    gates: check,test,publish
```

The action uploads `.specguard/` as the `specguard-evidence` artifact. A server that cannot receive webhooks fetches new artifacts from GitHub on a timer and publishes the snapshot inside, taking the commit and branch from the workflow run; runs from forks are ignored. To publish by hand:

```bash
specguard publish --out snapshot.json
specguard publish --push
specguard publish --push --evidence
```

`--evidence` also sends the recorded test run (report data, optionally screenshots, video and traces). It is opt-in: test titles, file paths, attachment names and what a screenshot shows reach the server.

### See what the team sees
```bash
specguard check --team
```

Shows what the team server has proven (CI evidence), set against your working tree.

### Share a workspace
Each repository publishes its own snapshot. Then define the set on the server:

```bash
specguard workspace publish --check
specguard workspace publish
```

The server shows `GET /api/v1/workspaces/<name>/rollup`. Repositories are named on the server by `server.projects` in the manifest, else their own `server.project`, else their folder name.

### Run a server
```bash
specguard server --port 4317 --base-path /specguard
```

Settings come from environment variables; flags override them.

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres. Without it the server keeps files in `SPECGUARD_DATA_DIR`. |
| `SPECGUARD_BASE_PATH` | Path the server is mounted under, for example `/specguard`. |
| `SPECGUARD_BOOTSTRAP_TOKEN` | A secret you choose. Presenting it makes you an admin; use it to create the first tokens. |
| `SPECGUARD_ALLOWED_DOMAIN` | Accept the sign-in header only for this email domain. |
| `SPECGUARD_TRUSTED_PROXIES` | Addresses, IPv4 CIDR ranges or host names the sign-in header is accepted from, normally the sign-in proxy. Without it the header is accepted from anywhere and signs in a read-only viewer whoever it names, and `SPECGUARD_MAINTAINER_EMAILS` has no effect. |
| `SPECGUARD_EMAIL_HEADER` | Header that carries the signed-in user (default `x-deploykit-email`). |
| `SPECGUARD_MAINTAINER_EMAILS` | People who may change plans when signed in through a browser; honoured only for requests from `SPECGUARD_TRUSTED_PROXIES`. |
| `SPECGUARD_RATE_LIMIT_PER_MIN`, `_DOCS_PER_MIN`, `_ANON_PER_MIN` | Requests a minute per signed-in caller (default 600), to document routes that can start a model call (30), and per address with no credential (60). Over the limit: `429` with `Retry-After`. |
| `SPECGUARD_RATE_LIMIT_UPLOAD_PER_MIN` | Requests a minute per caller to the evidence blob routes (default 3000). |
| `SPECGUARD_KEEP_RUNS` | Test runs kept per project (default 5). |
| `SPECGUARD_MAX_EVIDENCE_FILE_MB`, `_RUN_MB` | Largest single evidence file (default 100) and largest evidence total of one run (default 1024). |
| `SPECGUARD_EVIDENCE_MAX_GB` | Evidence held in total across projects (default 20). A run that does not fit is refused with `507`. |
| `SPECGUARD_UPLOAD_CHUNK_KB` | Largest body of one blob upload (default 768); keep it under any proxy's body limit. |
| `SPECGUARD_LLM_PROVIDER`, `_MODEL`, `_BASE_URL` | The model that writes documents (default `litellm`, `fast`). The key is read from `LITELLM_API_KEY`. |
| `SPECGUARD_LLM_MAX_USD` | A spend cap for each generated document. |
| `SPECGUARD_GITHUB_REPOS` | `owner/name=project,owner/other` repositories to pull CI evidence from. |
| `GITHUB_TOKEN` | A fine-grained token with read access to Actions artifacts. |
| `SPECGUARD_GITHUB_POLL_SECONDS` | How often to look for new artifacts (default 300, minimum 30). |

The server's sign-in header can be forged by other containers on the same network, so it is trusted only for reading and for minting a person's own tokens. Anything that changes shared state, and everything administrative, needs a token. If the server sits behind DeployKit, map app managers to the maintainer role by setting `SPECGUARD_APP_ROLE_HEADER=x-deploykit-app-role` together with `SPECGUARD_TRUSTED_PROXIES`; set `DEPLOYKIT_TOKEN_AUTH_PATHS=/api/v1,/mcp` so requests that carry an Authorization Bearer header delegate to SpecGuard's own token check.

### Tokens
A signed-in user creates a personal token from the web UI or with `specguard login`. An admin creates a CI token limited to one project with `POST /api/v1/admin/tokens` and `{ "name": "ci", "role": "maintainer", "project": "demo", "owner": "ci:demo" }`, sent with the bootstrap token. A token is shown once and stored only as a hash; revoke it with `DELETE /api/v1/tokens/<id>`.

### Test runs and evidence on the server
The web UI has a Test report view listing a project's runs and opening each report, and the projects page links each workspace to its rollup report. Evidence is kept per project, blobs are named by their sha256 and verified when the last chunk arrives, and after each commit the server keeps the newest `SPECGUARD_KEEP_RUNS` complete runs and deletes blobs no kept run refers to. Evidence responses are inert: images and video show in place, everything else downloads as an attachment with `nosniff` and a sandbox content security policy.

### Remote MCP
The server answers MCP at `/mcp` for clients that connect by URL, with a token. Its tools are read-only: projects, system, capability, spec, audit, coverage, docs, history, findings and plans.

## Outcome
The team has one place to see proof state, documents and findings, CI is what certifies, and a missing server never blocks anyone's work.

## Related
- [QA automation](qa-automation.md)
- [Vulnerability management](vulnerability-management.md)
- [The VS Code extension](vscode-extension.md)
