---
title: "Workspaces - Multi-Repo and Monorepo"
audience: user
source: "specs/capabilities/workspaces.md"
generated: true
---
<a id="workspaces-multi-repo-and-monorepo"></a>
# Workspaces: Multi-Repo and Monorepo

<a id="why-it-exists"></a>
## Why it exists

Real systems rarely fit in one repo with one package. A web app calls an API in another repo, a test repo drives both, a docs repo describes them, and a monorepo may hold a dozen packages. A tool that looks at one repo at a time can't tell you that changing an API's interface breaks a consumer somewhere else.

Workspaces let you treat several repos, or several packages in one monorepo, as one system. When something changes in one place, you can see what else needs re-checking.

<a id="what-you-can-do"></a>
## What you can do

<a id="register-your-repos-as-a-workspace"></a>
### Register your repos as a workspace
- Run `specguard workspace init` in a folder of sibling repos. Each repo that has a SpecGuard setup is registered.
- Each repo is named after its folder. Its role (consumer, provider, test or docs) is guessed from what it contains, such as test frameworks, UI or server dependencies, API schema files and language markers.
- Run `workspace init --from <file>` to register the folders of an editor workspace file, or `--recursive` to search nested folders.
- `workspace sync` keeps the registered list in step with an editor workspace file. It adds new folders, reports folders missing on disk, and removes or ignores dropped folders. It never changes entries you edited by hand.
- `workspace status` shows each repo's role, spec count, incoming and outgoing contract links, and configuration health. It also shows how many links are verified versus stale.
- Use `workspace ignore <key>` and `workspace unignore <key>` to leave a repo or unit out of every workspace operation.
- Point any workspace command at a specific workspace with `--workspace <path>` or the `SPECGUARD_WORKSPACE` environment variable.

<a id="map-the-contracts-between-specs"></a>
### Map the contracts between specs
- In a spec's Dependencies section, list the specs it depends on in a contracts block. Each line looks like `<repoKey>::<specPath> [<type>: <surface>, ...]`. The block sits between `<!-- contracts:start -->` and `<!-- contracts:end -->`.
- Link types are graphql, rest, iframe, upload, event, test and docs. Lines that don't match the format are skipped.
- Run `specguard contracts` to build the cross-repo graph. Links can also come from enabled plugins.
- Add `--with-llm` to also read free-text dependencies from specs that have no contracts block.
  - Before sending anything, SpecGuard tells you which provider and model it will use and lists each spec it will send. Only the Dependencies sections go to the model.
  - It stops at `--max-llm-specs` (default 50) and names the specs it left out.
- Re-running `contracts` keeps existing links and merges new ones. `--force` rebuilds from scratch, and `--repo <key>` limits the run to one repo.

<a id="ask-what-is-affected"></a>
### Ask "what is affected?"
- Run `specguard impact <target>` before changing an interface. The target can be a spec's node id (`<repo>::<specPath>`), a path, a unit, or a file inside a unit.
- Direct and transitive consumers are listed separately, with the link type and surface that connects them. The default search depth is 6, and you can change it with `--max-depth`.
- `--upstream` also lists the providers the target depends on.
- For each affected consumer repo, you get a suggested drift command. Docs links get an "update docs" suggestion. For units, impact also lists the capabilities that have code in the affected units.
- Impact only reports and suggests. It never changes your files.

<a id="check-consumers-after-a-provider-changes"></a>
### Check consumers after a provider changes
- Run `specguard workspace drift --since origin/main`. The default is the previous commit.
- SpecGuard finds which repos changed, maps the changes to the graph, and runs drift in each affected consumer repo.
- Each consumer is reported as drifted, no drift, skipped or error. `--force` and `--repo <key>` are available.

<a id="work-in-a-monorepo"></a>
### Work in a monorepo
- `specguard init` detects pnpm, Yarn and npm workspaces, Nx, Turbo, Lerna, Go workspaces, Cargo workspaces and uv workspaces. A repo can use several of these.
- For each package it records the name, directory, test framework and whether it has a test script.
- Each package gets a test command that runs only that package's tests through your own tooling. For example, a pnpm repo uses `pnpm --filter <name> test`.
- Use `init --single` to treat the whole repo as one app instead.
- A workspace can mix repos and packages. Both are called units, and dependencies between units become contract links automatically.
- `check` at the workspace root shows each unit's source files, unowned files, and the capabilities that touch it. A capability spanning several packages appears under each one and gets a single drift verdict.
- `test run` runs every package's tests. `--unit <keys...>` limits it to named units. `--affected [--since <ref>]` runs the changed units plus every unit that depends on them. If a changed file belongs to no unit, everything runs.
- A claim can be referenced across repos as `repo:specKey#claim`, or `specKey#claim` within the current repo. A reference through a package unit, such as `api:capabilities/auth#logout`, means the workspace root's claim.

<a id="see-the-whole-system"></a>
### See the whole system
- `check --workspace` prints a combined rollup for every active repo and in total. It covers:
  - coverage
  - proven, failed, stale and unproven claims
  - claims by test layer
  - open security items by severity
  - documentation freshness
  - intent gaps
- Repos with no numbers show a state explaining why. Ignored repos are listed but add nothing to the totals.
- Add `--refresh` to run `check` in each repo first.
- `serve --workspace` serves every active repo as a project, read-only, with the rollup available.

<a id="organize-the-workspace-as-a-business-story"></a>
### Organize the workspace as a business story
- A workspace can have a business overview and ordered journeys, groups and steps. These link features, specs and claims across repos.
- You can create, edit, reorder and remove this organization from the CLI or the editor without renaming specs or claims.
- Missing references and draft or reviewed status are shown separately from proof.
- If someone else saved first, your save is rejected as outdated.
- Optional automatic drafting uses your configured model access and existing specs only, and writes a proposal for you to review.
  - It rejects invented references.
  - It keeps your existing descriptions, order and references, and marks journeys with new steps as draft.
  - It refuses to apply a proposal if the organization or catalogs changed in the meantime.

<a id="share-with-a-team-server"></a>
### Share with a team server
- `workspace publish [--name n] [--server url]` defines the workspace on your team server. Each repo is named by the manifest's server project map, else its own server project, else its folder. Ignored repos are flagged.
- The server keeps named workspaces and can show a combined rollup from each project's newest snapshot. Projects with no snapshot show as `no-trace`.
- Only a maintainer with an unscoped token can define a workspace. A token limited to one project can't, and sees only a workspace made of that project alone.
- Each repo still publishes its own snapshot.

<a id="keep-api-keys-in-one-place"></a>
### Keep API keys in one place
- A workspace-level `.specguard/.env` supplies shared keys to every repo in the workspace. A repo's own file takes precedence over it.
- A per-user file (`~/.config/specguard/.env`, or under `$XDG_CONFIG_HOME`) covers every workspace on your machine at the lowest precedence. Real environment variables always win.
- `specguard key set` saves your model API key into the user, workspace or repo file with restricted permissions. It reads the key from a hidden prompt, stdin or `--from-env`, never from a command argument. It won't print the key or accept a multi-line value.
- `specguard key status` tells you which files define the key without showing it.
- If a `.env` file is readable by other users, SpecGuard warns you, names the file and suggests `chmod 600`. It still loads the file.

<a id="plugin-commands-at-a-workspace-root"></a>
### Plugin commands at a workspace root
If the workspace root folder has no config of its own but a workspace manifest exists, plugin commands are still available. They come from the plugins enabled across the workspace's repos.

<a id="what-to-expect"></a>
## What to expect

- **Safe re-runs.** `workspace init` never overwrites an existing manifest. It tells you the manifest exists and changes nothing. If it finds no repos, it fails with guidance.
- **Missing or invalid setup.** A missing workspace manifest gives a clear "not found" error. An invalid manifest gives a configuration error. A repo without its own config loads without one rather than failing.
- **Warnings, not failures.** Problems in the contract graph, such as a link naming a spec that doesn't exist, are reported as warnings and don't fail `contracts`.
- **One name per spec.** Every pass names a spec by its repo and repo-relative path, so a spec found by a contracts block and by the model is one entry. If you built a graph with an earlier version, run `contracts --force` to correct it.
- **Impact results.**
  - A target with no consumers prints "No downstream consumers found" and exits 0.
  - A target that can't be resolved explains why, shows an example id format, and exits 1.
  - With no graph yet, you get guidance to build one and the command exits 1.
- **Status prompts.** `workspace status` tells you to build the graph if none exists.
- **Exit codes.** 0 means success. 1 means a missing manifest or an unresolvable target. 3 means a consumer has drifted. For `check --workspace`, the exit code is the worst outcome among the repos: validation failed, drift, or missing specs.
- **Ignored entries.** Ignored repos and units are skipped by contracts, impact, drift, tests, security, proofs and the rollup. Folders with no SpecGuard config are ignored automatically, and that ignore lifts once a config appears.
- **Boundaries.**
  - Only repos named in the manifest are read or touched.
  - Monorepo detection reads configuration only. It never runs project code or scripts.
  - The graph and manifest hold repo names, spec paths and surface names, not secrets.
  - Use `--with-llm` with care for sensitive specs, because it sends their Dependencies text to the model.
- **What it doesn't do.** It doesn't manage git branches or releases, edit consumer code or specs for you, replace your build tool, or trace runtime traffic. Links come from declared blocks, plugins, optional model extraction and package manifests.
