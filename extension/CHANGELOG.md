# SpecGuard VS Code Extension — Changelog

All notable changes are documented here.

## [0.2.0] — 2026-10-16

### ✨ New

- feat(server): accept gzip request bodies; the client gzips large uploads (`4625a5c`)
- feat: local-first operation with an optional team server; finish the 0.2 surface cuts (0.2.0) (`21d94e6`)
- feat(extension): read data through the SpecGuard API, with a team server and a local fallback (`9cf692e`)
- Add comprehensive tests for API, server, and UI functionality (`69f684e`)
- feat(remediate): MCP tool (scan-only/dry-run), action remediate mode, CI docs and example workflow (`20ef5e2`)
- feat(remediate): CLI command and end-to-end fixtures (preserved, changed, flaky, dry-run, locks) (`5c243e6`)
- feat(remediate): orchestrator, ship, PR body rendering (`19db8b7`)
- feat(remediate): apply with write allowlist, code fixer, test selection, verification (`e57eb8f`)
- feat(git-ops): per change-type staging scopes, -z porcelain parsing, traversal-safe root check (`56605cb`)
- feat(remediate): detection, baseline, planning, changelog analysis, git/worktree helpers (`37688b1`)
- feat(core): behavior-preservation verdict (pure) with table-driven tests (`b4ae9e8`)
- feat(core): ecosystem adapters (npm/pnpm/yarn/pip/poetry/uv/go/cargo/maven/gradle), OSV detector, audit fixtures (`7eb0887`)
- feat(core): advisory model, ignore file, remediate exit codes (`9553af3`)
- feat(validate): auth strategies, per-profile contexts, redaction, target-aware guardrails, headless/allow-outbound (`8a16c16`)
- feat(release): package-qualified npx forms, single version source, GitHub Action, tag-driven release, real lint (`cd57769`)
- feat(llm): per-pipeline overrides, fallback chain, timeout/retry, usage log, hard budget, replay and none providers (`a0e8377`)
- feat(test-runners,heal): runner adapters reading reporter files, per-app test config, heal jobs, workspace detection (`5140146`)
- feat(portability): ignore generated run state, init writes the ignore block, one org identity (`9526a66`)
- feat(config): paths block, extends, repo-boundary config search, stripPrefix, entryPoints, framework profiles for index (`97184f2`)
- feat(plugins): plugin architecture, generic feature-state, de-Practera (`9d0c1a9`)
- feat(matrix,align,generate): claim-tag prepass, per-claim matrix linkage, tagged generated tests (`1ee25b9`)
- feat(results): test-result ingestion, claim tags, portable proof ledger (`c601157`)
- feat: enhance spec management with new features and error handling (`94a2826`)
- feat: introduce claims and proof management commands in CLI (`13eba8e`)
- feat: enhance align command with concurrency and fresh options (`2a3c6d0`)
- feat: add initial VSCode settings for Python environment configuration (`0355857`)

### 🐛 Fixed

- fix(server): build the system guide from the system spec's own sections (`f032a17`)
- fix(ci): extension lockfile in sync under npm 10 (esbuild 0.28 matches vite peer); give analyze --auto-fix test a CI-safe timeout (`35503c1`)
- fix(init): resolve a local specguard runner for MCP/hook wiring (--runner node (`npx`)
- fix(sources): globs resolve relative to the app repo with warned root-relative fallback; correct the example monorepo adoption doc (`15ffdc9`)
- fix(results): partial ingests only update present claims; --unexercised/--sweep needs --full-run or all-app coverage and never downgrades proven claims (`56a0f24`)
- fix(status): mark specs (no test) by claim-tag linkage, file name as fallback; add the example monorepo regression suite (`00dc48f`)
- fix(spec-key): one canonical spec key; ingest records declared source hashes; migrate legacy registry keys (`0dd7e7b`)
- fix: security uses the language audit runner, audit detail kept, changelog write, no-op flags wired, security.json report, bandit removed (`8ffd306`)

### 🔧 Internal

- Implement code changes to enhance functionality and improve performance (`ece9fc7`)
- build: put the team server's Dockerfile at the repository root (`5381ae8`)
- build: clean dist before building; deploy on Node 20; plain /health; release without Marketplace (`af78006`)
- test: keep the publish tests independent of CI environment variables (`760a6d7`)
- chore: update settings.json to include attribution fields and co-authorship option (`ac7d6bf`)
- chore: update pnpm-lock.yaml with dependency version upgrades for AI SDKs and ESLint packages (`6c27444`)
- chore: build the CLI on install and mark the dependency upgrade as 0.1.3 (`b98b262`)
- chore: update package-lock.json with dependency version upgrades for @modelcontextprotocol/sdk and proxy-addr, and add funding information for express (`60886e4`)
- chore: remove unused imports (`2a53309`)
- docs: README spec keys, ingest semantics, runner; regression tests for partial/full ingest (`c5faa82`)
- spec: sources relative to repo (`f258d29`)
- spec: canonical spec key, partial-ingest semantics, claim-tag status, init runner (`2fa4a26`)
- docs: dogfood results of remediate against a read-only the example monorepo copy (`cef326a`)
- docs: README remediate section, exit codes, git/PR non-goal exception (`deb1e8f`)
- chore(remediate): lint fixes (`cfb47c1`)
- test(remediate): unit tests for planning, changelog/replay LLM, detection, allowlist, selection, ship; MCP tool test (`838b633`)
- docs(specs): remediate pipeline spec (`b39a35d`)
- docs(specs): advisory, ecosystems and behavior-verdict specs for remediate (`a76d35b`)
- docs: fix the example monorepo config note, update guardrails README (`98129af`)
- docs: the example monorepo adoption guide (`ade0d88`)
- chore(dogfood): self config with test blocks, tag claim-tags tests, ledger, docs/dogfood.md (`93911d5`)
- docs: correct remaining npx wording, drop machine-specific doc path mentions (`294d49e`)
- test(mcp): results/proof ingest tools via in-memory client; refresh MCP spec tool table (`57ef1f6`)
- test: resolve specguard-core alias, fix errors import, build feature-state fixture instead of a machine-specific checkout (`eea8dd7`)
- chore: update dependencies and refactor LLM integration (`2fabe7b`)
- chore: update package-lock.json for version bump and dependency updates (`3ec377a`)
## [0.2.0] — 2026-10-15

### ✨ New

- feat: local-first operation with an optional team server; finish the 0.2 surface cuts (0.2.0) (`21d94e6`)
- feat(extension): read data through the SpecGuard API, with a team server and a local fallback (`9cf692e`)
- Add comprehensive tests for API, server, and UI functionality (`69f684e`)
- feat(remediate): MCP tool (scan-only/dry-run), action remediate mode, CI docs and example workflow (`20ef5e2`)
- feat(remediate): CLI command and end-to-end fixtures (preserved, changed, flaky, dry-run, locks) (`5c243e6`)
- feat(remediate): orchestrator, ship, PR body rendering (`19db8b7`)
- feat(remediate): apply with write allowlist, code fixer, test selection, verification (`e57eb8f`)
- feat(git-ops): per change-type staging scopes, -z porcelain parsing, traversal-safe root check (`56605cb`)
- feat(remediate): detection, baseline, planning, changelog analysis, git/worktree helpers (`37688b1`)
- feat(core): behavior-preservation verdict (pure) with table-driven tests (`b4ae9e8`)
- feat(core): ecosystem adapters (npm/pnpm/yarn/pip/poetry/uv/go/cargo/maven/gradle), OSV detector, audit fixtures (`7eb0887`)
- feat(core): advisory model, ignore file, remediate exit codes (`9553af3`)
- feat(validate): auth strategies, per-profile contexts, redaction, target-aware guardrails, headless/allow-outbound (`8a16c16`)
- feat(release): package-qualified npx forms, single version source, GitHub Action, tag-driven release, real lint (`cd57769`)
- feat(llm): per-pipeline overrides, fallback chain, timeout/retry, usage log, hard budget, replay and none providers (`a0e8377`)
- feat(test-runners,heal): runner adapters reading reporter files, per-app test config, heal jobs, workspace detection (`5140146`)
- feat(portability): ignore generated run state, init writes the ignore block, one org identity (`9526a66`)
- feat(config): paths block, extends, repo-boundary config search, stripPrefix, entryPoints, framework profiles for index (`97184f2`)
- feat(plugins): plugin architecture, generic feature-state, de-Practera (`9d0c1a9`)
- feat(matrix,align,generate): claim-tag prepass, per-claim matrix linkage, tagged generated tests (`1ee25b9`)
- feat(results): test-result ingestion, claim tags, portable proof ledger (`c601157`)
- feat: enhance spec management with new features and error handling (`94a2826`)
- feat: introduce claims and proof management commands in CLI (`13eba8e`)
- feat: enhance align command with concurrency and fresh options (`2a3c6d0`)
- feat: add initial VSCode settings for Python environment configuration (`0355857`)
- feat: add index command and enhance orphan detection in drift pipeline (`162250e`)
- feat: enhance documentation and UI for spec management and contract rebuilding (`d966536`)
- feat: release version 0.1.28 with new commands and enhancements (`b46d9fd`)
- feat: release version 0.1.27 with enhancements and new features (`bc5555b`)

### 🐛 Fixed

- fix(ci): extension lockfile in sync under npm 10 (esbuild 0.28 matches vite peer); give analyze --auto-fix test a CI-safe timeout (`35503c1`)
- fix(init): resolve a local specguard runner for MCP/hook wiring (--runner node (`npx`)
- fix(sources): globs resolve relative to the app repo with warned root-relative fallback; correct the example monorepo adoption doc (`15ffdc9`)
- fix(results): partial ingests only update present claims; --unexercised/--sweep needs --full-run or all-app coverage and never downgrades proven claims (`56a0f24`)
- fix(status): mark specs (no test) by claim-tag linkage, file name as fallback; add the example monorepo regression suite (`00dc48f`)
- fix(spec-key): one canonical spec key; ingest records declared source hashes; migrate legacy registry keys (`0dd7e7b`)
- fix: security uses the language audit runner, audit detail kept, changelog write, no-op flags wired, security.json report, bandit removed (`8ffd306`)

### 🔧 Internal

- test: keep the publish tests independent of CI environment variables (`760a6d7`)
- chore: update settings.json to include attribution fields and co-authorship option (`ac7d6bf`)
- chore: update pnpm-lock.yaml with dependency version upgrades for AI SDKs and ESLint packages (`6c27444`)
- chore: build the CLI on install and mark the dependency upgrade as 0.1.3 (`b98b262`)
- chore: update package-lock.json with dependency version upgrades for @modelcontextprotocol/sdk and proxy-addr, and add funding information for express (`60886e4`)
- chore: remove unused imports (`2a53309`)
- docs: README spec keys, ingest semantics, runner; regression tests for partial/full ingest (`c5faa82`)
- spec: sources relative to repo (`f258d29`)
- spec: canonical spec key, partial-ingest semantics, claim-tag status, init runner (`2fa4a26`)
- docs: dogfood results of remediate against a read-only the example monorepo copy (`cef326a`)
- docs: README remediate section, exit codes, git/PR non-goal exception (`deb1e8f`)
- chore(remediate): lint fixes (`cfb47c1`)
- test(remediate): unit tests for planning, changelog/replay LLM, detection, allowlist, selection, ship; MCP tool test (`838b633`)
- docs(specs): remediate pipeline spec (`b39a35d`)
- docs(specs): advisory, ecosystems and behavior-verdict specs for remediate (`a76d35b`)
- docs: fix the example monorepo config note, update guardrails README (`98129af`)
- docs: the example monorepo adoption guide (`ade0d88`)
- chore(dogfood): self config with test blocks, tag claim-tags tests, ledger, docs/dogfood.md (`93911d5`)
- docs: correct remaining npx wording, drop machine-specific doc path mentions (`294d49e`)
- test(mcp): results/proof ingest tools via in-memory client; refresh MCP spec tool table (`57ef1f6`)
- test: resolve specguard-core alias, fix errors import, build feature-state fixture instead of a machine-specific checkout (`eea8dd7`)
- chore: update dependencies and refactor LLM integration (`2fabe7b`)
- chore: update package-lock.json for version bump and dependency updates (`3ec377a`)
- ci: add check-gitignore workflow to prevent tracked build artifacts (`80c2e55`)
## [0.1.28] — 2026-08-29

### ✨ New

- feat: release version 0.1.27 with enhancements and new features (`28d4067`)
- feat: bump version to 0.1.2 and add align command to CLI (`5828add`)
- feat: rename project to specguard-ai and update package metadata (`ddd26d6`)
- feat: update version to 0.1.24 and modify activity log status to error (`0601036`)
- feat: enhance CLI initialization with language detection and update test configurations (`fd293e3`)
- feat: add scaffold functionality for SpecGuard harness files (`f982764`)
- feat: update version to 0.1.22 and enhance import pipeline with new features (`5fe80f0`)
- feat: update version to 0.1.20 and enhance project configuration management (`1c241a4`)
- feat: enhance SpecGuard extension with new commands and quality improvements (`83da61e`)
- feat: release version 0.1.14 with new commands and enhancements (`4ac183b`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`7c253d2`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`ba325d1`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`385a9cf`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`8c9c7bf`)
- feat(specguard): enhance CLI commands and documentation (`c82a4e2`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`07c7ced`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`19d74cf`)
- feat(dashboard): chain webview build, packaging, README + verification (`534eaab`)
- feat(dashboard): matrix, docs, and activity tabs (`2d7c91d`)
- feat(dashboard): animated system-flow view (`2197c18`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`8f30a4a`)
- feat(dashboard): webview panel + openDashboard command/menu (`51cd217`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`93bbf44`)
- feat(dashboard): pure flow-event + cli-arg mappers (`6f3f3c6`)
- feat(dashboard): traceability.json → matrix model transform (`3350a01`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`4ac9357`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`d2b78ec`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`acea725`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`320e835`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`2379c9d`)

### 🔧 Internal

- ci: add check-gitignore workflow to prevent tracked build artifacts (`d2f45fd`)
- chore: bump version to 0.1.1 and enhance CLI path resolution (`1524cc2`)
- chore: update version to 0.1.15 and add settings and specs views (`e063c37`)
- specguard(deps): 3 file(s) in .specguard (`91237c8`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`6c29dac`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`7c23f6a`)
- chore(release): bump version to 0.1.3 and update activity log (`f4a1b1e`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7ea3b27`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`6ada998`)
- docs(dashboard): pivot to live extension-webview visualization spec (`1558796`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`0ca521f`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`da41a91`)
- docs(dashboard): SpecGuard developer control-panel design spec (`dc49ced`)
## [0.1.27] — 2026-07-03

### ✨ New

- feat: bump version to 0.1.2 and add align command to CLI (`659ffe1`)
- feat: rename project to specguard-ai and update package metadata (`4e55302`)
- feat: update version to 0.1.24 and modify activity log status to error (`90070e5`)
- feat: enhance CLI initialization with language detection and update test configurations (`fb3b335`)
- feat: add scaffold functionality for SpecGuard harness files (`f9cfcaa`)
- feat: update version to 0.1.22 and enhance import pipeline with new features (`1f3d300`)
- feat: update version to 0.1.20 and enhance project configuration management (`f4b9c08`)
- feat: enhance SpecGuard extension with new commands and quality improvements (`adb0ef3`)
- feat: release version 0.1.14 with new commands and enhancements (`f9d38da`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)

### 🔧 Internal

- chore: bump version to 0.1.1 and enhance CLI path resolution (`d923dcc`)
- chore: update version to 0.1.15 and add settings and specs views (`70a90ef`)
- specguard(deps): 3 file(s) in .specguard (`c6e074e`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
## [0.1.26] — 2026-07-03

### ✨ New

- feat: bump version to 0.1.2 and add align command to CLI (`659ffe1`)
- feat: rename project to specguard-ai and update package metadata (`4e55302`)
- feat: update version to 0.1.24 and modify activity log status to error (`90070e5`)
- feat: enhance CLI initialization with language detection and update test configurations (`fb3b335`)
- feat: add scaffold functionality for SpecGuard harness files (`f9cfcaa`)
- feat: update version to 0.1.22 and enhance import pipeline with new features (`1f3d300`)
- feat: update version to 0.1.20 and enhance project configuration management (`f4b9c08`)
- feat: enhance SpecGuard extension with new commands and quality improvements (`adb0ef3`)
- feat: release version 0.1.14 with new commands and enhancements (`f9d38da`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)

### 🔧 Internal

- chore: bump version to 0.1.1 and enhance CLI path resolution (`d923dcc`)
- chore: update version to 0.1.15 and add settings and specs views (`70a90ef`)
- specguard(deps): 3 file(s) in .specguard (`c6e074e`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
## [0.1.25] — 2026-07-02

### ✨ New

- feat: update version to 0.1.24 and modify activity log status to error (`90070e5`)
- feat: enhance CLI initialization with language detection and update test configurations (`fb3b335`)
- feat: add scaffold functionality for SpecGuard harness files (`f9cfcaa`)
- feat: update version to 0.1.22 and enhance import pipeline with new features (`1f3d300`)
- feat: update version to 0.1.20 and enhance project configuration management (`f4b9c08`)
- feat: enhance SpecGuard extension with new commands and quality improvements (`adb0ef3`)
- feat: release version 0.1.14 with new commands and enhancements (`f9d38da`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)

### 🔧 Internal

- chore: update version to 0.1.15 and add settings and specs views (`70a90ef`)
- specguard(deps): 3 file(s) in .specguard (`c6e074e`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
- Implement validate, matrix, and import commands in CLI; enhance security pipeline with SAST integration (`d12869f`)
- Phase 5: security + docs pipelines + MCP server, wired into CLI (`8e311f9`)
- Phase 4: forward-generate + heal pipelines, wired into CLI (`8537bb3`)
## [0.1.24] — 2026-06-30

### ✨ New

- feat: enhance CLI initialization with language detection and update test configurations (`fb3b335`)
- feat: add scaffold functionality for SpecGuard harness files (`f9cfcaa`)
- feat: update version to 0.1.22 and enhance import pipeline with new features (`1f3d300`)
- feat: update version to 0.1.20 and enhance project configuration management (`f4b9c08`)
- feat: enhance SpecGuard extension with new commands and quality improvements (`adb0ef3`)
- feat: release version 0.1.14 with new commands and enhancements (`f9d38da`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)

### 🔧 Internal

- chore: update version to 0.1.15 and add settings and specs views (`70a90ef`)
- specguard(deps): 3 file(s) in .specguard (`c6e074e`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
- Implement validate, matrix, and import commands in CLI; enhance security pipeline with SAST integration (`d12869f`)
- Phase 5: security + docs pipelines + MCP server, wired into CLI (`8e311f9`)
- Phase 4: forward-generate + heal pipelines, wired into CLI (`8537bb3`)
- Phase 3: status + drift pipelines, wired into CLI (`60520ba`)
## [0.1.23] — 2026-06-30

### ✨ New

- feat: update version to 0.1.22 and enhance import pipeline with new features (`1f3d300`)
- feat: update version to 0.1.20 and enhance project configuration management (`f4b9c08`)
- feat: enhance SpecGuard extension with new commands and quality improvements (`adb0ef3`)
- feat: release version 0.1.14 with new commands and enhancements (`f9d38da`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)

### 🔧 Internal

- chore: update version to 0.1.15 and add settings and specs views (`70a90ef`)
- specguard(deps): 3 file(s) in .specguard (`c6e074e`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
- Implement validate, matrix, and import commands in CLI; enhance security pipeline with SAST integration (`d12869f`)
- Phase 5: security + docs pipelines + MCP server, wired into CLI (`8e311f9`)
- Phase 4: forward-generate + heal pipelines, wired into CLI (`8537bb3`)
- Phase 3: status + drift pipelines, wired into CLI (`60520ba`)
- Phase 2: CLI shell (commander) + reverse-generate pipeline (`de2c713`)
- Phase 1: core foundation — spec-parser, config/reader/writer, llm adapter (`2663b48`)
## [0.1.22] — 2026-06-30

### ✨ New

- feat: update version to 0.1.20 and enhance project configuration management (`f4b9c08`)
- feat: enhance SpecGuard extension with new commands and quality improvements (`adb0ef3`)
- feat: release version 0.1.14 with new commands and enhancements (`f9d38da`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)

### 🔧 Internal

- chore: update version to 0.1.15 and add settings and specs views (`70a90ef`)
- specguard(deps): 3 file(s) in .specguard (`c6e074e`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
- Implement validate, matrix, and import commands in CLI; enhance security pipeline with SAST integration (`d12869f`)
- Phase 5: security + docs pipelines + MCP server, wired into CLI (`8e311f9`)
- Phase 4: forward-generate + heal pipelines, wired into CLI (`8537bb3`)
- Phase 3: status + drift pipelines, wired into CLI (`60520ba`)
- Phase 2: CLI shell (commander) + reverse-generate pipeline (`de2c713`)
- Phase 1: core foundation — spec-parser, config/reader/writer, llm adapter (`2663b48`)
- Phase 0: project scaffold (config, types, exit-codes, errors) (`e9e3177`)
## [0.1.21] — 2026-06-30

### ✨ New

- feat: update version to 0.1.20 and enhance project configuration management (`f4b9c08`)
- feat: enhance SpecGuard extension with new commands and quality improvements (`adb0ef3`)
- feat: release version 0.1.14 with new commands and enhancements (`f9d38da`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)

### 🔧 Internal

- chore: update version to 0.1.15 and add settings and specs views (`70a90ef`)
- specguard(deps): 3 file(s) in .specguard (`c6e074e`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
- Implement validate, matrix, and import commands in CLI; enhance security pipeline with SAST integration (`d12869f`)
- Phase 5: security + docs pipelines + MCP server, wired into CLI (`8e311f9`)
- Phase 4: forward-generate + heal pipelines, wired into CLI (`8537bb3`)
- Phase 3: status + drift pipelines, wired into CLI (`60520ba`)
- Phase 2: CLI shell (commander) + reverse-generate pipeline (`de2c713`)
- Phase 1: core foundation — spec-parser, config/reader/writer, llm adapter (`2663b48`)
- Phase 0: project scaffold (config, types, exit-codes, errors) (`e9e3177`)
## [0.1.20] — 2026-06-30

### ✨ New

- feat: enhance SpecGuard extension with new commands and quality improvements (`adb0ef3`)
- feat: release version 0.1.14 with new commands and enhancements (`f9d38da`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)
- Update README to further refine instructions for the self-healing test pipeline, expand on defect attribution categories, and enhance clarity on the validation memory feature. Improved sections on authentication handling and evidence-backed issue reporting for better user guidance. (`1c7c81d`)

### 🔧 Internal

- chore: update version to 0.1.15 and add settings and specs views (`70a90ef`)
- specguard(deps): 3 file(s) in .specguard (`c6e074e`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
- Implement validate, matrix, and import commands in CLI; enhance security pipeline with SAST integration (`d12869f`)
- Phase 5: security + docs pipelines + MCP server, wired into CLI (`8e311f9`)
- Phase 4: forward-generate + heal pipelines, wired into CLI (`8537bb3`)
- Phase 3: status + drift pipelines, wired into CLI (`60520ba`)
- Phase 2: CLI shell (commander) + reverse-generate pipeline (`de2c713`)
- Phase 1: core foundation — spec-parser, config/reader/writer, llm adapter (`2663b48`)
- Phase 0: project scaffold (config, types, exit-codes, errors) (`e9e3177`)
## [0.1.19] — 2026-06-29

### ✨ New

- feat: enhance SpecGuard extension with new commands and quality improvements (`adb0ef3`)
- feat: release version 0.1.14 with new commands and enhancements (`f9d38da`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)
- Update README to further refine instructions for the self-healing test pipeline, expand on defect attribution categories, and enhance clarity on the validation memory feature. Improved sections on authentication handling and evidence-backed issue reporting for better user guidance. (`1c7c81d`)

### 🔧 Internal

- chore: update version to 0.1.15 and add settings and specs views (`70a90ef`)
- specguard(deps): 3 file(s) in .specguard (`c6e074e`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
- Implement validate, matrix, and import commands in CLI; enhance security pipeline with SAST integration (`d12869f`)
- Phase 5: security + docs pipelines + MCP server, wired into CLI (`8e311f9`)
- Phase 4: forward-generate + heal pipelines, wired into CLI (`8537bb3`)
- Phase 3: status + drift pipelines, wired into CLI (`60520ba`)
- Phase 2: CLI shell (commander) + reverse-generate pipeline (`de2c713`)
- Phase 1: core foundation — spec-parser, config/reader/writer, llm adapter (`2663b48`)
- Phase 0: project scaffold (config, types, exit-codes, errors) (`e9e3177`)
## [0.1.18] — 2026-06-29

### ✨ New

- feat: enhance SpecGuard extension with new commands and quality improvements (`adb0ef3`)
- feat: release version 0.1.14 with new commands and enhancements (`f9d38da`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)
- Update README to further refine instructions for the self-healing test pipeline, expand on defect attribution categories, and enhance clarity on the validation memory feature. Improved sections on authentication handling and evidence-backed issue reporting for better user guidance. (`1c7c81d`)

### 🔧 Internal

- chore: update version to 0.1.15 and add settings and specs views (`70a90ef`)
- specguard(deps): 3 file(s) in .specguard (`c6e074e`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
- Implement validate, matrix, and import commands in CLI; enhance security pipeline with SAST integration (`d12869f`)
- Phase 5: security + docs pipelines + MCP server, wired into CLI (`8e311f9`)
- Phase 4: forward-generate + heal pipelines, wired into CLI (`8537bb3`)
- Phase 3: status + drift pipelines, wired into CLI (`60520ba`)
- Phase 2: CLI shell (commander) + reverse-generate pipeline (`de2c713`)
- Phase 1: core foundation — spec-parser, config/reader/writer, llm adapter (`2663b48`)
- Phase 0: project scaffold (config, types, exit-codes, errors) (`e9e3177`)
## [0.1.17] — 2026-06-29

### ✨ New

- feat: enhance SpecGuard extension with new commands and quality improvements (`adb0ef3`)
- feat: release version 0.1.14 with new commands and enhancements (`f9d38da`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)
- Update README to further refine instructions for the self-healing test pipeline, expand on defect attribution categories, and enhance clarity on the validation memory feature. Improved sections on authentication handling and evidence-backed issue reporting for better user guidance. (`1c7c81d`)

### 🔧 Internal

- chore: update version to 0.1.15 and add settings and specs views (`70a90ef`)
- specguard(deps): 3 file(s) in .specguard (`c6e074e`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
- Implement validate, matrix, and import commands in CLI; enhance security pipeline with SAST integration (`d12869f`)
- Phase 5: security + docs pipelines + MCP server, wired into CLI (`8e311f9`)
- Phase 4: forward-generate + heal pipelines, wired into CLI (`8537bb3`)
- Phase 3: status + drift pipelines, wired into CLI (`60520ba`)
- Phase 2: CLI shell (commander) + reverse-generate pipeline (`de2c713`)
- Phase 1: core foundation — spec-parser, config/reader/writer, llm adapter (`2663b48`)
- Phase 0: project scaffold (config, types, exit-codes, errors) (`e9e3177`)
## [0.1.16] — 2026-06-29

### ✨ New

- feat: enhance SpecGuard extension with new commands and quality improvements (`adb0ef3`)
- feat: release version 0.1.14 with new commands and enhancements (`f9d38da`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)
- Update README to further refine instructions for the self-healing test pipeline, expand on defect attribution categories, and enhance clarity on the validation memory feature. Improved sections on authentication handling and evidence-backed issue reporting for better user guidance. (`1c7c81d`)

### 🔧 Internal

- specguard(deps): 3 file(s) in .specguard (`c6e074e`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
- Implement validate, matrix, and import commands in CLI; enhance security pipeline with SAST integration (`d12869f`)
- Phase 5: security + docs pipelines + MCP server, wired into CLI (`8e311f9`)
- Phase 4: forward-generate + heal pipelines, wired into CLI (`8537bb3`)
- Phase 3: status + drift pipelines, wired into CLI (`60520ba`)
- Phase 2: CLI shell (commander) + reverse-generate pipeline (`de2c713`)
- Phase 1: core foundation — spec-parser, config/reader/writer, llm adapter (`2663b48`)
- Phase 0: project scaffold (config, types, exit-codes, errors) (`e9e3177`)
- Refine README to include updated instructions for the self-healing test pipeline, enhance defect attribution categories, and provide clearer guidelines on the validation memory feature. Improved sections on authentication handling and evidence-backed issue reporting for better user understanding. (`f11c8bd`)
## [0.1.15] — 2026-06-29

### ✨ New

- feat: enhance SpecGuard extension with new commands and quality improvements (`adb0ef3`)
- feat: release version 0.1.14 with new commands and enhancements (`f9d38da`)
- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)
- Update README to further refine instructions for the self-healing test pipeline, expand on defect attribution categories, and enhance clarity on the validation memory feature. Improved sections on authentication handling and evidence-backed issue reporting for better user guidance. (`1c7c81d`)

### 🔧 Internal

- specguard(deps): 3 file(s) in .specguard (`c6e074e`)
- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
- Implement validate, matrix, and import commands in CLI; enhance security pipeline with SAST integration (`d12869f`)
- Phase 5: security + docs pipelines + MCP server, wired into CLI (`8e311f9`)
- Phase 4: forward-generate + heal pipelines, wired into CLI (`8537bb3`)
- Phase 3: status + drift pipelines, wired into CLI (`60520ba`)
- Phase 2: CLI shell (commander) + reverse-generate pipeline (`de2c713`)
- Phase 1: core foundation — spec-parser, config/reader/writer, llm adapter (`2663b48`)
- Phase 0: project scaffold (config, types, exit-codes, errors) (`e9e3177`)
- Refine README to include updated instructions for the self-healing test pipeline, enhance defect attribution categories, and provide clearer guidelines on the validation memory feature. Improved sections on authentication handling and evidence-backed issue reporting for better user understanding. (`f11c8bd`)
## [0.1.14] — 2026-06-29

### ✨ New

- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)
- Update README to further refine instructions for the self-healing test pipeline, expand on defect attribution categories, and enhance clarity on the validation memory feature. Improved sections on authentication handling and evidence-backed issue reporting for better user guidance. (`1c7c81d`)
- Update README to clarify the self-healing test pipeline, introduce defect attribution categories, and outline the validation memory feature. Added details on authentication handling and evidence-backed issue reporting for improved clarity and usability. (`bd0ac2a`)
- Enhance README with detailed features and architecture of SpecGuard. Added new functionalities including test self-healing, hybrid security analysis, and requirement-to-test traceability. Updated CLI commands and clarified import pipeline for external documents. (`baf57e0`)

### 🔧 Internal

- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
- Implement validate, matrix, and import commands in CLI; enhance security pipeline with SAST integration (`d12869f`)
- Phase 5: security + docs pipelines + MCP server, wired into CLI (`8e311f9`)
- Phase 4: forward-generate + heal pipelines, wired into CLI (`8537bb3`)
- Phase 3: status + drift pipelines, wired into CLI (`60520ba`)
- Phase 2: CLI shell (commander) + reverse-generate pipeline (`de2c713`)
- Phase 1: core foundation — spec-parser, config/reader/writer, llm adapter (`2663b48`)
- Phase 0: project scaffold (config, types, exit-codes, errors) (`e9e3177`)
- Refine README to include updated instructions for the self-healing test pipeline, enhance defect attribution categories, and provide clearer guidelines on the validation memory feature. Improved sections on authentication handling and evidence-backed issue reporting for better user understanding. (`f11c8bd`)
- docs: add QA Agent README (`0d5f37f`)
## [0.1.13] — 2026-06-29

_No notable changes collected from git log._
## [0.1.12] — 2026-06-29

_No notable changes collected from git log._
## [0.1.11] — 2026-06-29

_No notable changes collected from git log._
## [0.1.10] — 2026-06-29

_No notable changes collected from git log._
## [0.1.9] — 2026-06-29

_No notable changes collected from git log._
## [0.1.8] — 2026-06-29

_No notable changes collected from git log._
## [0.1.7] — 2026-06-29

_No notable changes collected from git log._
## [0.1.6] — 2026-06-28

_No notable changes collected from git log._
## [0.1.5] — 2026-06-28

_No notable changes collected from git log._
## [0.1.4] — 2026-06-28

_No notable changes collected from git log._
## [0.1.3] — 2026-06-28

_No notable changes collected from git log._
## [0.1.2] — 2026-06-28

_No notable changes collected from git log._
## [0.1.1] — 2026-06-28

_No notable changes collected from git log._
## [0.1.0] — 2026-06-28

### ✨ New

- **Dashboard** — React webview panel with Pipelines, Activity, Findings, Coverage, Matrix, and Docs tabs
- **Activity Feed** — real-time stream of all pipeline runs triggered from the extension or by MCP agents; entries sourced from `.specguard/activity-log.json`
- **Findings View** — filterable table of lint, security, dependency, and dead-code findings from `specguard quality` / `specguard deps`
- **Coverage View** — per-app donut charts and spec/test bar charts; missing-specs expandable list
- **Flow View** — clickable pipeline node graph showing the full SpecGuard architecture
- **Traceability Matrix tab** — renders `.specguard/traceability.json` produced by `specguard matrix`
- **Docs tab** — displays generated user documentation from `specguard docs`
- **Status bar** — live spec coverage percentage
- **Coverage sidebar** — Explorer tree view of spec/test coverage per app
- **MCP registration** — `SpecGuard: Register MCP Server (Cursor)` command writes `.cursor/mcp.json`
- **Source file drift watcher** — auto-runs `specguard drift` in the background when `src/**` files change (debounced 5s)
- **Auto-docs setting** (`specguard.autoDocs`) — regenerates docs automatically when a spec changes (debounced 3s)
- **Context menu commands** — Generate Tests and Security Scan on `.md` spec files in the Explorer

### 🔧 Internal

- Activity log service with in-memory ring buffer (500 entries) and `.specguard/activity-log.json` persistence (1 MB rotate)
- MCP tool handlers wrapped with `withActivityLog` so agent-triggered runs appear in the Activity Feed without polling
- `release` script (`npm run release [patch|minor|major]`) for version bump + changelog + `.vsix` packaging
