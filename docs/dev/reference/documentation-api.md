---
title: "Documentation and API (developer reference)"
audience: dev
source: "specs/capabilities/documentation-api.md"
generated: true
---
<a id="documentation-and-api"></a>
# Documentation and API

<a id="purpose"></a>
## Purpose

This capability gives people and AI agents accurate documentation of the system as it is now, pitched at their level. Docs are generated from the specs on request and can be delivered over an API.

It exists because hand-written docs go stale and a single static document cannot serve every reader. End users want to know what the system does. Developers want to know where and how. Agents want compact structured context that is cheap to load. The specs are kept current and traceable to code and tests, so they are the source. The capability also documents SpecGuard itself: guide specs under `specs/guides/` and the capability specs are built into a committed documentation set, so the product's own how-to docs cannot drift from its specs.

The spec describes the read-only API and web UI (`specguard serve`) as the main planned direction. The requirements below define its behaviour.

<a id="responsibilities"></a>
## Responsibilities

- Rewrite specs into user-facing Markdown pages under `docs/user/` (the legacy `docs` command).
- Keep marked sections of `README.md`, `CLAUDE.md` and `AGENTS.md` in sync without touching hand-written text.
- Build the documentation set (`specguard docs build`): guides, capability reference pages, index, manifest and help topics. Check that set for freshness.
- Parse guide specs and `## Help Topics` sections, and validate them as warnings during `check`.
- Expose audit data (traceability matrix and similar) as plain JSON or CSV documents under `.specguard/`.
- Serve a read-only HTTP API under `/api/v1` plus a small static web UI. It generates user, dev and agent documentation on demand with the fast model tier, with caching, single-flight and per-request budgets.
- Redact secrets from everything served or written.

Out of scope: hosting a public docs site, authentication and multi-user access control for the server, streaming responses, editing documents through the API, and producing the traceability matrix itself (see `traceability-and-drift`).

<a id="interfaces"></a>
## Interfaces

<a id="cli"></a>
### CLI

- `specguard docs [--spec <key>] [--all] [--out <path>] [--app <name>]` prints `docs: <N> created, <N> skipped, <N> failed`.
- `specguard docs build [--no-llm] [--check] [--out <dir>]` builds the documentation set. `--check` exits 3 (drift) when a page is out of date.
- `specguard serve [--port <n>] [--host <addr>] [--cors <origin>]`. The `serve-bind-loopback` requirement also refers to `--allow-remote`, used together with `--host`, which the interface line does not list.
- Exit codes: 0 on success, non-zero when every attempted document failed.

<a id="http-get-only-under-api-v1"></a>
### HTTP (GET only, under `/api/v1`)

| Endpoint | Returns |
|---|---|
| `/system` | System spec |
| `/capabilities` | Capability list with value statements |
| `/capabilities/:id` | One capability's parsed content |
| `/capabilities/:id/history` | Requirement history |
| `/trace` | Traceability data |
| `/audit` | Audit views |
| `/security/plans` | Stored remediation plans |
| `/docs/:audience/:id`, `/docs/:audience/system` | Generated docs for audience `user`, `dev` or `agent` |

The static UI is served at `/`.

<a id="mcp"></a>
### MCP

- `specguard_docs`
- `specguard_matrix` (the matrix document)

<a id="files"></a>
### Files

- Legacy output: `docs/user/<feature>.md`, with frontmatter `title`, `sidebar_label`, `description`, `category`, `order`, `generated`.
- Doc set: `docs/guide/*.md`, `docs/dev/*.md`, `docs/guide/reference/<id>.md`, `docs/dev/reference/<id>.md`, `docs/index.md`.
- `docs/manifest.json`: `version`, and `pages[]` with `id`, `title`, `audience`, `group`, `file`, `sections[]`, `sourceHash`, `generator`.
- `docs/help-topics.json`: key mapped to `title`, `text`, `page`, `anchor`.
- Root-file markers: `<!-- specguard:<key>:start -->` and `<!-- specguard:<key>:end -->` in `README.md`, `CLAUDE.md` and `AGENTS.md`.
- Audit data: `.specguard/traceability.json` and other audit data.

<a id="spec-syntax"></a>
### Spec syntax

A guide's `## Help Topics` section has one line per topic:

```
- `key.name` → Section Heading: one-line popover text
```

The heading names a section of the guide's own page. In a capability spec it must be one of `Why it exists`, `What you can do` or `What to expect`.

<a id="config"></a>
### Config

The fast model tier comes from `llm.models.fast`, and each request has its own budget.

<a id="requirements"></a>
## Requirements

<a id="per-spec-docs-and-root-sync"></a>
### Per-spec docs and root sync

- **docs-per-spec**: `docs` rewrites a single spec, all specs or one app's specs into user-facing Markdown under `docs/user/` (or a chosen output directory), mirroring the spec's relative path.
- **docs-strip-internal**: The metadata comment, scenarios and security notes are removed before the LLM sees the spec. The rewrite must stay accurate to the supplied spec and not invent features.
- **docs-frontmatter**: Each page starts with frontmatter holding a title, sidebar label, description, category, reading order and a generated flag.
- **docs-failure-isolation**: Generated docs are regenerable and overwrite existing files. An LLM failure on one spec is recorded and does not stop the others. The command fails only if every attempted spec failed.
- **root-doc-sync-sentinels**: After per-spec docs are generated, marked sections of `README.md`, `CLAUDE.md` (only if it exists) and `AGENTS.md` are replaced between the markers, or appended when absent. Content outside the markers is never altered.
- **root-doc-sync-safe**: `AGENTS.md` is created from a template when missing, and only its marked sections are updated when present. If generating the section text fails, the error is logged and nothing is written.
- **docs-no-secrets**: LLM credentials never appear in any generated page or synchronised section.
- **audit-data-as-documents**: The traceability matrix and audit data are plain JSON or CSV files under `.specguard/` that viewers and auditors can load as documents.

<a id="server-and-api"></a>
### Server and API

- **serve-readonly**: `specguard serve` starts a read-only HTTP server on `node:http`, bound to localhost under `/api/v1`. No endpoint writes, runs a pipeline or executes code. A malformed request target or percent-encoding gets a 400 and never stops the server.
- **spec-endpoints**: `GET /system`, `/capabilities`, `/capabilities/:id` and `/capabilities/:id/history` return the system spec, the capability list with value statements, one capability's parsed content and its requirement history.
- **audit-endpoints**: `GET /trace`, `/audit` and `/security/plans` return the traceability data, audit views and stored remediation plans in their existing stable JSON shapes.
- **docs-endpoints**: `GET /docs/:audience/:id` and `/docs/:audience/system` return generated documentation for `user`, `dev` or `agent`. An unknown audience or capability returns a clear 400 or 404.
- **audience-shapes**: The user audience omits claims and internals. The dev audience adds sources, interfaces and tests. The agent audience is a compact structured form that can be parsed without reading prose.
- **fast-tier-on-demand**: Documentation is generated on demand with the fast model tier, never in the background. Responses are complete documents, not streams.
- **cache-key**: Documents are cached (behind a cache interface, files by default) by spec content hash, audience, prompt version, model and the enabled plugin renderers. An unchanged spec is served from cache. An edited spec, a changed prompt version or a different model regenerates.
- **single-flight-budget**: Concurrent requests for the same uncached document share one LLM call. Different documents generate concurrently. Each generation runs in its own LLM scope with its own budget: a spent budget fails only that request with a clear error and never affects or resets another. The requester's name is sent to the model gateway for spend attribution.
- **static-ui**: A small static web UI at `/` lets a person browse the system, capabilities, trace and generated docs using only the API.
- **served-redaction**: Served documents and data are redacted so credentials and secret values from specs, config or history never leave the server.
- **serve-host-guard**: On a loopback address the server rejects any request whose Host header is not a local name, which blocks DNS-rebinding reads from a hostile page. It answers with `nosniff`, no-store and a content security policy on the UI. It sends cross-origin headers only when `--cors` names an origin.
- **ui-escapes-markdown**: The web UI escapes all HTML in model-written markdown and links only http(s), site-relative and anchor URLs, so generated docs cannot inject script.
- **docs-model-fallback**: When the model is unavailable, the user and dev audiences are rendered directly from the spec with a warning and are not cached, so the next request tries the model again. A spent LLM budget is reported as HTTP 429 instead.
- **html-headers**: The HTML page of both servers cannot be framed (`frame-ancestors 'none'` and `X-Frame-Options: DENY`), cannot set a base URL, load an object or post a form to another origin, and sends no referrer. JSON responses carry `nosniff` and `no-store`.
- **serve-bind-loopback**: `specguard serve` binds loopback unless `--allow-remote` is given with `--host`, because its API has no authentication. Without the flag a wider address is refused, with a message pointing to `specguard server`. A host name that merely starts with `127.` is not loopback.

<a id="guides-help-topics-and-the-doc-set"></a>
### Guides, help topics and the doc set

- **guide-specs**: A guide is a `kind: journey` spec under `specs/guides/` with frontmatter `id`, `title`, `audience` (`user` or `dev`), `order`, an optional `useCase` and `related` capability ids. Guides load in the spec graph without needing sources, tests or a Problem & Value section, and do not appear as capabilities.
- **guide-validation**: `check` validates guides and help topics as warnings:
  - `guide-unknown-command`: a `specguard <command>` in a shell block that the CLI (including built-in plugin commands) lacks.
  - `guide-unknown-related`: a related id that is not a capability.
  - `help-duplicate-key`: a key defined twice.
  - `help-unknown-anchor`: a topic whose section is not on its page.
- **help-topics-from-specs**: A `## Help Topics` section is parsed from guide and capability specs, one line per topic as key, section heading and one-line text. `docs build` writes `docs/help-topics.json` mapping each key to its title, text, page and anchor, falling back to the top of the page when the section is missing.
- **doc-set-build**: `specguard docs build` writes:
  - user guides under `docs/guide/`;
  - developer guides under `docs/dev/`;
  - a capability reference page per audience under `docs/guide/reference/` and `docs/dev/reference/`;
  - `docs/index.md`, grouped as Start here, Quickstarts, Reference and Developer;
  - `docs/manifest.json`, listing every page with its sections and source hash.
- **doc-anchors-stable**: Every heading outside a code fence in a generated page is preceded by an `<a id="slug"></a>` line. Slugs are unique within the page and depend only on the heading text. Anchoring an already anchored page changes nothing.
- **doc-build-deterministic**: With `--no-llm`, two builds produce byte-identical files. A capability reference page whose spec is unchanged since the manifest's recorded source hash is kept rather than regenerated, so only edited specs cost a model call.
- **docs-freshness-check**: `specguard docs build --check` writes nothing and calls no model. It exits with the drift exit code and names each page when a page's spec hash differs from the manifest, a page is missing, or a deterministic file differs. `check` warns `docs-stale` when any page is older than its spec.

<a id="code-map"></a>
## Code map

Sources (24 owned files in total):

- `src/core/state/content-cache.ts`
- `src/core/slug.ts`
- `src/core/guides.ts`
- `src/pipelines/doc-build.ts`
- `src/pipelines/doc-generate.ts`
- `src/core/root-doc-sync.ts`
- `src/cli/commands/docs.ts`
- `src/server/**`
- `src/cli/commands/serve.ts`

The spec does not describe what each file does. File names suggest the following, which is an inference: `doc-generate` and `doc-build` are the two pipelines, `root-doc-sync` handles marked sections, `slug` and `guides` support anchors and guide parsing, and `content-cache` supports caching.

<a id="tests"></a>
## Tests

- `tests/pipelines/doc-generate.test.ts`
- `tests/pipelines/doc-build.test.ts`
- `tests/core/guides.test.ts`
- `tests/core/slug.test.ts`
- `tests/server/*.test.ts`

The spec's scenarios are good candidates for test coverage:

- **Generate user docs:** one page per spec with frontmatter including `generated: true`, and no scenarios or security notes in the output.
- **Root docs stay in sync:** the marked section is replaced exactly once, hand-written text is unchanged, and a generation failure modifies no root file.
- **One spec fails:** the other four pages are written, and the exit is non-zero only if all five failed.
- **On-demand user docs:** two simultaneous requests cause one fast-model call and a cache hit on repeat.
- **Agent briefing:** a compact structured document, and an unknown audience gives a client error.
- **Web UI:** it reads everything from `/api/v1` and is reachable only locally.

<a id="security-and-data"></a>
## Security and data

- Spec text sent to the LLM passes through the configured redaction, and user docs receive only non-internal sections.
- Credentials must not appear in docs, root-file sections, or served data.
- Marked-section replacement touches only text between the markers.
- The server is read-only, with no endpoint that mutates state or runs commands. It binds loopback by default and enforces the Host-header guard against DNS rebinding.
- Remote binding needs an explicit `--allow-remote` with `--host`. The API has no authentication, and exposing it beyond localhost is not covered by this spec.
- LLM spend is bounded per request. Cache keys include the content hash, so stale or tampered text is not served as current.
- UI and response headers are as specified in `serve-host-guard`, `html-headers` and `ui-escapes-markdown`.

<a id="extending-it"></a>
## Extending it

The spec supports these extension points:

- **Add a guide.** Create a `kind: journey` spec under `specs/guides/` with the required frontmatter, then run `specguard docs build` and commit the regenerated user and developer guides, reference pages, index, manifest and help topics. Any `specguard <command>` in a shell block must exist in the CLI, or `check` warns `guide-unknown-command`. Any `related` ids must be real capability ids.
- **Add a help topic.** Add a line to the `## Help Topics` section of a guide or capability spec. Keys must be unique. In a capability spec the heading must be `Why it exists`, `What you can do` or `What to expect`.
- **Change what a rewrite looks like.** Changing the prompt version or model invalidates cached served docs, because both are part of the cache key. Plugin renderers are also part of the key.
- **Swap the cache.** Caching sits behind a cache interface, with files as the default.
- **Add headings to generated pages.** Keep the anchor rules (`doc-anchors-stable`), so slugs depend only on heading text and re-anchoring stays idempotent.
- **Keep builds deterministic.** Anything written by `docs build --no-llm` must be byte-identical across runs, or `--check` reports drift.
- **Add endpoints.** Keep them `GET`-only and read-only, route responses through redaction, and apply the standard headers. Not covered here: the spec does not define a process for new audiences beyond `user`, `dev` and `agent`.
