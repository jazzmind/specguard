---
id: spec-authoring
kind: capability
title: Spec Authoring
parent: system
value: Teams get an accurate, machine-checked set of functional specs for their system, created from existing code or documents and kept consistent as it grows.
status: active
sources:
  - "src/core/spec-parser.ts"
  - "src/core/spec-key.ts"
  - "src/core/claims.ts"
  - "src/core/examples.ts"
  - "src/core/testability.ts"
  - "src/core/spec-graph.ts"
  - "src/pipelines/reverse-generate.ts"
  - "src/pipelines/import.ts"
  - "src/pipelines/import-capability.ts"
  - "src/pipelines/index-generate.ts"
  - "src/pipelines/claims.ts"
  - "src/pipelines/spec-graph-report.ts"
  - "src/cli/commands/reverse.ts"
  - "src/cli/commands/import.ts"
  - "src/cli/commands/index.ts"
  - "src/cli/commands/claims.ts"
  - "src/cli/commands/spec.ts"
  - "src/core/spec-map.ts"
  - "src/core/spec-render.ts"
  - "src/core/claim-migration.ts"
  - "src/pipelines/spec-draft.ts"
  - "src/pipelines/spec-synth.ts"
  - "src/pipelines/spec-consolidate.ts"
  - "src/pipelines/spec-index.ts"
  - "src/pipelines/spec-tag.ts"
  - "src/core/test-declarations.ts"
  - "src/core/safe-fetch.ts"
tests:
  - "tests/core/spec-parser.test.ts"
  - "tests/core/spec-frontmatter.test.ts"
  - "tests/core/spec-key.test.ts"
  - "tests/core/claims.test.ts"
  - "tests/core/claim-tags.test.ts"
  - "tests/core/claim-hash-stability.test.ts"
  - "tests/core/examples.test.ts"
  - "tests/core/testability.test.ts"
  - "tests/core/spec-graph.test.ts"
  - "tests/core/claim-migration.test.ts"
  - "tests/core/test-declarations.test.ts"
  - "tests/pipelines/spec-*.test.ts"
  - "tests/pipelines/reverse-generate.test.ts"
  - "tests/pipelines/import.test.ts"
  - "tests/pipelines/import-capability.test.ts"
docs:
  - "README.md"
  - "docs/user/spec-parser.md"
  - "docs/user/reverse-generate.md"
  - "docs/user/import.md"
history:
  - 2026-10-15-functional-specs-and-four-pillars
  - 2026-10-22-security-ssrf-via-import-url-fetching-is
  - 2026-10-22-security-hardening-from-audit-sast-and-p
  - 2026-10-22-header-role-fix-and-spec-level-security
  - 2026-10-22-security-credentials-embedded-in-importe
  - 2026-10-22-security-no-rate-limit-or-budget-cap-on
  - 2026-10-23-spec-tag-java-kotlin-tests-and-index-mod
  - 2026-10-26-example-tables-row-refs-assurance-and-ev
---

# Spec Authoring

## Problem & Value
Code changes quickly, often written by AI agents, and the intent behind it does not survive. Without a written, structured description of what a system is for and what it must do, tests drift, documentation goes stale and reviewers have nothing to judge the code against. Teams with an existing codebase or a pile of requirement documents rarely have the time to write specs from scratch, and specs that mirror individual source files are too granular to say anything about value.

Spec Authoring gives every other SpecGuard capability something solid to stand on. It defines the spec format (a master system spec, functional capability specs, optional components and journeys), gives each requirement a stable claim id, records which code a spec owns, and validates the whole set as a tree. It also bootstraps specs from existing code or outside documents, so a brownfield system can adopt spec-driven development in hours instead of weeks.

## Users & Journeys
- A developer runs `specguard reverse --all` on an existing codebase to get first-draft specs, then edits them into capability specs.
- A product owner runs `specguard import prd.md` to turn a requirements document into specs that become the new source of truth.
- A tech lead runs `specguard spec graph` to see the system, capability and component tree, which files each spec owns, and which rules are broken.
- A developer runs `specguard claims assign` after adding requirements so every bullet gets a stable id that tests and proofs can cite.
- A QA lead runs `specguard claims list --workspace` in CI to fail the build when a journey cites a claim that no longer exists.
- A coding agent reads a capability spec, including its declared sources, before editing the code that spec owns.
- A maintainer runs `specguard index` to produce an architecture index of the routes or endpoints and the spec tree.

## Requirements
- [ ] A spec may declare its metadata in YAML frontmatter (id, kind, title, parent, value, status, sources, tests, docs, history); frontmatter is read first, and specs that use the older HTML-comment metadata block still parse unchanged <!-- claim: frontmatter-v2-metadata -->
- [ ] Invalid frontmatter (bad YAML, a kind other than system, capability, component or journey, a non-string where a string is required, a list of non-strings) fails with an error that names the file and explains that lists must be block lists with quoted globs <!-- claim: frontmatter-errors -->
- [ ] A spec parses into a title, named sections, scenarios (name, numbered steps, expected-result bullets) and claims; missing sections yield empty values rather than errors, unknown metadata keys are preserved, and `Requirements` is accepted as the preferred name for `Acceptance Criteria` <!-- claim: sections-and-scenarios -->
- [ ] Spec discovery walks the specs tree recursively for markdown files, ignoring `README.md` files, the requirement-history folder and archived v1 specs, and parsing itself never touches the network or the filesystem beyond reading files <!-- claim: spec-discovery -->
- [ ] Every spec has one canonical key: its path relative to the specs root without the extension (or the owning app's spec directory when there is no specs root), used identically by claims, proofs, drift, the matrix and status <!-- claim: canonical-spec-key -->
- [ ] A spec's declared `sources` globs are resolved relative to the owning app's repo; a pattern that matches nothing there but matches from the config root is accepted with a one-time warning per pattern <!-- claim: declared-sources -->
- [ ] A requirement bullet carries its stable id in a trailing claim comment; bullets without one remain visible as unanchored, and reordering bullets never changes what an id refers to <!-- claim: claim-anchors -->
- [ ] `claims assign` adds an id to every requirement bullet that lacks one, never rewrites an existing id, generates lowercase unique slugs of at most six words and 48 characters, is idempotent, and with `--dry-run` reports the ids without writing <!-- claim: claims-assign -->
- [ ] `claims list` prints the claim catalog (optionally across every repo in the workspace) and exits 2 when a journey cites a claim that does not exist or a spec repeats a claim id <!-- claim: claims-list-gate -->
- [ ] A journey spec declares its world, actors and goals, invariants and budget, and each invariant lists the claim references it verifies, written as `specKey#claimId` or `repo:specKey#claimId` <!-- claim: journey-specs -->
- [ ] The spec graph arranges every spec as a tree (system, capability, component), attaches a capability with no parent to the system, keeps v1 specs as untyped nodes, and `spec graph` prints each node with its kind, owned-file count and claim count <!-- claim: graph-tree -->
- [ ] The graph answers which specs own a given file (zero, one or several) and which files are unowned, based only on declared sources, and ignores dependency and build directories <!-- claim: graph-file-ownership -->
- [ ] `spec graph` reports as errors a missing or multiple system spec, a missing id, an id that differs from the file name, a duplicate id, an unknown parent, a parent cycle, a wrong parent kind, a duplicate claim id and a missing Problem & Value section, and exits 2 on any error; it reports as warnings a spec whose sources match no files and a capability count above the configured maximum <!-- claim: graph-validation -->
- [ ] `reverse` requires either `--app <name>` or `--all` (exit 1 with a message otherwise), generates specs from the app's discovered source files, skips existing specs unless `--force`, supports `--file` for one source file, and ends with a created/updated/skipped/failed summary <!-- claim: reverse-per-source -->
- [ ] `reverse` keeps going when one spec or app fails, exits with the last non-zero code, caps each file sent to the model at 20,000 characters, never walks dependency or build directories, and warns about source files that look like they contain secrets while instructing the model not to reproduce them <!-- claim: reverse-safety -->
- [ ] `import` converts a local markdown or text file, or an http(s) URL, into spec files: a multi-section document is decomposed into a set of focused specs unless `--single` or `--out` is given, existing specs are skipped unless `--force`, and the result summary and exit code reflect created, skipped and failed items <!-- claim: import-documents -->
- [ ] `index` writes an architecture index at the root of the specs tree listing routes or endpoints grouped by area plus a spec directory map, finds the routing source through the app's entry points or detected framework, leaves an existing index alone unless `--force`, and writes a skeleton index instead of failing when the model call fails <!-- claim: index-generation -->
- [ ] `spec draft` inventories the code, summarises each file with the fast model (cached by content hash), clusters it into about 8 to 15 functional capabilities (honouring `granularity.target` and any `--guidance` the maintainers give, retrying once when the count misses it without losing the guidance), writes a reviewable capability map to `.specguard/spec-map.json` and `.md` outside `plans/`, and stops there unless `--yes` is given; `--from-map` continues from the edited map and writes one spec per capability plus the system spec <!-- claim: spec-draft-proposes-map -->
- [ ] `spec index` regenerates only the marked Capability Map region of the system spec from the spec graph and leaves the rest of the file untouched; `import <file> --capability <id>` adds only the requirements a document states that the capability does not already cover (a dry run unless `--yes`), appends them with unique claim anchors, and records a history entry for what it changed <!-- claim: spec-index-refreshes-map -->
- [ ] `spec consolidate` clusters existing per-file specs into capability specs, assigns every old spec to exactly one capability (otherwise it stops and lists the unassigned ones), merges their requirements with unique claim ids that never use numeric suffixes, carries over every old claim with an id that the model did not absorb (a bullet that never had an id has no reference to preserve and is superseded by the model's functional requirements), then rewrites claim tags in tests, rekeys the proof ledger and drift registry, archives the old specs under `_archive/v1`, and writes `.specguard/claim-migration.json` so results carrying old tags are still accepted on ingest <!-- claim: spec-consolidate-migrates-state -->
- [ ] `spec tag` links existing tests to requirements: for each capability the model is shown its requirements and the leaf tests in the files its `tests:` globs name, and says which requirements each test clearly exercises; only real requirement ids and test numbers survive, a `[claims: ...]` comment is written above the test in the file's comment style (a test already tagged is never touched, and two capabilities citing one test are merged into one comment), the run is a dry run unless `--yes`, and it reports which requirements no test covers <!-- claim: spec-tag-links-tests -->
- [ ] `spec tag` finds Java and Kotlin tests (`.java`, `.kt`): a method after a JUnit 5, JUnit 4 or TestNG test annotation (`@Test` with or without arguments, `@ParameterizedTest`, `@RepeatedTest`, `@TestFactory`, `@TestTemplate`), with other annotations, blank lines and comments between the annotation and the method; its title is the `@DisplayName` value when there is one, otherwise the method name; imports, annotations in comments and other `@Test...` annotations such as `@TestInstance` are not tests; the claim comment goes above the first annotation of the test (not between annotation and method), and a tag in that position counts as already tagged <!-- claim: spec-tag-java-tests -->
- [ ] `spec tag --index <file>` never modifies test sources (so tests in another repo can be linked from a specs-only overlay): with `--yes` it writes or merges a plain-text index at a path relative to the config root, one line per matched test, `<test-file>:<line> :: <title>  [claims: <ref>, <ref>]`, where the test path is relative to the config root (it may start with `../`); a line for the same `file:line :: title` is replaced, other lines are kept, the entries are sorted, and a test the index already lists (by `file:line` or by file and title, so a moved test is still known) is not offered to the model again; listing the index in `tests:` or `extraTestSources` makes the check count its claims as tested <!-- claim: spec-tag-index-mode -->
- [ ] `import <url>` reaches only public addresses: the host is resolved by SpecGuard, every loopback, private, link-local (including the cloud metadata address), carrier-grade, multicast, unique-local and IPv4-mapped or translated address is refused (also when only one of several answers is private), the connection goes to the address that was checked, each redirect is checked the same way, at most five redirects are followed, an https to http redirect, credentials in the URL and an answer over 5 MB are refused, and `--allow-private` is the only way to import from your own network <!-- claim: import-ssrf -->
- [ ] When `import` is called through the MCP server a file source must be inside the project (symlinks resolved first) and a URL may not reach a private address, so an agent cannot read `~/.ssh/id_rsa` or an internal URL into a spec <!-- claim: import-project-files -->
- [ ] A markdown table directly under a claim bullet (indented or at column 0, with only blank lines or the bullet's continuation lines between them) gives that claim example rows: it needs a header row and a separator row, takes each row's id from the column headed `id` (any case) or else the first column, requires an id of lower-case words joined by hyphens and unique within the claim, treats `\|` as a literal pipe, allows one table per claim, and is ignored in v1 specs <!-- claim: example-tables -->
- [ ] A table line never becomes part of the claim text, so adding, removing or editing an examples table leaves the claim hash unchanged, and the hash of every claim in this repository's specs is the same as before tables existed <!-- claim: claim-hash-unchanged-by-tables -->
- [ ] Each example row has a hash built from the claim hash and its sorted `header=cell` pairs: it ignores whitespace and column order, and changes when a cell changes or when the claim text changes <!-- claim: example-row-hashes -->
- [ ] A malformed examples table is reported with its line number: `EX-NO-SEPARATOR`, `EX-NO-ID-COLUMN`, `EX-BAD-ID`, `EX-DUP-ID`, `EX-CELL-COUNT`, `EX-MULTIPLE-TABLES` and `EX-CLAIM-NO-ID` are errors, while `EX-EMPTY` and `EX-ORPHAN-TABLE` (a table after prose or before the first claim) are warnings; a bad row is skipped and the readable rows are kept <!-- claim: example-table-issues -->
- [ ] A claim ref may end in `/<row id>` (`specKey#claimId/rowId`, with or without a `repo:` prefix): `parseClaimRef`, `formatClaimRef` and every claim tag form (`@claim:`, `[claim: ]`, `[claims: ]`) read and write the row, a ref with an invalid row id is rejected, and refs without a row behave as before <!-- claim: claim-row-refs -->
- [ ] A parameterized test whose title contains exactly one row id of its claim (a whole token, so `ny` never matches inside `ny-small`) is attributed to that row as well as to the claim; a title with two or more row ids attributes nothing and is reported as ambiguous <!-- claim: example-title-matching -->
- [ ] `assurance:` frontmatter takes a level or a default plus per-claim levels from `tested`, `property`, `bounded`, `proved-model`, `proved-code`, and `evidence:` maps a claim id to `kind` (`agentic` or `manual`) and `verifier`; values off the ladder are kept in `unknown` and a missing verifier is kept as an empty string so the lint reports it, an evidence kind other than the two fails with the file name, and neither key changes a claim hash <!-- claim: assurance-evidence-frontmatter -->
- [ ] The testability lint reports, per claim and rule, errors for a missing claim id, fewer than three words, placeholders (`TBD`, `TODO`, `FIXME`, `XXX`, `??`, `lorem ipsum`), outcome words with no test oracle (`properly`, `should work`, `as expected`), open-ended lists (`etc`, `and/or`), malformed example tables, evidence without a verifier or at a layer that must be automated, and unknown assurance or layer names, and warnings for hedges, subjective terms without a number, passive handling verbs, a claim with no observable outcome, more than three clauses, more than 80 words and varying behaviour with no examples table; it matches whole tokens only after removing code spans, quoted literals and URLs, is deterministic, and never calls a model <!-- claim: testability-lint -->
- [ ] The top-level `testability` config block overrides a rule's severity (`off`, `warn`, `error`), adds `allow` phrases that are never flagged and `deny` terms that are errors, sets `maxClauses` and `maxWords`, and lists `waive` rules per claim ref that downgrade an error to a warning marked waived for that claim only; an unknown rule id or a non-positive limit is rejected when the config loads <!-- claim: testability-config -->

## Scenarios
### Scenario 1: Adopt specs on an existing codebase
**Steps:**
1. A developer runs `specguard reverse --all` in a repo that has no specs.
2. The developer re-runs the same command without `--force`.
3. The developer runs `specguard claims assign` and then `specguard spec graph`.

**Expected Results:**
- First run creates specs and prints a summary such as `reverse: N created, 0 updated, 0 skipped, 0 failed`.
- Second run skips every existing spec and calls no model.
- Every requirement bullet now has a claim id and the graph lists each spec with its claim count.
- No spec is generated for anything inside `node_modules`, `dist` or `.git`.

### Scenario 2: Import a requirements document
**Steps:**
1. A product owner runs `specguard import docs/prd.md --app web`, where the PRD has several top-level sections.
2. The owner runs the command again without `--force`.

**Expected Results:**
- The document is decomposed into several focused specs in the app's spec directory, with file names derived from their titles.
- The second run reports them as skipped and overwrites nothing.
- The process exit code equals the pipeline's exit code (0 on success).

### Scenario 3: Validate the spec tree
**Steps:**
1. A developer adds a capability spec whose `id` differs from its file name and whose `parent` names a spec that does not exist.
2. The developer runs `specguard spec graph`.
3. The developer fixes the spec and runs the command again.

**Expected Results:**
- The first run prints `[error]` lines for `id-filename` and `unknown-parent` and exits with code 2.
- The second run prints the tree with no errors and exits 0; a spec whose sources match nothing still shows only a `[warn]`.

### Scenario 4: Catch a dangling journey claim
**Steps:**
1. A journey spec has an invariant that verifies `payments/checkout#charge-once`.
2. A developer renames that claim id in the capability spec.
3. CI runs `specguard claims list --workspace`.

**Expected Results:**
- The command reports the missing reference against the invariant.
- It exits with code 2, failing the build.

### Scenario 5: Find who owns a file
**Steps:**
1. Two capability specs declare overlapping source globs; a third file under `src/` matches no spec.
2. A tool asks the graph which specs own each file.

**Expected Results:**
- The shared file returns both spec ids; the unmatched file is reported as unowned.
- Files under dependency or build directories are never reported.

### Scenario 6: Bad frontmatter is explained
**Steps:**
1. A developer writes `sources: [src/{a,b}/**]` as a flow list in a capability spec.
2. A command that loads specs is run.

**Expected Results:**
- The error names the spec file and says lists must be block lists with quoted globs.
- Other specs that are valid are not silently dropped without a message.

## Security & Data Considerations
`reverse` and `import` send source code or document text to the configured LLM provider, so they run through the shared LLM layer (budget caps, redaction, replay) and instruct the model never to reproduce secret values. `reverse` warns before sending a file that matches secret patterns. `import` fetches only http and https URLs, follows at most one redirect, and refuses other schemes; it must not forward credentials found in a document to the model. Generated files are written only inside the repo's spec directories (or the explicit `--out` path). Parsing is pure and executes no code from specs.

## Interfaces
- CLI: `specguard reverse [--app <name>|--all] [--file <path>] [--force] [--collapse <globs>]`, `specguard import <file|url> [--app] [--out] [--force]`, `specguard index [--app] [--force]`, `specguard claims assign [--dir] [--dry-run]`, `specguard claims list [--workspace]`, `specguard spec graph`.
- Spec files: `specs/**/*.md` with YAML frontmatter (v2) or an HTML-comment metadata block (v1); claim anchors written as an HTML comment holding `claim:` and a kebab-case id.
- Config keys: `paths.specsRoot`, `apps[].specDir`, `apps[].sources`, `apps[].exclude`, `apps[].collapse`, `granularity.target`, `granularity.maxCapabilities`.
- Exit codes: 0 success, 1 internal error or missing flags, 2 validation failure (graph errors, dangling or duplicate claims).
- `specguard spec draft [--yes] [--from-map] [--force] [--history <ids...>] [--guidance <text>]`, `specguard spec consolidate [--yes] [--from-map] [--force] [--no-archive] [--rewrite-source-refs] [--guidance <text>]`, `specguard spec index`, `specguard spec graph`, `specguard spec tag [--spec <id>] [--yes] [--list] [--index <file>]`.

## Out of Scope
- Judging whether code satisfies a spec (see traceability and conformance capabilities).
- Recording the prompts and plans behind a spec (see requirement-history).
- Rendering specs as user or developer documentation.
- Writing specs that describe third-party dependencies.
