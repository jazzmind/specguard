---
id: documentation-api
kind: capability
title: Documentation and API
parent: system
value: Anyone, human or AI, can read accurate documentation of the system as it is now, pitched at their level, generated from the specs on request and delivered over an API.
status: active
sources:
  - "src/core/state/content-cache.ts"
  - "src/core/slug.ts"
  - "src/core/guides.ts"
  - "src/pipelines/doc-build.ts"
  - "src/pipelines/doc-generate.ts"
  - "src/core/root-doc-sync.ts"
  - "src/cli/commands/docs.ts"
  - "src/server/**"
  - "src/cli/commands/serve.ts"
tests:
  - "tests/pipelines/doc-generate.test.ts"
  - "tests/pipelines/doc-build.test.ts"
  - "tests/core/guides.test.ts"
  - "tests/core/slug.test.ts"
  - "tests/server/*.test.ts"
docs:
  - "README.md"
  - "docs/guide/**"
  - "docs/dev/**"
  - "docs/index.md"
history:
  - 2026-10-15-functional-specs-and-four-pillars
  - 2026-10-22-0-3-phase-1-workspace-ignore-sync-and-co
  - 2026-10-22-security-hardening-from-audit-sast-and-p
  - 2026-10-22-header-role-fix-and-spec-level-security
  - 2026-10-22-security-prompt-injection-via-spec-conte
  - 2026-10-22-security-no-requirement-classifying-what
  - 2026-10-22-security-no-rate-limit-on-api-endpoints
  - 2026-11-06-docs-are-generated-from-guide-specs-and
---

# Documentation and API

## Problem & Value
Documentation goes stale the moment code changes, and hand-written docs rarely keep up. A single static document also cannot serve everyone: end users want to know what the system does, developers want to know where and how, and AI agents want compact, structured context they can load cheaply. Teams end up with docs that are wrong, or with several copies written for different readers that disagree.

Because the specs are kept current and traceable to code and tests, they are the right source for documentation. This capability rewrites specs into readable docs with an LLM, keeps marked sections of the repository's front-door files in sync, and exposes audit views such as the traceability matrix. SpecGuard also documents itself with this capability: guide specs under `specs/guides/` (what it is, quickstarts by use case, developer guides) and its capability specs are built into a committed documentation set, with help text for the editor's dashboards, so the product's own how-to docs cannot drift from its specs. The main planned direction is a read-only API and small web UI, `specguard serve`, that generates user, developer and agent documentation on demand from the specs with a fast model, so what a reader sees always reflects the current specs.

## Users & Journeys
- A product owner runs `specguard docs --all` to produce user-facing pages under `docs/user/`, each with a category and reading order for a docs site.
- A maintainer runs `specguard docs` and finds the architecture, commands and pipeline sections of `README.md`, `CLAUDE.md` and `AGENTS.md` refreshed without touching hand-written text.
- An auditor opens the traceability matrix and audit data as documents to review how requirements map to tests and docs.
- a viewer application calls `GET /api/v1/docs/user/<capability>` and renders current, user-level documentation without any build step.
- a coding agent calls `GET /api/v1/docs/agent/system` to load a compact structured briefing before changing code.
- a developer opens the bundled web UI at `http://localhost:<port>/` to browse capabilities, their trace and their history.
- a maintainer writes or edits a guide spec (`specs/guides/*.md`), runs `specguard docs build`, and commits the regenerated user and developer guides, capability reference pages, index, manifest and help topics.
- a new user opens `docs/index.md` (or the editor's help panel) and finds what SpecGuard is, then a quickstart for their situation.
- a dashboard help icon reads its popover text and target section from `docs/help-topics.json`, which is built from the `## Help Topics` sections of the specs.
- CI runs `specguard docs build --check` and fails when a page is older than its spec.

## Requirements
- [ ] `docs` rewrites a single spec, all specs or one app's specs into user-facing Markdown pages under `docs/user/` (or a chosen output directory), mirroring the spec's relative path. <!-- claim: docs-per-spec -->
- [ ] Internal-only content (the metadata comment, scenarios and security notes) is removed before the LLM sees the spec, and the rewrite must stay accurate to the supplied spec without inventing features. <!-- claim: docs-strip-internal -->
- [ ] Each generated page starts with frontmatter holding a title, sidebar label, description, category, reading order and a flag marking it as generated. <!-- claim: docs-frontmatter -->
- [ ] Generated docs are regenerable artifacts that overwrite existing files, an LLM failure on one spec is recorded and does not stop the others, and the command fails only if every attempted spec failed. <!-- claim: docs-failure-isolation -->
- [ ] After per-spec docs are generated, marked sections of `README.md`, `CLAUDE.md` (only if it exists) and `AGENTS.md` are replaced between start and end markers, appended when absent, and hand-written content outside the markers is never altered. <!-- claim: root-doc-sync-sentinels -->
- [ ] `AGENTS.md` is created from a template when missing and only its marked sections are updated when present, and a failure to generate the section text logs the error and writes nothing. <!-- claim: root-doc-sync-safe -->
- [ ] LLM credentials never appear in any generated page or synchronised section. <!-- claim: docs-no-secrets -->
- [ ] The traceability matrix and audit data produced by the audit commands are plain JSON or CSV files under `.specguard/` that viewers and auditors can load as documents. <!-- claim: audit-data-as-documents -->
- [ ] `specguard serve` starts a read-only HTTP server on `node:http` bound to localhost under `/api/v1`, with no endpoint that writes, runs a pipeline or executes code; a malformed request target or percent-encoding is answered with 400 and never stops the server. <!-- claim: serve-readonly -->
- [ ] `GET /system`, `/capabilities`, `/capabilities/:id` and `/capabilities/:id/history` return the system spec, the capability list with their value statements, one capability's parsed content, and its requirement history. <!-- claim: spec-endpoints -->
- [ ] `GET /trace`, `/audit` and `/security/plans` return the traceability data, the audit views and the stored remediation plans in their existing stable JSON shapes. <!-- claim: audit-endpoints -->
- [ ] `GET /docs/:audience/:id` and `/docs/:audience/system` return generated documentation for the audience `user`, `dev` or `agent`, and an unknown audience or capability returns a clear 400 or 404 error. <!-- claim: docs-endpoints -->
- [ ] the user audience omits claims and internals, the dev audience adds sources, interfaces and tests, and the agent audience is a compact structured form that can be parsed without reading prose. <!-- claim: audience-shapes -->
- [ ] documentation is generated on demand with the fast model tier, never in the background, and responses are complete documents rather than streams. <!-- claim: fast-tier-on-demand -->
- [ ] generated documents are cached (behind a cache interface, files by default) by spec content hash, audience, prompt version, model and the enabled plugin renderers, so an unchanged spec is served from cache and an edited spec, a changed prompt version or a different model regenerates it. <!-- claim: cache-key -->
- [ ] concurrent requests for the same uncached document share one LLM call (single-flight), different documents generate concurrently, and each generation runs in its own LLM scope with its own budget (a spent budget fails that request with a clear error and never affects or resets another) and with the requester's name sent to the model gateway for spend attribution. <!-- claim: single-flight-budget -->
- [ ] a small static web UI served at `/` lets a person browse the system, capabilities, trace and generated docs using only the API. <!-- claim: static-ui -->
- [ ] served documents and data are redacted so credentials and secret values from specs, config or history never leave the server. <!-- claim: served-redaction -->
- [ ] On a loopback address the server rejects any request whose Host header is not a local name (blocking DNS-rebinding reads from a hostile page), answers with `nosniff`, no-store and a content security policy on the UI, and sends cross-origin headers only when `--cors` names an origin <!-- claim: serve-host-guard -->
- [ ] The web UI escapes all HTML in model-written markdown and links only http(s), site-relative and anchor URLs, so generated docs cannot inject script <!-- claim: ui-escapes-markdown -->
- [ ] When the model is unavailable the user and dev audiences are rendered directly from the spec with a warning and are not cached, so the next request tries the model again; a spent LLM budget is reported as HTTP 429 instead <!-- claim: docs-model-fallback -->
- [ ] The HTML page of both servers cannot be framed (`frame-ancestors 'none'` and `X-Frame-Options: DENY`), cannot set a base URL, load an object or post a form to another origin, and sends no referrer; JSON responses carry `nosniff` and `no-store` <!-- claim: html-headers -->
- [ ] `specguard serve` binds loopback unless `--allow-remote` is given with `--host`, because its API has no authentication and is read-only for the person who started it; without the flag a wider address is refused with a message that points to `specguard server`, and a host name that merely starts with `127.` is not loopback <!-- claim: serve-bind-loopback -->
- [ ] A guide is a `kind: journey` spec under `specs/guides/` with frontmatter `id`, `title`, `audience` (`user` or `dev`), `order`, an optional `useCase` and `related` capability ids; guides load in the spec graph without needing sources, tests or a Problem & Value section, and do not appear as capabilities. <!-- claim: guide-specs -->
- [ ] `check` validates guides and help topics as warnings: `guide-unknown-command` for a `specguard <command>` in a shell block that the CLI (including built-in plugin commands) lacks, `guide-unknown-related` for a related id that is not a capability, `help-duplicate-key` for a key defined twice, and `help-unknown-anchor` for a topic whose section is not on its page. <!-- claim: guide-validation -->
- [ ] A `## Help Topics` section is parsed from guide and capability specs, one line per topic as key, section heading and one-line text, and `docs build` writes `docs/help-topics.json` mapping each key to its title, text, page and anchor, falling back to the top of the page when the section is missing. <!-- claim: help-topics-from-specs -->
- [ ] `specguard docs build` builds the documentation set from the specs: user guides under `docs/guide/`, developer guides under `docs/dev/`, a capability reference page for each audience under `docs/guide/reference/` and `docs/dev/reference/`, `docs/index.md` grouped as Start here, Quickstarts, Reference and Developer, and `docs/manifest.json` listing every page with its sections and source hash. <!-- claim: doc-set-build -->
- [ ] Every heading outside a code fence in a generated page is preceded by an `<a id="slug"></a>` line, slugs are unique within the page and depend only on the heading text, and anchoring an already anchored page changes nothing. <!-- claim: doc-anchors-stable -->
- [ ] With `--no-llm` two builds produce byte-identical files, and a capability reference page whose spec is unchanged since the manifest's recorded source hash is kept rather than regenerated, so only edited specs cost a model call. <!-- claim: doc-build-deterministic -->
- [ ] `specguard docs build --check` writes nothing and calls no model; it exits with the drift exit code and names each page when a page's spec hash differs from the manifest, a page is missing, or a deterministic file differs, and `check` warns `docs-stale` when any page is older than its spec. <!-- claim: docs-freshness-check -->

## Scenarios
### Scenario 1: Generate user docs
**Steps:**
1. A repository has capability specs.
2. A developer runs `specguard docs --all`.

**Expected Results:**
- One Markdown page per spec is written under `docs/user/`.
- Each page has frontmatter with title, category, order and `generated: true`.
- Scenarios and security notes do not appear in the page.

### Scenario 2: Root docs stay in sync without losing hand-written text
**Steps:**
1. `README.md` has hand-written intro text and an existing marked architecture section.
2. `specguard docs --all` runs.

**Expected Results:**
- The marked section is replaced exactly once with new text.
- The hand-written text is unchanged.
- If section text generation fails, no root file is modified and the run continues.

### Scenario 3: One spec fails to document
**Steps:**
1. The LLM errors for one of five specs.
2. `specguard docs --all` runs.

**Expected Results:**
- The failure is recorded and the other four pages are written.
- The command exits non-zero only if all five failed.

### Scenario 4: on-demand user docs
**Steps:**
1. A viewer requests `GET /api/v1/docs/user/traceability-and-drift`.
2. Another viewer requests the same document at the same moment.

**Expected Results:**
- One fast-model call is made and both receive the same non-streamed document without claims or internals.
- A repeat request is served from cache until the spec text or prompt version changes.

### Scenario 5: agent briefing
**Steps:**
1. An agent requests `GET /api/v1/docs/agent/system`.

**Expected Results:**
- The response is a compact structured document listing capabilities, their value and their interfaces.
- An unknown audience returns a clear client error.

### Scenario 6: browsing in the web UI
**Steps:**
1. A developer runs `specguard serve` and opens `http://localhost:<port>/`.

**Expected Results:**
- The UI lists capabilities and shows each one's trace, history and generated docs, all read from `/api/v1`.
- The server is reachable only from the local machine.

## Help Topics
- `docs.build` → What to expect: Documentation pages are built from the specs; after you change a spec, run `specguard docs build` and commit the result.

## Security & Data Considerations
Documentation generation sends spec text to the LLM, so it passes through the configured redaction, and only non-internal sections are sent for user docs. Credential values must not be written into docs or root-file sections. Marked-section replacement touches only the text between markers so hand-written content cannot be overwritten. The planned server is read-only, binds to localhost by default and has no endpoint that mutates state or runs commands. Its LLM spend is bounded per request, and cached documents are keyed by content hash so stale or tampered text is never served as current. Exposing the server beyond localhost requires an explicit choice and is not covered by this spec.

## Interfaces
- CLI: `specguard docs [--spec <key>] [--all] [--out <path>] [--app <name>]`, printing a summary line `docs: <N> created, <N> skipped, <N> failed`.
- CLI: `specguard docs build [--no-llm] [--check] [--out <dir>]`, the documentation set; `--check` exits 3 (drift) when a page is out of date.
- Files: `docs/guide/*.md`, `docs/dev/*.md`, `docs/guide/reference/<id>.md`, `docs/dev/reference/<id>.md`, `docs/index.md`, `docs/manifest.json` (`version`, `pages[]` with `id`, `title`, `audience`, `group`, `file`, `sections[]`, `sourceHash`, `generator`) and `docs/help-topics.json` (key to `title`, `text`, `page`, `anchor`).
- Spec syntax: a guide's `## Help Topics` section with lines ``- `key.name` → Section Heading: one-line popover text``; the heading names a section of the guide's own page, or, in a capability spec, one of `Why it exists`, `What you can do`, `What to expect`.
- MCP tool: `specguard_docs` (and `specguard_matrix` for the matrix document).
- Files: `docs/user/<feature>.md` (the legacy `docs` command's default output) with frontmatter (`title`, `sidebar_label`, `description`, `category`, `order`, `generated`); marked sections `<!-- specguard:<key>:start -->` and `<!-- specguard:<key>:end -->` in `README.md`, `CLAUDE.md` and `AGENTS.md`; `.specguard/traceability.json` and audit data.
- CLI: `specguard serve [--port <n>] [--host <addr>] [--cors <origin>]`.
- HTTP (GET only, under `/api/v1`): `/system`, `/capabilities`, `/capabilities/:id`, `/capabilities/:id/history`, `/trace`, `/audit`, `/docs/:audience/:id`, `/docs/:audience/system`, `/security/plans`; static UI at `/`.
- Config: the fast model tier from `llm.models.fast`, and a per-request budget.
- Exit codes: 0 success, non-zero when every attempted document failed.

## Out of Scope
- Hosting a general public documentation site; the API is for viewers to render from.
- Authentication and multi-user access control for the planned server.
- Streaming responses and editing documents through the API.
- Producing the traceability matrix itself (see traceability-and-drift).
