---
title: "Quickstart: plugins"
audience: user
order: 21
source: "specs/guides/plugins.md"
generated: true
---
<a id="quickstart-plugins"></a>
# Quickstart: plugins

> See, turn on and off, and add the plugins that extend SpecGuard with commands and integrations.

<a id="goal"></a>
## Goal
List the plugins your project can use, turn them on and off, and add one from npm.

<a id="prerequisites"></a>
## Prerequisites
A project set up with `specguard init`. Plugins are named in `plugins` in `.specguard/config.json`.

<a id="steps"></a>
## Steps
<a id="see-what-is-available"></a>
### See what is available
```bash
specguard plugin list
```

Lists built-in and configured npm plugins, on or off, with the commands each adds. Built in:

| Plugin | Adds |
|---|---|
| `quality` | `specguard quality`: ESLint, Knip and Ruff findings in `.specguard/code-quality.json` |
| `git` | `specguard commit`: stage and commit only generated files (tests, docs, specs, reports), never source code |
| `feature-catalog` | `specguard features [--state]`: a feature catalog and its state across UI, API and agent-tool channels |
| `contract-mappings` | contract edges from a mappings file, and `specguard contracts-map` to write the mappings |

`specguard init` enables `quality` and `git` for new projects.

<a id="turn-one-on-or-off"></a>
### Turn one on or off
```bash
specguard plugin enable feature-catalog
specguard plugin disable quality
```

These edit only this repository's `.specguard/config.json`. A plugin enabled only by a config you `extends` is turned off with `disabledPlugins`, because `extends` replaces arrays rather than merging them. A plugin that cannot be loaded is reported once and its commands are skipped; core commands win a name clash.

<a id="add-an-npm-plugin"></a>
### Add an npm plugin
```bash
specguard plugin add acme --package @acme/specguard-plugin-acme --install --yes
specguard plugin remove acme
```

Adding an npm plugin imports the package to check that it is a plugin, which runs its code, so `--yes` is required. `--install` installs with scripts disabled. The extension asks with a modal that names the package.

<a id="configure-the-feature-catalog"></a>
### Configure the feature catalog
The `feature-catalog` plugin keeps nothing about your layout built in. Its settings live under `featureState`:

| Key | What it does |
|---|---|
| `catalog` | Directory of catalog YAML files, relative to the config or workspace root |
| `catalogFormat` | `document` (default: files with `version: 1` and a `features:` list) or `list` (bare lists) |
| `catalogExclude` | File-name globs in the catalog directory that are not features |
| `resultsDirs`, `reporters` | Normalized test results, or test-runner report files read as results |
| `externalIds` | Adapters reading a test-management id from a result: `generic`, `zephyr`, `jira` |
| `channelByType`, `repoChannels` | Which channel (`ui`, `api`, `mcp`) a spec type or repository implements |
| `agentTools` | Where agent tools are declared, so a feature's MCP channel can be found |

```bash
specguard features
specguard features --state
```

A full example config is in `docs/examples/feature-catalog.config.json`.

<a id="read-contract-mappings-from-an-older-file"></a>
### Read contract mappings from an older file
```json
{
  "plugins": ["contract-mappings"],
  "contractMappings": { "file": "qa/links.json", "list": "links", "spec": "consumer", "providers": ["calls"], "edgeType": "rest" }
}
```

The file's location and keys are configuration, so a mapping file in another shape is read as it is.

<a id="in-the-editor"></a>
### In the editor
The Plugins view lists them with Enable, Disable, Add and Remove, and the Pipelines view shows only the actions of enabled plugins. Both are also available as `GET /api/v1/plugins` and the `specguard_plugin_list` MCP tool.

<a id="outcome"></a>
## Outcome
You know which plugins are on, what each adds, and how to add your own. To write one, see [Extending SpecGuard with plugins](../dev/extending-with-plugins.md).

<a id="related"></a>
## Related
- [Extending SpecGuard with plugins](../dev/extending-with-plugins.md)
- [Contracts](contracts.md)
- [The VS Code extension](vscode-extension.md)

<a id="reference-pages"></a>
## Reference pages

- [Integration Surfaces - CLI, Agents, CI, IDE and Plugins](./reference/integration-surfaces.md)
- [Platform Foundation](./reference/platform-foundation.md)
