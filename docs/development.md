# Working on and releasing SpecGuard

Run `make help` for example flows and commands grouped by workflow. The root
`package.json` is the version source for the CLI, bundled CLI and VS Code extension.

## Use SpecGuard locally

To use the published CLI, run `npm install --global specguard-ai`. To use this
checkout instead, run:

```sh
make install-dev  # install locked build dependencies
make install     # build and install both the CLI and VS Code extension
specguard --help
```

You can also install either tool separately, or only build the VSIX:

| Command | What it does |
| --- | --- |
| `make install` | Runs `install-cli` and `install-vsix` to build and install both tools locally. |
| `make install-cli` | Builds this checkout's CLI and hook, then installs the CLI globally with `npm install --global .`. |
| `make install-vsix` | Builds and packages the extension, then installs it into VS Code with `--force`. |
| `make build-vsix` | Builds the extension and writes `extension/specguard-<version>.vsix` without installing it. |

`install-vsix` finds `code` on PATH or in a standard macOS VS Code app location.
For another location or a compatible editor, use
`make install-vsix CODE="/path/to/code"` (or `make install CODE="/path/to/code"`).
These commands do not need GitHub CI to pass and do not create release tags or
publish packages.

## Develop locally

Use Node.js 20 or newer and npm. CI runs the main gates on Node 20; npm publishing
runs on Node 24. Use `make install-dev` after cloning or changing a lockfile: it
runs `npm ci` in the root, extension and webview without installing either tool
globally.

```sh
make install-dev
# Edit code and its specs, then:
make build-hook
make ci
make prove
# Install the updated tools for local use:
make install
```

| Command | Output or purpose |
| --- | --- |
| `make build` | Builds both the CLI and extension. |
| `make build-cli` | Compiles the CLI into `dist/`, rebuilds the committed plugin hook and copies it to `dist/hooks/`. |
| `make build-ext` | Bundles the webview into `extension/media/`, and the embedded CLI and host into `extension/dist/`. Dependencies must already be installed. |
| `make build-hook` | Rebuilds `plugins/specguard/hooks/dist/specguard-hook.mjs`; commit it after changing hook sources or their dependencies. |
| `make clean` | Removes root and extension `dist/` directories. |

The extension embeds the CLI, so rebuilding the extension is necessary to pick up
CLI changes. It does not require a separately installed CLI.

## Validate changes

| Command | Checks |
| --- | --- |
| `make typecheck` | CLI TypeScript types without emitting files. |
| `make lint` | Repository ESLint and extension host typechecking. |
| `make test` | CLI tests, including the committed hook freshness test. |
| `make test-ext` | Extension host tests. |
| `make ci` | Typecheck, lint, CLI tests, both builds, extension tests and package/bundled CLI version agreement. |
| `make check` | Spec ownership, requirement coverage, proof freshness and drift. |
| `make prove` | Runs configured tests, records their proof, then runs `check`. Use after changing code, specs or lockfiles. |
| `make audit` | Dependency advisories for the root and extension. |

Run `make build-hook` before tests when hook inputs change. Tests deliberately
check the committed artifact before the build can refresh it. A local pass can
still differ from CI if it uses a different Git default branch or dependency
layout; the fixtures pin their branch to `main`, and bundle regression tests
compare working bundles across npm and pnpm layouts.

`make ci` runs local build and test gates. GitHub CI also executes the repository's
Action against SpecGuard itself (`status,proof`, failing on failed or stale
proofs). `make prove` refreshes the local evidence this check reads. None of these
commands publishes a release.

## Publish a release

For example, after setting up development dependencies:

```sh
make bump V=x.y.z  # replace x.y.z with the next unused version
make build-hook
make ci
make prove
# Commit the release changes and push main, then:
make publish      # waits for CI on this commit before confirming and tagging
make watch        # follows publishing progress
```

1. Run `make bump V=x.y.z` to update the root and extension packages and lockfiles
   without creating a tag. If already published, choose a new version.
2. Run `make build-hook`, `make ci` and `make prove`. Commit the changes, including
   the generated hook and proof, then push `main`. You can run `make publish`
   while GitHub CI is still queued or running; it waits for completion.
3. Optionally run `make publish-dry` to preview npm package contents and the tag.
   It does not build, run release gates or contact the registries to publish.
4. Run `make release-check` to verify clean `main`, equality with `origin/main`,
   an unused tag and npm version, package version agreement and successful CI on
   this commit when `gh` is available. It fetches refs and queries npm/GitHub; it
   does not rerun tests or publish. When CI is queued, requested, waiting, pending
   or running, it displays progress with `gh run watch` and refreshes every ten
   seconds. It continues only after that run succeeds for the exact commit.
5. Run `make publish`. It repeats `release-check`, asks you to type `vX.Y.Z`, then
   creates and pushes that tag. `YES=1` skips the prompt. The pushed tag starts
   the Release workflow, which runs its gates and publishes the CLI to npm.

Extension publication in the Release workflow is enabled by the repository
variable `PUBLISH_EXTENSION=true`. It needs `VSCE_PAT`; `OVSX_PAT` additionally
enables Open VSX. npm uses trusted publishing (OIDC), without an npm token.

To publish or retry only the extension for an existing release tag, use
`make publish-ext TAG=vX.Y.Z`. This starts the Publish extension workflow and
attaches the VSIX to that tag's GitHub release. `make watch` follows the latest
GitHub Actions run, which can also be a CI run.

If CI fails, is cancelled, or watching is interrupted, the release check exits
without tagging. If no run exists yet, it asks you to push main and retry once CI
starts. Authentication or API errors also stop the release check. Fix a failing
Actions job and push again before retrying. Local builds and VSIX installation
remain available while CI is failing. The GitHub CLI commands default to the
`jazzmind` account; override `GH_USER` if needed.

## Activity logs and clean commits

`.specguard/activity-log.json` is local runtime history, never a source artifact.
MCP and extension logging honor your ignore rules or add a project-specific rule
to Git's local `info/exclude`, which does not change the working tree. This also
covers nested projects and linked worktrees. SpecGuard's commit helper refuses
to stage activity logs even if they are explicitly included in a change scope.

An older repo may already track the file; ignores do not apply to tracked files.
For just that file, run these commands from the affected project's folder:

```sh
printf '\n.specguard/activity-log.json\n' >> .gitignore
git rm --cached -- .specguard/activity-log.json
git add -- .gitignore
git commit -m "chore: stop tracking runtime activity"
```

The file stays on disk. `specguard migrate --yes` also handles tracked activity
logs as part of the broader generated-state migration. After the one-time removal
is committed, subsequent activity entries do not create another Git change.
