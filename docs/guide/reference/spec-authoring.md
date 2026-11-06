---
title: "Spec Authoring"
audience: user
source: "specs/capabilities/spec-authoring.md"
generated: true
---
<a id="spec-authoring"></a>
# Spec Authoring

Spec Authoring helps your team create and maintain a written, structured description of what your system is for and what it must do. Other SpecGuard capabilities, such as tests, proofs and reviews, rely on these specs.

<a id="why-it-exists"></a>
## Why it exists

Code changes quickly, often written by AI agents, and the intent behind it gets lost. Without written specs, tests drift, documentation goes stale, and reviewers have nothing to judge the code against.

Writing specs from scratch for an existing system takes a long time. Specs that mirror individual source files are too detailed to describe the value of anything. Spec Authoring creates first drafts from your existing code or documents. It then keeps the specs consistent, so a team can adopt spec-driven development in hours rather than weeks.

<a id="what-you-can-do"></a>
## What you can do

**Structure your specs**
- Organize specs as a tree: one system spec, capability specs under it, and optional component and journey specs.
- Each spec can declare its details at the top: id, kind, title, parent, value, status, the source code it owns, its tests, its docs and its history. Specs using the older comment-style header still work.
- Give every requirement a stable claim id, so tests, proofs and journeys can refer to it. Reordering requirements never changes what an id refers to.
- Group and order features and specs independently of file names. The editor can draft, edit and reorder this organization.

**Create specs from what you already have**
- `specguard reverse --all` (or `--app <name>`) generates draft specs from an app's source code. `--file` does one source file, and `--force` replaces existing specs.
- `specguard import <file or URL>` turns a markdown or text document, local or at an http(s) address, into specs. A document with several sections becomes several focused specs, unless you ask for a single spec or a specific output path.
- `specguard spec draft` proposes a capability map of roughly 8 to 15 functional capabilities.
  - You can steer it with guidance text.
  - It stops after writing a map you can review and edit.
  - Add `--yes`, or continue later with `--from-map`, to write the actual specs.
- `specguard spec consolidate` merges many per-file specs into capability specs. It moves existing claims, test tags, proofs and drift records across, and archives the old specs.
- `specguard import <file> --capability <id>` adds only the requirements a document states that the capability doesn't already cover.
- `specguard index` writes an architecture index listing routes or endpoints by area, plus a map of your specs.
- `specguard spec index` refreshes only the Capability Map section of the system spec.

**Manage claims**
- `specguard claims assign` gives an id to every requirement that lacks one. It never changes existing ids, can be re-run safely, and `--dry-run` previews the result.
- `specguard claims list` shows the claim catalog, across all repos with `--workspace`. It fails when a journey cites a claim that doesn't exist, or when a claim id is repeated.
- Journey specs declare their world, actors, goals, invariants and budget. Each invariant lists the claims it verifies, written as `specKey#claimId`, or `repo:specKey#claimId` for another repo.

**Check the whole set**
- `specguard spec graph` prints the tree with each spec's kind, number of owned files and number of claims. It also reports problems.
- You can ask which specs own a given file (none, one or several) and which files no spec owns. Dependency and build folders are ignored.

**Link tests to requirements**
- `specguard spec tag` suggests which tests exercise which requirements and writes a claim comment above each matched test. It works with Java and Kotlin tests as well as other languages.
  - It is a dry run unless you pass `--yes`.
  - It never changes a test that is already tagged.
  - It reports requirements that no test covers.
- `specguard spec tag --index <file>` leaves test sources untouched and records the links in a plain-text index. This is useful when tests live in another repo.

**Add examples to a claim**
- Put a markdown table directly under a requirement to give it example rows, each with an id. A parameterized test whose title contains exactly one row id counts toward that row as well as the claim. You can refer to a row as `specKey#claimId/rowId`.
- Editing the examples table does not change the claim itself.

**Set assurance and check requirement quality**
- Specs can state how strongly a claim must be assured (`tested`, `property`, `bounded`, `proved-model`, `proved-code`). They can also record manual or agentic evidence together with who verified it.
- A built-in check reads each requirement and flags vague or untestable wording. It does not use a model.
  - **Errors:** missing ids, placeholders such as TBD, outcome words like "properly" or "as expected", open-ended lists like "etc", and malformed example tables.
  - **Warnings:** hedges, subjective terms with no number, very long requirements, and requirements with several clauses.
- In the `testability` configuration you can change rule severity, allow or deny phrases, set length limits, and waive rules for individual claims.

<a id="what-to-expect"></a>
## What to expect

- **Safe re-runs.** Generation commands skip specs that already exist unless you use `--force`, and finish with a summary of created, updated, skipped and failed items. If one spec or app fails, the rest continue, and the command exits with the last non-zero code.
- **Reviewable steps.** Commands that change many things (`spec draft`, `spec consolidate`, `spec tag`, `import --capability`) are dry runs unless you confirm with `--yes`.
- **Exit codes.** 0 means success. 1 means an internal error or missing required options (for example, `reverse` without `--app` or `--all`). 2 means validation failed, such as spec graph errors or dangling or duplicate claims. Use it to fail a CI build.
- **Graph errors.** These include a missing or duplicate system spec, a missing or duplicate id, an id that differs from the file name, an unknown parent, a parent cycle, a wrong parent kind, a duplicate claim id and a missing Problem & Value section. Specs whose sources match no files, or too many capabilities, appear only as warnings.
- **Clear errors for bad headers.** If a spec's header is invalid, for example a list written in flow style, the message names the file. It explains that lists must be block lists with quoted globs.
- **Unanchored requirements stay visible.** Requirements without an id are shown as unanchored until you run `claims assign`.
- **Missing sections are fine.** A spec with missing sections reads as empty, not as an error. "Requirements" is the preferred name for the "Acceptance Criteria" section.
- **Content sent to your model provider.** `reverse` and `import` send source code or document text to your configured model provider. They go through SpecGuard's shared safeguards (budget caps, redaction, replay) and tell the model never to reproduce secrets. `reverse` warns about files that look like they contain secrets, and sends at most 20,000 characters of any one file.
- **Index fallback.** `index` leaves an existing index alone unless you use `--force`. If the model call fails, it writes a skeleton index rather than failing.
- **Importing from a URL.** Only public addresses are reachable.
  - Loopback, private, link-local (including cloud metadata) and similar addresses are refused, as are redirects to them.
  - Credentials in the URL, a downgrade from https to http, and responses over 5 MB are refused.
  - Use `--allow-private` to import from your own network.
  - When an agent imports through the MCP server, files must be inside the project and URLs may not reach private addresses.
- **Generated files stay inside your spec folders**, or at the output path you choose explicitly.

Spec Authoring does not judge whether code satisfies a spec, record the prompts and plans behind a spec, render specs as documentation, or describe third-party dependencies.
