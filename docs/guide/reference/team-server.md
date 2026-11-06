---
title: "Local-first operation with an optional team server"
audience: user
source: "specs/capabilities/team-server.md"
generated: true
---
<a id="local-first-operation-with-an-optional-team-server"></a>
# Local-first operation with an optional team server

SpecGuard works completely on one machine. If your team runs a team server, you also get shared proof from CI, shared documents and shared remediation plans. Nothing depends on the server being there.

<a id="why-it-exists"></a>
## Why it exists

A developer's laptop knows only its own working tree. CI knows what was pushed, but its results disappear with the build. Auditors, product owners and reviewers often have no checkout at all. Putting everything on a server would make SpecGuard useless offline, in a fresh clone, or whenever the server is down. Keeping everything local leaves the team with no shared record of what is proven, what is stale, and which security findings are being worked on.

SpecGuard therefore has one engine with two homes. The command line is always complete. The optional team server holds what CI publishes, shares generated documents and plans, and records who asked for model-generated content so spend can be attributed. Git stays the source of truth for specs and requirement history. The server only indexes and aggregates them.

<a id="what-you-can-do"></a>
## What you can do

<a id="keep-working-locally"></a>
### Keep working locally
- Run `specguard check` and the other commands with no server. Everything works from your local files.
- If a server is configured but unreachable, reads quietly fall back to local data and tell you which source they used.

<a id="publish-proof-from-ci"></a>
### Publish proof from CI
- Run `specguard publish` after your tests. It writes one snapshot file containing:
  - your spec and history markdown
  - the trace model
  - the proof rows
  - the newest remediation plan
  - the contract graph
- The snapshot is tagged with the project name, repository, branch, commit and version information.
- Add `--push` (or `--server <url>`) to also send it to the team server. The first publish creates the project if it does not exist yet.
- Run `specguard publish --check` to see whether a publish is needed without uploading anything. It lists the reasons (never published, specs, trace, proofs, plans or contracts changed, a newer run, incomplete evidence) and the spec files added, removed or modified. It exits with 0 when the server is up to date and 9 when a publish is needed.
- Run `specguard publish --push --evidence` to upload the newest run (or the one you pick with `--run`) together with its evidence files:
  - Only files the server does not already have are uploaded, in chunks, and an interrupted upload resumes where it stopped.
  - The run is committed only when every file is verified.
  - `--max-evidence-mb` caps how much you are willing to upload.
  - `--skip-oversized` records files over the server's size cap as omitted instead of stopping.

<a id="see-the-team-s-proof-next-to-yours"></a>
### See the team's proof next to yours
- `specguard check --team` shows the team's CI proofs alongside your local ones.

<a id="share-security-remediation-plans"></a>
### Share security remediation plans
- Read the open findings and plans from the server.
- A signed-in maintainer, or a tracker using a token, can mark plan items in progress or fixed. Changes are attributed to the person who made them.
- If two people change the same item at once, the first change wins. The second is refused with a conflict and nothing is overwritten.
- When CI republishes, statuses and tracker references set on the server are kept. An item marked fixed that a scan sees again is reopened.

<a id="share-generated-documents"></a>
### Share generated documents
- Documents are generated once for a given spec content, audience and model, then shared with everyone. Model usage is recorded against the person who asked and the project.

<a id="browse-in-the-web-ui"></a>
### Browse in the web UI
- With no project selected, the server shows a directory of the projects you can access. If there are none, it offers a creation flow. Maintainers can create projects before the first publish.
- Auditors and product owners with no checkout can read the system guide, capability docs and traceability.
- You can list a project's published runs with their totals and open a run's report, or a workspace's rollup report.
- The UI works under a path prefix and across projects.

<a id="use-your-usual-tools"></a>
### Use your usual tools
- The command line, the MCP server, the VS Code extension and the web UI all use the same project-scoped API. Each uses the server when it answers and local files when it does not.
- The server also offers a read-only MCP endpoint for token holders. It covers projects, system, capability, spec, audit, coverage, docs, history, findings and plans, with the same access rules as the API.
- In the VS Code extension, browser onboarding is available whether or not you are connected. You can sign in with a verified token, then pick or create a project. The token and repo connection are saved securely. The Team server row opens the server, and each repo row can open that repo's project page. A command does the same for the active repo. Address and project changes in the extension's settings take effect immediately.

<a id="let-the-server-collect-ci-evidence-itself"></a>
### Let the server collect CI evidence itself
- The server can periodically fetch the evidence artifacts that CI uploaded for each configured repository and publish them under the right project. It takes the commit and branch from the workflow run.
- It skips artifacts it already has, and artifacts that are expired, oversized, invalid or from forks. One repository failing does not stop the others.

<a id="sign-in-and-manage-tokens"></a>
### Sign in and manage tokens
- Use `specguard login` and `specguard logout`. A token you log in with is checked against the server before it is saved.
- People can create, list and revoke their own tokens. Tokens are shown once, stored only as hashes, and revocable by their owner. Nobody can create a token more powerful than their own.
- Project CI tokens reach only their project, and cannot create projects.

<a id="what-to-expect"></a>
## What to expect

**Server settings.** You can set the server address, project, token variable, mode and timeout in the configuration or the environment. Before using the server, commands check its health quickly and confirm it speaks a compatible API version. A client can refuse to mix incompatible data.

**Server modes.**
- By default, an unreachable server means local behavior. Shared writes are saved locally and marked local-only.
- `server.mode: required` makes an unreachable server an error.
- `off` never contacts the server.

**Refusals are never hidden.** If the server answers but says no (bad token, no permission, a lifecycle violation), you get an error. SpecGuard does not quietly switch to local. If a push is refused or the server cannot be reached, the command fails, but the snapshot file is still written.

**Read-only local server.** The local `serve` command does not accept writes. Every write attempt is answered with a "method not allowed" response.

**Access and roles.**
- Every route except health requires a credential.
- Browsers behind a trusted proxy can sign in through the proxy's user header. On its own that header only gives a read-only viewer, who can read and create viewer tokens. Becoming a maintainer requires a trusted proxy and either a listed maintainer email or a verified app-manager role. It never makes an administrator.
- If sign-in is refused because the header was missing, came from an untrusted address or was outside the allowed domain, the message says which. The web UI shows that text.
- Changes made from a browser session need an extra request header. A bad token is refused even if the sign-in header is present.
- Administrator tokens come only from the administrator route.

**Rate limits.** Each caller has a per-minute request limit:

| Caller | Limit |
|---|---|
| Signed-in | 600 |
| No credential | 60 |
| Document generation | 30 |

Going over a limit returns a "too many requests" response with a retry time. Health checks are never limited, and operators can change the limits.

**Audit trail.** The server records token creation and revocation, plan status changes, workspace definitions and published snapshots, along with who did each one. It also records refused attempts to change something, with the reason. Reads are not recorded.

**Evidence handling.**
- The server verifies each uploaded file and discards any partial upload that fails verification.
- Oversized chunks, files or runs are refused with a clear error.
- It keeps the last five runs per project by default and cleans up files no kept run uses.
- One project cannot learn what another holds.
- Images and video display inline. Traces and all other file types download as attachments.
- If the server does not support evidence uploads, you get the snapshot followed by a clear upgrade message.

**Privacy.**
- Only specs, history entries, trace data, proof rows and plans leave your machine, and only when you run `publish`.
- Source code, working-tree files outside the spec tree and uncommitted prompts are never included.
- Credentials are removed from every file before the snapshot is written, and again from everything the API serves.
- Snapshots are validated before they are written or accepted. Unsafe project names, files outside the spec tree, unknown versions and oversized snapshots are refused.

**Compatibility.** Publishing is backward compatible. Older servers ignore the extra fields. If a server lacks newer routes, `publish --check` compares commits and reports that the result is not exact.

**Which snapshot is shown.** A project appears from its newest snapshot on the default branch, or its newest overall if there is none.

<a id="not-available-yet"></a>
## Not available yet
- Live change notifications. Clients poll or watch files.
- Reading the cross-repo contract graph from the server when sibling repos are not checked out. `impact` and `contracts` still read local files.
- Running `verify` against deployed apps from the server.
- Running tests on the server. CI runs them and publishes the result.
