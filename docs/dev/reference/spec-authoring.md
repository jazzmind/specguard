---
title: "Spec Authoring (developer reference)"
audience: dev
source: "specs/capabilities/spec-authoring.md"
generated: true
---
<a id="spec-authoring"></a>
# Spec Authoring

<a id="purpose"></a>
## Purpose

Spec Authoring gives a team an accurate, machine-checked set of functional specs for its system. It can create the specs from existing code or documents and keep them consistent as the system grows. The other SpecGuard capabilities build on it.

It covers four things:
- It defines the spec format: a master system spec, functional capability specs, and optional components and journeys.
- It gives each requirement a stable claim id.
- It records which code each spec owns.
- It validates the whole set as a tree.

It also bootstraps specs from existing code (`reverse`, `spec draft`, `spec consolidate`) or from outside documents (`import`), so a brownfield system can adopt spec-driven development quickly.

Out of scope, handled elsewhere:
- Judging whether code satisfies a spec (traceability and conformance capabilities).
- Recording the prompts and plans behind a spec (requirement-history).
- Rendering specs as user or developer documentation.
- Specs that describe third-party dependencies.

<a id="responsibilities"></a>
## Responsibilities

- **Parse specs.** Read YAML frontmatter (v2) or the older HTML-comment metadata block (v1) into a title, named sections, scenarios and claims.
- **Identify specs and claims.** Give every spec one canonical key, and give every requirement bullet a stable claim id.
- **Resolve ownership.** Resolve declared `sources` globs and answer which specs own which files.
- **Validate.** Check the spec tree (`spec graph`), the claim catalog (`claims list`) and claim testability (the testability lint).
- **Generate specs.** Draft specs from code (`reverse`, `spec draft`), from documents (`import`) and from existing per-file specs (`spec consolidate`).
- **Keep specs current.** Refresh the Capability Map (`spec index`), add missing requirements from a document (`import --capability`), and produce an architecture index (`index`).
- **Link tests.** Tag existing tests with the claims they exercise (`spec tag`), either in the test sources or in a separate index file.
- **Support examples.** Parse example tables under claims, give each row a hash, and attribute parameterized tests to rows.

<a id="interfaces"></a>
## Interfaces

<a id="cli"></a>
### CLI

| Command | Notes |
|---|---|
| `specguard reverse [--app <name>\|--all] [--file <path>] [--force] [--collapse <globs>]` | One of `--app` or `--all` is required. |
| `specguard import <file\|url> [--app] [--out] [--force]` | Also `--single`, `--capability <id>`, `--yes` and `--allow-private`, described in the requirements. |
| `specguard index [--app] [--force]` | Writes the architecture index. |
| `specguard claims assign [--dir] [--dry-run]` | Adds missing claim ids. |
| `specguard claims list [--workspace]` | Prints the claim catalog. |
| `specguard spec graph` | Prints and validates the spec tree. |
| `specguard spec draft [--yes] [--from-map] [--force] [--history <ids...>] [--guidance <text>]` | Proposes a capability map. |
| `specguard spec consolidate [--yes] [--from-map] [--force] [--no-archive] [--rewrite-source-refs] [--guidance <text>]` | Migrates per-file specs into capability specs. |
| `specguard spec index` | Refreshes the Capability Map region. |
| `specguard spec tag [--spec <id>] [--yes] [--list] [--index <file>]` | Links tests to requirements. |

<a id="spec-files"></a>
### Spec files

- Specs live in `specs/**/*.md` with YAML frontmatter (v2) or an HTML-comment metadata block (v1).
- Claim anchors are an HTML comment holding `claim:` and a kebab-case id.
- Claim refs are `specKey#claimId`, `repo:specKey#claimId`, or either form with a trailing `/<rowId>`.

<a id="config-keys"></a>
### Config keys

- `paths.specsRoot`
- `apps[].specDir`, `apps[].sources`, `apps[].exclude`, `apps[].collapse`
- `granularity.target`, `granularity.maxCapabilities`
- the top-level `testability` block

<a id="exit-codes"></a>
### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | Internal error or missing flags. |
| 2 | Validation failure: graph errors, dangling or duplicate claims. |

<a id="requirements"></a>
## Requirements

<a id="format-parsing-and-identity"></a>
### Format, parsing and identity

- **application-organization**: Application features and specs have logical groups and explicit presentation order, independent of filenames and stable identities. The editor can draft, edit and reorder that organization. Unassigned application entries default to the nearest workspace journey step ordering, and explicit application choices are preserved.
- **frontmatter-v2-metadata**: A spec may declare its metadata in YAML frontmatter (id, kind, title, parent, value, status, sources, tests, docs, history). Frontmatter is read first, and specs that use the older HTML-comment metadata block still parse unchanged.
- **frontmatter-errors**: Invalid frontmatter fails with an error that names the file. Invalid means bad YAML, a kind other than system, capability, component or journey, a non-string where a string is required, or a list of non-strings. The error explains that lists must be block lists with quoted globs.
- **sections-and-scenarios**: A spec parses into a title, named sections, scenarios (name, numbered steps, expected-result bullets) and claims. Missing sections yield empty values rather than errors, and unknown metadata keys are preserved. `Requirements` is accepted as the preferred name for `Acceptance Criteria`.
- **spec-discovery**: Discovery walks the specs tree recursively for markdown files. It ignores `README.md` files, the requirement-history folder and archived v1 specs. Parsing never touches the network or the filesystem beyond reading files.
- **canonical-spec-key**: Every spec has one canonical key, used identically by claims, proofs, drift, the matrix and status. The key is the path relative to the specs root without the extension, or the owning app's spec directory when there is no specs root.
- **declared-sources**: A spec's `sources` globs are resolved relative to the owning app's repo. A pattern that matches nothing there but matches from the config root is accepted with a one-time warning per pattern.

<a id="claims"></a>
### Claims

- **claim-anchors**: A requirement bullet carries its stable id in a trailing claim comment. Bullets without one remain visible as unanchored. Reordering bullets never changes what an id refers to.
- **claims-assign**: `claims assign` adds an id to every requirement bullet that lacks one. It never rewrites an existing id and is idempotent. Generated ids are lowercase unique slugs of at most six words and 48 characters. `--dry-run` reports the ids without writing.
- **claims-list-gate**: `claims list` prints the claim catalog, optionally across every repo in the workspace. It exits 2 when a journey cites a claim that does not exist or a spec repeats a claim id.
- **journey-specs**: A journey spec declares its world, actors and goals, invariants and budget. Each invariant lists the claim references it verifies, as `specKey#claimId` or `repo:specKey#claimId`.

<a id="spec-graph"></a>
### Spec graph

- **graph-tree**: Every spec is arranged as a tree (system, capability, component). A capability with no parent is attached to the system, and v1 specs stay as untyped nodes. `spec graph` prints each node with its kind, owned-file count and claim count.
- **graph-file-ownership**: The graph answers which specs own a given file (zero, one or several) and which files are unowned. It uses declared sources only and ignores dependency and build directories.
- **graph-validation**: `spec graph` exits 2 on any error.
  - Errors: a missing or multiple system spec, a missing id, an id that differs from the file name, a duplicate id, an unknown parent, a parent cycle, a wrong parent kind, a duplicate claim id, and a missing Problem & Value section.
  - Warnings: a spec whose sources match no files, and a capability count above the configured maximum.

<a id="generating-specs"></a>
### Generating specs

- **reverse-per-source**: `reverse` requires `--app <name>` or `--all` and exits 1 with a message otherwise. It generates specs from the app's discovered source files and skips existing specs unless `--force`. `--file` handles one source file. It ends with a created/updated/skipped/failed summary.
- **reverse-safety**: `reverse` keeps going when one spec or app fails and exits with the last non-zero code. It caps each file sent to the model at 20,000 characters and never walks dependency or build directories. It warns about source files that look like they contain secrets, and instructs the model not to reproduce them.
- **import-documents**: `import` converts a local markdown or text file, or an http(s) URL, into spec files.
  - A multi-section document is decomposed into focused specs unless `--single` or `--out` is given.
  - Existing specs are skipped unless `--force`.
  - The summary and exit code reflect created, skipped and failed items.
- **index-generation**: `index` writes an architecture index at the root of the specs tree. It lists routes or endpoints grouped by area, plus a spec directory map. It finds the routing source through the app's entry points or detected framework. An existing index is left alone unless `--force`. If the model call fails, it writes a skeleton index instead of failing.
- **spec-draft-proposes-map**: `spec draft` works in stages.
  - It inventories the code and summarises each file with the fast model, cached by content hash.
  - It clusters the files into about 8 to 15 functional capabilities, honouring `granularity.target` and any `--guidance`. If the count misses the target it retries once, without losing the guidance.
  - It writes a reviewable capability map to `.specguard/spec-map.json` and `.md`, outside `plans/`, and stops there unless `--yes` is given.
  - `--from-map` continues from the edited map and writes one spec per capability plus the system spec.
- **spec-index-refreshes-map**: `spec index` regenerates only the marked Capability Map region of the system spec from the spec graph and leaves the rest of the file untouched. `import <file> --capability <id>` adds only the requirements the document states that the capability does not already cover. It is a dry run unless `--yes`. It appends the requirements with unique claim anchors and records a history entry for what it changed.
- **spec-consolidate-migrates-state**: `spec consolidate` clusters existing per-file specs into capability specs.
  - Every old spec must be assigned to exactly one capability. Otherwise it stops and lists the unassigned ones.
  - Requirements are merged with unique claim ids that never use numeric suffixes.
  - Every old claim with an id that the model did not absorb is carried over. A bullet that never had an id has no reference to preserve and is superseded by the model's functional requirements.
  - It rewrites claim tags in tests, rekeys the proof ledger and drift registry, and archives the old specs under `_archive/v1`.
  - It writes `.specguard/claim-migration.json` so results carrying old tags are still accepted on ingest.

<a id="linking-tests"></a>
### Linking tests

- **spec-tag-links-tests**: For each capability, `spec tag` shows the model its requirements and the leaf tests in the files its `tests:` globs name. The model says which requirements each test clearly exercises. Rules:
  - Only real requirement ids and test numbers survive.
  - A `[claims: ...]` comment is written above the test in the file's comment style.
  - A test that is already tagged is never touched.
  - Two capabilities citing one test are merged into one comment.
  - The run is a dry run unless `--yes`.
  - It reports which requirements no test covers.
- **spec-tag-java-tests**: `spec tag` finds Java and Kotlin tests (`.java`, `.kt`).
  - **What counts as a test:** a method after a JUnit 5, JUnit 4 or TestNG test annotation (`@Test` with or without arguments, `@ParameterizedTest`, `@RepeatedTest`, `@TestFactory`, `@TestTemplate`). Other annotations, blank lines and comments may sit between the annotation and the method.
  - **Title:** the `@DisplayName` value if present, otherwise the method name.
  - **Not tests:** imports, annotations in comments, and other `@Test...` annotations such as `@TestInstance`.
  - **Comment placement:** the claim comment goes above the first annotation, not between annotation and method. A tag in that position counts as already tagged.
- **spec-tag-index-mode**: `spec tag --index <file>` never modifies test sources, so tests in another repo can be linked from a specs-only overlay.
  - **Writing:** with `--yes` it writes or merges a plain-text index at a path relative to the config root. Each line is `<test-file>:<line> :: <title>  [claims: <ref>, <ref>]`, and the test path is relative to the config root (it may start with `../`).
  - **Merging:** a line for the same `file:line :: title` is replaced, other lines are kept, and entries are sorted.
  - **Skipping known tests:** a test the index already lists, by `file:line` or by file and title (so a moved test is still known), is not offered to the model again.
  - **Coverage:** listing the index in `tests:` or `extraTestSources` makes the check count its claims as tested.

<a id="import-safety"></a>
### Import safety

- **import-ssrf**: `import <url>` reaches only public addresses.
  - SpecGuard resolves the host itself. It refuses every loopback, private, link-local (including the cloud metadata address), carrier-grade, multicast, unique-local and IPv4-mapped or translated address, even when only one of several answers is private.
  - The connection goes to the address that was checked.
  - Each redirect is checked the same way, and at most five redirects are followed.
  - It refuses an https to http redirect, credentials in the URL, and an answer over 5 MB.
  - `--allow-private` is the only way to import from your own network.
- **import-project-files**: When `import` is called through the MCP server, a file source must be inside the project (symlinks resolved first) and a URL may not reach a private address. An agent therefore cannot read `~/.ssh/id_rsa` or an internal URL into a spec.

<a id="example-tables"></a>
### Example tables

- **example-tables**: A markdown table directly under a claim bullet gives that claim example rows. The table may be indented or at column 0, with only blank lines or the bullet's continuation lines between bullet and table.
  - It needs a header row and a separator row.
  - Each row's id comes from the column headed `id` (any case), or else the first column. The id must be lower-case words joined by hyphens and unique within the claim.
  - `\|` is a literal pipe.
  - One table is allowed per claim.
  - Tables are ignored in v1 specs.
- **claim-hash-unchanged-by-tables**: A table line never becomes part of the claim text. Adding, removing or editing an examples table leaves the claim hash unchanged, and the hash of every claim in this repository's specs is the same as before tables existed.
- **example-row-hashes**: Each example row has a hash built from the claim hash and its sorted `header=cell` pairs. It ignores whitespace and column order. It changes when a cell changes or when the claim text changes.
- **example-table-issues**: A malformed examples table is reported with its line number, and a bad row is skipped while the readable rows are kept.
  - Errors: `EX-NO-SEPARATOR`, `EX-NO-ID-COLUMN`, `EX-BAD-ID`, `EX-DUP-ID`, `EX-CELL-COUNT`, `EX-MULTIPLE-TABLES`, `EX-CLAIM-NO-ID`.
  - Warnings: `EX-EMPTY`, and `EX-ORPHAN-TABLE` (a table after prose or before the first claim).
- **claim-row-refs**: A claim ref may end in `/<row id>` (`specKey#claimId/rowId`, with or without a `repo:` prefix). `parseClaimRef`, `formatClaimRef` and every claim tag form (`@claim:`, `[claim: ]`, `[claims: ]`) read and write the row. A ref with an invalid row id is rejected, and refs without a row behave as before.
- **example-title-matching**: A parameterized test whose title contains exactly one row id of its claim is attributed to that row as well as to the claim. The match is on a whole token, so `ny` never matches inside `ny-small`. A title with two or more row ids attributes nothing and is reported as ambiguous.

<a id="assurance-evidence-and-testability"></a>
### Assurance, evidence and testability

- **assurance-evidence-frontmatter**: `assurance:` frontmatter takes a level, or a default plus per-claim levels, from `tested`, `property`, `bounded`, `proved-model`, `proved-code`. `evidence:` maps a claim id to `kind` (`agentic` or `manual`) and `verifier`.
  - Values off the ladder are kept in `unknown`.
  - A missing verifier is kept as an empty string so the lint reports it.
  - An evidence kind other than the two fails with the file name.
  - Neither key changes a claim hash.
- **testability-lint**: The lint reports per claim and rule, matches whole tokens only (after removing code spans, quoted literals and URLs), is deterministic, and never calls a model.
  - Errors:
    - a missing claim id
    - fewer than three words
    - placeholders (`TBD`, `TODO`, `FIXME`, `XXX`, `??`, `lorem ipsum`)
    - outcome words with no test oracle (`properly`, `should work`, `as expected`)
    - open-ended lists (`etc`, `and/or`)
    - malformed example tables
    - evidence without a verifier, or at a layer that must be automated
    - unknown assurance or layer names
  - Warnings:
    - hedges
    - subjective terms without a number
    - passive handling verbs
    - a claim with no observable outcome
    - more than three clauses
    - more than 80 words
    - varying behaviour with no examples table
- **testability-config**: The top-level `testability` block configures the lint.
  - It overrides a rule's severity (`off`, `warn`, `error`).
  - `allow` adds phrases that are never flagged, and `deny` adds terms that are errors.
  - `maxClauses` and `maxWords` set the limits.
  - `waive` lists rules per claim ref. A waived rule downgrades an error to a warning marked waived, for that claim only.
  - An unknown rule id or a non-positive limit is rejected when the config loads.

<a id="code-map"></a>
## Code map

Owned files: 27, declared as `sources` in the spec.

| Area | Files |
|---|---|
| Parsing, keys, claims, examples, lint, graph | `src/core/spec-parser.ts`, `src/core/spec-key.ts`, `src/core/claims.ts`, `src/core/examples.ts`, `src/core/testability.ts`, `src/core/spec-graph.ts` |
| Capability map, rendering, migration | `src/core/spec-map.ts`, `src/core/spec-render.ts`, `src/core/claim-migration.ts` |
| Test declarations, safe fetch | `src/core/test-declarations.ts`, `src/core/safe-fetch.ts` |
| Reverse, import, index, claims, graph report | `src/pipelines/reverse-generate.ts`, `src/pipelines/import.ts`, `src/pipelines/import-capability.ts`, `src/pipelines/index-generate.ts`, `src/pipelines/claims.ts`, `src/pipelines/spec-graph-report.ts` |
| Draft, synthesis, consolidate, index, tag | `src/pipelines/spec-draft.ts`, `src/pipelines/spec-synth.ts`, `src/pipelines/spec-consolidate.ts`, `src/pipelines/spec-index.ts`, `src/pipelines/spec-tag.ts` |
| CLI commands | `src/cli/commands/reverse.ts`, `import.ts`, `index.ts`, `claims.ts`, `spec.ts` |

<a id="tests"></a>
## Tests

Declared `tests:` globs:

- `tests/core/experience.test.ts`
- `tests/core/spec-parser.test.ts`
- `tests/core/spec-frontmatter.test.ts`
- `tests/core/spec-key.test.ts`
- `tests/core/claims.test.ts`
- `tests/core/claim-tags.test.ts`
- `tests/core/claim-hash-stability.test.ts`
- `tests/core/examples.test.ts`
- `tests/core/testability.test.ts`
- `tests/core/spec-graph.test.ts`
- `tests/core/claim-migration.test.ts`
- `tests/core/test-declarations.test.ts`
- `tests/pipelines/spec-*.test.ts`
- `tests/pipelines/reverse-generate.test.ts`
- `tests/pipelines/import.test.ts`
- `tests/pipelines/import-capability.test.ts`

The spec's scenarios describe the behaviour these tests should exercise:
- Adopting specs on an existing codebase, including a second run that skips existing specs and calls no model.
- Importing a multi-section PRD, then re-running without `--force`.
- Validating the tree: `id-filename` and `unknown-parent` errors, exit 2, then a clean run.
- A dangling journey claim failing `claims list --workspace` with exit 2.
- File ownership with overlapping globs and unowned files.
- A flow-list `sources:` producing an error that names the file.

<a id="security-and-data"></a>
## Security and data

- **LLM data flow.** `reverse` and `import` send source code or document text to the configured LLM provider. They run through the shared LLM layer (budget caps, redaction, replay) and instruct the model never to reproduce secret values. `reverse` warns before sending a file that matches secret patterns. `import` must not forward credentials found in a document to the model.
- **Network.** `import` fetches only http and https URLs and refuses other schemes. The SSRF protections are in **import-ssrf**, and the MCP restrictions are in **import-project-files**.
- **Writes.** Generated files are written only inside the repo's spec directories, or the explicit `--out` path.
- **Parsing.** It is pure and executes no code from specs.
- **Redirect limit inconsistency.** The spec's Security section says `import` follows at most one redirect, while the **import-ssrf** requirement says at most five. Resolve this against the code in `src/core/safe-fetch.ts` before relying on either figure.

<a id="extending-it"></a>
## Extending it

The spec does not define formal extension points. The points below follow from its requirements.

- **Adding a requirement to a capability:**
  1. Add the bullet under `Requirements`.
  2. Run `specguard claims assign` (use `--dry-run` first to preview ids). Existing ids are never rewritten.
  3. Cite the new id from tests with a claim tag, or let `spec tag` propose links. Use `--index <file>` if the tests live in another repo.
  4. Run `specguard spec graph` and `specguard claims list --workspace` to check the tree and the catalog.
- **Adding metadata:** unknown metadata keys are preserved by the parser, but only the documented frontmatter keys have defined behaviour. Lists must be block lists with quoted globs.
- **Covering varying behaviour:** put an examples table directly under the claim. It needs a header, a separator and unique hyphenated row ids, and it does not change the claim hash. A parameterized test title should contain exactly one row id to be attributed to that row.
- **Tuning the testability lint:** use the `testability` config block (severity, `allow`, `deny`, limits, per-claim `waive`) rather than weakening claim text. Rule ids and limits are validated at config load.
- **Adding a capability:** create a spec with matching `id` and file name and a valid `parent`, and give it a Problem & Value section. For a capability with no parent, the graph attaches it to the system spec. Keep the count under `granularity.maxCapabilities` to avoid a warning. Run `specguard spec index` to refresh the Capability Map.
- **Changing claim-bearing behaviour:** keep claim hashes stable for existing claims. The requirement **claim-hash-unchanged-by-tables** and the `claim-hash-stability` tests guard this. Changes to ids or keys must stay consistent with **canonical-spec-key**, since claims, proofs, drift, the matrix and status all use the same key.
