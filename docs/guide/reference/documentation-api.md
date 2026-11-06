---
title: "Documentation and API"
audience: user
source: "specs/capabilities/documentation-api.md"
generated: true
---
<a id="documentation-and-api"></a>
# Documentation and API

SpecGuard turns your specs into documentation that matches the system as it is now. It writes for different readers: end users, developers and AI agents. You can generate it from the command line or request it over a read-only local API.

<a id="why-it-exists"></a>
## Why it exists

Hand-written documentation goes stale as soon as the system changes. One document can't serve everyone either. End users want to know what the system does, developers want to know where and how, and AI agents want compact, structured context that is cheap to load. Teams often end up with wrong docs, or with several copies that disagree.

SpecGuard writes documentation from the specs, which are kept current and traceable to code and tests. SpecGuard documents itself this way, so its own how-to pages can't drift from its specs.

<a id="what-you-can-do"></a>
## What you can do

<a id="generate-user-facing-pages"></a>
### Generate user-facing pages
- `specguard docs --spec <key>`, `--all` or `--app <name>` rewrites one spec, every spec, or one app's specs into plain-language Markdown pages. The default location is `docs/user/`, and `--out` lets you choose another folder.
- Each page starts with a title, sidebar label, description, category, reading order and a marker saying it was generated. This suits a docs site.
- Scenarios, security notes and other internal-only content are left out of the pages.
- The command prints a summary such as `docs: 3 created, 1 skipped, 1 failed`.

<a id="keep-front-door-files-in-sync"></a>
### Keep front-door files in sync
- The same command refreshes marked sections (architecture, commands, pipeline) in `README.md`, `CLAUDE.md` (only if it exists) and `AGENTS.md`.
- Sections are replaced between their start and end markers, or added if missing. Your hand-written text outside the markers is never changed.
- If `AGENTS.md` doesn't exist, it is created from a template.

<a id="build-the-full-documentation-set"></a>
### Build the full documentation set
`specguard docs build` produces a complete, committable set:
- user guides, developer guides, and a capability reference for each audience;
- an index (`docs/index.md`) grouped as Start here, Quickstarts, Reference and Developer;
- a manifest listing every page and its sections;
- a help-topics file that powers help icons and the editor's help panel.

Guides are specs placed under `specs/guides/`. Each has a title, an audience (user or dev), an order, and optionally a use case and related capabilities. Guides can include a `## Help Topics` section. Each line gives a key, the section it points to and a one-line popover text. In a capability spec, the section must be *Why it exists*, *What you can do* or *What to expect*.

Useful options:
- `--no-llm` builds without a model. Two such builds produce identical files.
- `--check` writes nothing and calls no model. It exits with code 3 and names each page that is out of date, missing, or different from what a build would produce. This suits CI.
- `--out <dir>` chooses the output folder.

Reference pages whose spec hasn't changed are kept as they are, so only edited specs cost a model call. Every heading gets a stable anchor, so help icons and links can jump to the right section.

<a id="read-the-audit-documents"></a>
### Read the audit documents
The traceability matrix and audit data are plain JSON or CSV files under `.specguard/`. Auditors and viewers can open them directly to see how requirements map to tests and docs. An assistant can reach the docs and matrix through the `specguard_docs` and `specguard_matrix` tools.

<a id="serve-documentation-over-a-local-api"></a>
### Serve documentation over a local API
`specguard serve [--port <n>] [--host <addr>] [--cors <origin>]` starts a read-only server. All endpoints are under `/api/v1` and use GET only:

| Endpoint | Returns |
|---|---|
| `/system` | The system spec |
| `/capabilities` | All capabilities with their value statements |
| `/capabilities/:id` | One capability's content |
| `/capabilities/:id/history` | That capability's requirement history |
| `/trace` | Traceability data |
| `/audit` | Audit views |
| `/security/plans` | Stored remediation plans |
| `/docs/:audience/:id` and `/docs/:audience/system` | Generated documentation |

The audience in `/docs/...` is one of three:
- **user**: what the capability does, without claims or internals;
- **dev**: adds sources, interfaces and tests;
- **agent**: a compact structured form that can be read without parsing prose.

An unknown audience or capability gets a clear 400 or 404 error.

Opening `http://localhost:<port>/` gives a small web UI. You can browse the system, capabilities, their trace and history, and generated docs. It uses only the API.

<a id="check-your-guides"></a>
### Check your guides
`specguard check` warns about these problems in guides and help topics:
- **Unknown command:** a guide mentions a command SpecGuard doesn't have.
- **Unknown related capability:** a guide lists a related id that isn't a capability.
- **Duplicate help key:** a help key is defined twice.
- **Unknown anchor:** a help topic points to a section that isn't on its page.
- **Stale docs:** a page is older than its spec.

<a id="what-to-expect"></a>
## What to expect

**Generation**
- Docs are regenerable. Running the command again overwrites existing files.
- If the model fails on one spec, that failure is recorded and the others continue. The command fails only if every attempted spec failed.
- If the text for a front-door section can't be generated, the error is logged and no root file is changed.
- Credentials never appear in generated pages or synchronised sections.

**Served documents**
- Docs are generated only when requested, using the fast model, and returned as complete documents rather than streams.
- Results are cached. An unchanged spec is served from the cache. Editing the spec, changing the prompt version or using a different model regenerates the document.
- If several people request the same uncached document at once, only one model call is made and everyone gets the same result.
- Each generation has its own spending budget. If the budget is spent, that request fails with HTTP 429 and other requests are unaffected.
- If the model is unavailable, user and dev docs are produced directly from the spec, with a warning. These aren't cached, so the next request tries the model again.
- Credentials and secret values from specs, config or history are redacted before anything leaves the server.

**Safety of the server**
- The server cannot change anything or run commands. Malformed requests get a 400 and never stop it.
- It listens only on your own machine by default. On a local address it also rejects requests with a non-local Host header, which protects against hostile web pages.
- A wider address requires `--host` together with `--allow-remote`. There is no sign-in, so without the flag the server refuses and points you to `specguard server`.
- Cross-origin access is allowed only for an origin you name with `--cors`.
- The web UI escapes HTML in model-written text and links only to web, site-relative and in-page addresses, so generated docs can't inject scripts. Its page cannot be framed.

**Not included**
- Hosting a public documentation site.
- Authentication or multi-user access control.
- Streaming responses, or editing documents through the API.
- Producing the traceability matrix itself. See *traceability and drift*.
