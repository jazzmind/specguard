---
id: developing-specguard
kind: journey
title: "Developing SpecGuard"
audience: dev
order: 3
related:
  - spec-first-changes
  - platform-foundation
  - integration-surfaces
  - documentation-api
---

# Developing SpecGuard

## Goal
Build, test and change SpecGuard itself, spec first, the way SpecGuard asks you to change any project; and install a local build or cut a release.

## Prerequisites
Node.js 20 or newer (CI runs the main gates on Node 20; npm publishing runs on Node 24) and npm. Run `make help` for example flows grouped by workflow. The root `package.json` is the single version source for the CLI, the bundled CLI and the VS Code extension.

## Steps
### Set up
```bash
make install-dev
```

This runs `npm ci` in the root, the extension and the webview without installing anything globally.

### The loop for a change
SpecGuard uses SpecGuard. Read the capability spec that owns a file before editing it, change the spec first, then write tests and code:

```bash
specguard spec graph
specguard history add --kind decision --title "Why this changes" --affects documentation-api --decision "What was decided"
specguard check
npm test
```

Tag each test with the requirement it proves, for example `// [claims: capabilities/documentation-api#doc-set-build]`, and put the claim id in the `describe` title. Every `src/` module has a spec; if none exists, write one before coding.

### Build
| Command | Output or purpose |
|---|---|
| `make build` | Builds both the CLI and the extension |
| `make build-cli` | Compiles the CLI into `dist/`, rebuilds the committed plugin hook and copies it to `dist/hooks/` |
| `make build-ext` | Bundles the webview into `extension/media/`, and the embedded CLI and host into `extension/dist/` |
| `make build-hook` | Rebuilds `plugins/specguard/hooks/dist/specguard-hook.mjs`; commit it after changing hook sources or their dependencies |
| `make clean` | Removes root and extension `dist/` directories |

The extension embeds the CLI, so rebuild the extension to pick up CLI changes.

### Validate
| Command | Checks |
|---|---|
| `make typecheck` | CLI TypeScript types without emitting files |
| `make lint` | Repository ESLint and extension host typechecking |
| `make test` | CLI tests, including the committed hook freshness test |
| `make test-ext` | Extension host tests |
| `make ci` | Typecheck, lint, tests, both builds, extension tests and package/bundled CLI version agreement |
| `make check` | Spec ownership, requirement coverage, proof freshness and drift |
| `make prove` | Runs configured tests, records their proof, then runs `check`; use after changing code, specs or lockfiles |
| `make audit` | Dependency advisories for the root and extension |

Run `make build-hook` before tests when hook inputs change: tests check the committed artifact before the build can refresh it. Names of private projects, employers and internal hosts must never appear in tracked files; `tests/regression/no-private-names.test.ts` guards that.

### Regenerate the documentation
These pages are generated from the specs. After changing a guide or a capability spec:

```bash
specguard docs build --no-llm
specguard docs build --check
```

`docs build` renders the guides, index, manifest and help topics deterministically and rewrites a capability's reference page when its spec changed (with a model unless `--no-llm`). `--check` calls no model and exits non-zero when any page is out of date; CI runs it. Commit the result.

### Use the local build
```bash
make install
specguard --help
```

`make install` builds and installs both the CLI (`npm install --global .`) and the extension (`code --install-extension ... --force`). `make install-cli` and `make install-vsix` do one each, `make build-vsix` only writes `extension/specguard-<version>.vsix`. For another editor use `make install-vsix CODE="/path/to/code"`. None of these needs CI to pass or publishes anything.

### Release
```bash
make bump V=x.y.z
make build-hook
make ci
make prove
make publish
make watch
```

1. `make bump V=x.y.z` updates the root and extension packages and lockfiles without tagging. Pick an unused version.
2. Run `make build-hook`, `make ci` and `make prove`, commit including the generated hook and proof, and push `main`.
3. `make publish-dry` previews npm package contents and the tag. `make release-check` verifies a clean `main` equal to `origin/main`, an unused tag and npm version, version agreement and successful CI on this commit, watching queued or running CI to completion.
4. `make publish` repeats the check, asks you to type `vX.Y.Z`, then creates and pushes the tag. The Release workflow runs its gates and publishes the CLI to npm with trusted publishing (OIDC), without an npm token.

Publishing the extension is enabled by the repository variable `PUBLISH_EXTENSION=true` and needs `VSCE_PAT` (and `OVSX_PAT` for Open VSX). To publish or retry only the extension for an existing tag: `make publish-ext TAG=vX.Y.Z`. The extension warns when an installed CLI reports a version other than its own (`specguard --version --json`).

### Activity logs and clean commits
`.specguard/activity-log.json` is local runtime history, never a source artifact. SpecGuard's commit helper refuses to stage it, and `specguard migrate --yes` removes it from tracking in an older repository. If you only need to stop tracking that one file: add it to `.gitignore`, run `git rm --cached -- .specguard/activity-log.json`, and commit.

## Outcome
You can change SpecGuard spec first, prove the change with its own tools, regenerate its documentation, and ship it.

## Related
- [SpecGuard architecture](architecture.md)
- [Extending SpecGuard with plugins](extending-with-plugins.md)
- [Quickstart: adding new features](../guide/new-features.md)
