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
| `SPECGUARD_TRUSTED_PROXIES` | Addresses (or IPv4 CIDR ranges, comma separated) the sign-in header is accepted from, normally the sign-in proxy. Without it the header is accepted from anywhere, so it signs in a read-only viewer whoever it names, and `SPECGUARD_MAINTAINER_EMAILS` has no effect (changes from a browser, and plan status buttons in the UI, need it; tokens work either way). |
| `SPECGUARD_RATE_LIMIT_PER_MIN` / `_DOCS_PER_MIN` / `_ANON_PER_MIN` | Requests a minute per signed-in caller (default 600), to document routes, which can start a model call (30), and per connecting address with no credential (60). Over the limit: `429` with `Retry-After`. |
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

## Tokens

- A signed-in user creates a personal token from the web UI, or with `specguard login`.
- An admin creates a **CI token** limited to one project: `POST /api/v1/admin/tokens` with
  `{ "name": "ci", "role": "maintainer", "project": "demo", "owner": "ci:demo" }`, sent with the bootstrap token.
- A token is shown once and stored only as a hash. Revoke it with `DELETE /api/v1/tokens/<id>`.

## Using a server from a project

```json
{ "server": { "url": "http://ae1pocltv03/specguard", "project": "portal", "mode": "auto" } }
```

or set `SPECGUARD_SERVER` and `SPECGUARD_TOKEN`. `mode: auto` uses the server when it answers and the local files when it
does not; `required` (for CI) treats an unreachable server as an error; `off` never contacts it.

## Remote MCP

The server answers MCP at `/mcp` for clients that connect by URL, with a token. Its tools are read-only: projects, system,
capability, spec, audit, coverage, docs, history, findings and plans.
