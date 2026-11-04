# The SpecGuard team server

SpecGuard works fully on one machine. A team server is optional: it shows everyone the same proof state, documents and
security findings, and nothing depends on it. If it is down, your commands fall back to local files.

## What lives where

| | On your machine | On the team server |
|---|---|---|
| Specs and requirement history | in git (the source of truth) | a copy, from the last published snapshot |
| `check`, `test run`, `verify`, `spec ...` | always run here, on your working tree | never: they need your code and your test environment |
| Proofs | your own, marked `local` | CI's, marked `ci`, per commit and branch |
| Generated documents | generated on request when there is no server | generated once for the whole team and shared |
| Remediation plans and their statuses | a file under `.specguard/security/plans/` | the shared plan; trackers update it through the API |
| Prompts captured by hooks | here, never uploaded | never |

Only specs, history entries, the trace model, proof rows and the newest plan leave a machine, and only when
`specguard publish` runs.

## Publishing from CI

Add the `publish` gate to the SpecGuard Action:

```yaml
- uses: jazzmind/specguard@v0
  with:
    gates: check,test,publish
```

The Action uploads `.specguard/` as the `specguard-evidence` artifact. The server fetches new artifacts from GitHub on a
timer (the sandbox cannot receive webhooks) and publishes the snapshot inside, taking the commit and branch from the
workflow run. Runs from forks are ignored.

To build a snapshot by hand: `specguard publish --out snapshot.json`.

## Running a server

```
specguard server --port 4317 --base-path /specguard
```

All settings come from environment variables; flags override them.

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres. Without it the server keeps files in `SPECGUARD_DATA_DIR`. |
| `SPECGUARD_BASE_PATH` | Path the server is mounted under, for example `/specguard`. |
| `SPECGUARD_BOOTSTRAP_TOKEN` | A secret you choose. Presenting it makes you an admin; use it to create the first tokens. |
| `SPECGUARD_ALLOWED_DOMAIN` | Accept the sign-in header only for this email domain. |
| `SPECGUARD_TRUSTED_PROXIES` | Addresses, IPv4 CIDR ranges or host names (comma separated; a name such as the proxy container's is re-resolved every 30 seconds, so it survives the proxy restarting with a new address) the sign-in header is accepted from, normally the sign-in proxy. Without it the header is accepted from anywhere, so it signs in a read-only viewer whoever it names, and `SPECGUARD_MAINTAINER_EMAILS` has no effect (changes from a browser, and plan status buttons in the UI, need it; tokens work either way). |
| `SPECGUARD_RATE_LIMIT_PER_MIN` / `_DOCS_PER_MIN` / `_ANON_PER_MIN` | Requests a minute per signed-in caller (default 600), to document routes, which can start a model call (30), and per connecting address with no credential (60). Over the limit: `429` with `Retry-After`. |
| `SPECGUARD_RATE_LIMIT_UPLOAD_PER_MIN` | Requests a minute per caller to the evidence blob routes (default 3000). They count in this bucket and not in the general one, because one run is hundreds of chunk requests. |
| `SPECGUARD_KEEP_RUNS` | Test runs kept per project (default 5). Older runs, and blobs no kept run refers to, are deleted. |
| `SPECGUARD_MAX_EVIDENCE_FILE_MB` / `_RUN_MB` | Largest single evidence file (default 100) and largest evidence total of one run (default 1024). |
| `SPECGUARD_EVIDENCE_MAX_GB` | Evidence the server holds in total, across projects (default 20). A run that does not fit is refused with `507`. |
| `SPECGUARD_UPLOAD_CHUNK_KB` | Largest body of one blob upload (default 768). Keep it under the body limit of any proxy in front of the server (about 1 MB is common). |
| `SPECGUARD_EMAIL_HEADER` | Header that carries the signed-in user (default `x-deploykit-email`). |
| `SPECGUARD_MAINTAINER_EMAILS` | People who may change plans when signed in through a browser. Honoured only for requests that come from `SPECGUARD_TRUSTED_PROXIES`. |
| `SPECGUARD_LLM_PROVIDER` / `_MODEL` / `_BASE_URL` | The model that writes documents (default `litellm`, `fast`). The key is read from `LITELLM_API_KEY`. |
| `SPECGUARD_LLM_MAX_USD` | A spend cap for each generated document. |
| `SPECGUARD_GITHUB_REPOS` | `owner/name=project,owner/other` repositories to pull CI evidence from. |
| `GITHUB_TOKEN` | A fine-grained token with read access to Actions artifacts. |
| `SPECGUARD_GITHUB_POLL_SECONDS` | How often to look for new artifacts (default 300, minimum 30). |

### Deploying to the sandbox

`.deploykit/apps.json` and the `Dockerfile` at the repository root describe the app. Set `SPECGUARD_BOOTSTRAP_TOKEN`,
`LITELLM_API_KEY` and `GITHUB_TOKEN` at deploy time. The sandbox gives the app a Postgres database through
`{{DK_DB_URL}}`.

The sandbox's sign-in passes the user's email in a header. Other containers on the same network could forge that header,
so it is trusted only for reading and for minting a person's own tokens. Anything that changes shared state, and
everything administrative, needs a token.

## Test runs and evidence

`specguard publish --push --evidence` sends a recorded test run: the report data and, optionally, its screenshots, video and
traces. The server renders the report itself, so a team sees the same page the command line writes, without a checkout.
Publishing evidence is opt-in: test titles, file paths, attachment names and what a screenshot shows (the secret redactor
cannot see inside images) reach the server.

- The web UI has a **Test report** view that lists a project's runs (pass/fail, size, newest first) and opens each report.
  The projects page links each workspace to its rollup report.
- Everything is under `/api/v1`, so the sign-in header and tokens apply. Reading needs any role; changing needs maintainer,
  and a token limited to a project reaches only that project.
- Evidence is kept **per project**: no blob is shared between projects, so a project-scoped token cannot learn what another
  project holds. Blobs are named by their sha256 and verified when the last chunk arrives; bytes that do not hash to their
  name are discarded (`422`).
- Retention: after each commit the server keeps the newest `SPECGUARD_KEEP_RUNS` complete runs of the project, deletes the
  blobs no kept run refers to, and deletes partial uploads and unfinished runs older than a day. `DELETE
  /api/v1/projects/<p>/runs/<id>` removes one run. The audit trail records `run.publish`, `run.prune` and `run.delete`.
- Storage: a file server keeps runs and blobs under `SPECGUARD_DATA_DIR/projects/<p>/{runs,blobs}`. A Postgres server
  keeps them in `sg_runs`, `sg_blobs` and `sg_blob_chunks` (chunked `bytea`), so a database-only deployment needs no volume.
  The database's own size quota is not known to SpecGuard: set `SPECGUARD_EVIDENCE_MAX_GB` below it. `GET /api/v1/health`
  lists the `features` (`publish-state`, `evidence`) and `limits` the server enforces, so clients can check before they send.

### Routes

| Route | Role | Notes |
|---|---|---|
| `GET /projects/<p>/publish-state` | viewer | The caller, the newest snapshot with its digest (computed by the server), the runs, the limits and features. |
| `POST /projects/<p>/runs` | maintainer | Body: a `specguard-run/1` manifest (gzip allowed). Answers `{runId, status, missing[], chunkBytes}`. `400` invalid; `413` `file-too-large` (with the files) or `run-too-large`; `507` `storage-full`. Offering the same run again is harmless. |
| `HEAD /projects/<p>/blobs/<sha256>` | viewer | `200` complete, `204` with `Upload-Offset` when partial, `404` absent. |
| `PUT /projects/<p>/blobs/<sha256>` | maintainer | `application/octet-stream` with `Upload-Offset` and `Upload-Length`; body at most `chunkBytes`. `204` and the new `Upload-Offset` for a chunk, `201` when complete and verified, `409` `offset-mismatch` (with `expectedOffset`) or `not-requested`, `422` `hash-mismatch`, `413`. |
| `POST /projects/<p>/runs/<id>/commit` | maintainer | `200 {runId, status, files, bytes, pruned}`; `409` `incomplete` with the missing hashes. |
| `GET /projects/<p>/runs`, `GET /projects/<p>/runs/<id\|latest>` | viewer | The run list, and a run's manifest. `latest` is the newest complete run. |
| `GET /projects/<p>/runs/<id\|latest>/report/index.html`, `.../report/report.json` | viewer | The report, rendered on the server from the stored data. |
| `GET /projects/<p>/runs/<id\|latest>/report/evidence/<path>` | viewer | One evidence file, by the path in the manifest. Supports `Range`. |
| `GET /workspaces/<w>/report/index.html`, `.../report/workspace-report.json`, `.../report/repos/<key>/index.html`, `.../report/repos/<key>/evidence/<path>` | viewer | The workspace rollup from each member project's newest complete run. |

Evidence responses are inert: images (png, jpeg, gif, webp) and video (webm, mp4) show in place, everything else (traces,
SVG, HTML) downloads as an attachment; every one carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy:
sandbox` and private caching with the sha256 as ETag. A path is looked up in the manifest and is never joined to a
filesystem path, so a path that climbs or is not listed is a `404`.

## Tokens

- A signed-in user creates a personal token from the web UI, or with `specguard login`.
- An admin creates a **CI token** limited to one project: `POST /api/v1/admin/tokens` with
  `{ "name": "ci", "role": "maintainer", "project": "demo", "owner": "ci:demo" }`, sent with the bootstrap token.
- A token is shown once and stored only as a hash. Revoke it with `DELETE /api/v1/tokens/<id>`.

## Using a server from a project

```json
{ "server": { "url": "https://specguard.example.com", "project": "portal", "mode": "auto" } }
```

or set `SPECGUARD_SERVER` and `SPECGUARD_TOKEN`. `mode: auto` uses the server when it answers and the local files when it
does not; `required` (for CI) treats an unreachable server as an error; `off` never contacts it.

## Remote MCP

The server answers MCP at `/mcp` for clients that connect by URL, with a token. Its tools are read-only: projects, system,
capability, spec, audit, coverage, docs, history, findings and plans.

## Connect a new project

Open the team server address in your signed-in browser. With no project selected, the home page lists projects you can access. Select a project to create a token, or create a project first (requires maintainer access). A new project shows “Awaiting first publish”; it does not contain evidence until CI publishes a snapshot. Tokens can also be managed without selecting a project.

In VS Code, use **SpecGuard: Sign In** or **Connect / select or create project** in SpecGuard settings. Open the server to obtain a token, paste it into the secure prompt, and select a project or create one using an unrestricted maintainer token. The extension saves the token securely and records the connection for the selected repository. A project-scoped token can select only its own project.

### DeployKit app managers

DeployKit app-manager permission maps to SpecGuard's `maintainer` role when the proxy forwards verified app permissions. Update DeployKit and regenerate the app's nginx route first, then set `SPECGUARD_APP_ROLE_HEADER=x-deploykit-app-role` and `SPECGUARD_TRUSTED_PROXIES` to the actual sign-in proxy's addresses on the team server and restart it. Do not enable this header on a proxy that lets clients supply it. DeployKit clears the header for public app routes; use a gated route for browser manager permissions. Browser managers can create projects and maintainer tokens, but cannot administer tokens. Existing viewer tokens retain their original role; create a new maintainer token after the browser mapping is active. Explicit `SPECGUARD_MAINTAINER_EMAILS` remains supported for other deployments.

### Bearer tokens through the DeployKit proxy

Set `DEPLOYKIT_TOKEN_AUTH_PATHS=/api/v1,/mcp` in the app's deployment environment when using the updated DeployKit routing support. Only requests carrying an Authorization Bearer header on these paths beneath the app prefix delegate authentication to SpecGuard; browser pages and browser API requests without bearer credentials keep DeployKit sign-in. Delegated paths clear proxy identity headers and the sandbox session cookie, and SpecGuard requires its own bearer token for protected endpoints. Without this setting the extension is redirected to `/auth/login`, even with a valid SpecGuard token. The server URL remains the base address, for example `https://specguard.example.com`; enter `my-project` separately as the project name.
