---
title: "Extending SpecGuard with plugins"
audience: dev
order: 2
source: "specs/guides/extending-with-plugins.md"
generated: true
---
<a id="extending-specguard-with-plugins"></a>
# Extending SpecGuard with plugins

<a id="goal"></a>
## Goal
Write a plugin that adds a command, a contract importer, a security detector or a documentation renderer, and enable it in a project.

<a id="prerequisites"></a>
## Prerequisites
- A project with `.specguard/config.json` (see [Quickstart: plugins](../guide/plugins.md) for enabling and disabling).
- For a built-in plugin, a checkout of SpecGuard; for an npm plugin, a package that exports `plugin`.

<a id="steps"></a>
## Steps
<a id="the-shape-of-a-plugin"></a>
### The shape of a plugin
A plugin is an object with an `id` and any of the optional parts below, exported as `plugin`. The full type, `SpecGuardPlugin`, is in `src/plugins/types.ts`; an npm plugin only has to export an object of that shape.

```ts
export const plugin = {
  id: 'acme',
  meta: { title: 'Acme checks', description: 'Adds the acme command.' },
  commands: [
    {
      name: 'acme',
      description: 'run the acme checks',
      options: [{ flags: '--strict', description: 'fail on warnings' }],
      async run({ config, opts, args }) {
        // return a PipelineResult
      },
    },
  ],
};
```

| Part | What it adds |
|---|---|
| `commands` | CLI commands, also exposed on the MCP server as `specguard_<name>` unless `mcp: false`. Core commands win a name clash. `mcpParams` types the MCP inputs |
| `contractImporters` | Edges for the contract graph from a legacy file; never throws, returns `[]` when its input is missing |
| `endpointExtractors` | Readers of client calls and endpoint definitions for code-based contract mapping |
| `detectors` | Extra findings for `security scan`; they become `code` items in the remediation plan, grouped under the capability that owns the file, and are never patched automatically |
| `docRenderers` | Render a document without a model call; the first to return text wins, `null` passes to the next and finally to the model |
| `catalogProviders`, `discoverers`, `externalIdAdapters`, `resultSources`, `featureState`, `moduleStems` | The feature-catalog extension points |

A command returns a `PipelineResult` (counts, items, messages and an exit code from `src/core/exit-codes.ts`). With `output: 'messages'` the CLI prints only the messages, for commands whose output other tools parse.

<a id="add-a-built-in-plugin"></a>
### Add a built-in plugin
1. Create `src/plugins/<id>/index.ts` exporting `plugin`.
2. Describe it in `src/plugins/catalog.ts` (`BUILTIN_PLUGINS`), which `plugin list` and the editor read. A test keeps the list in step with the plugin directories and each plugin's own `id`.
3. Write the plugin's behavior in a capability spec under `specs/capabilities/` (most plugin behavior belongs to `integration-surfaces`) before the code, and tag its tests with the requirement.

<a id="publish-an-npm-plugin"></a>
### Publish an npm plugin
Export `plugin` from the package's main entry. A project lists it in config as `{ "name": "acme", "package": "@acme/specguard-plugin-acme" }`, or with `specguard plugin add acme --package <name> --install --yes`. SpecGuard resolves the package from the project's own `node_modules` and refuses names that are not valid npm package names. Importing a package runs its code, which is why `--yes` is required.

<a id="test-it"></a>
### Test it
Load the plugin through `loadPlugins` in a vitest test with a temporary config, call the command's `run` and assert on the `PipelineResult`. The existing plugin tests under `tests/plugins/` are the model.

<a id="use-plugins-to-render-docs"></a>
### Use plugins to render docs
A `docRenderer` receives the audience, the capability id, its title and the spec's text, and returns Markdown. Because enabled renderers are part of the documentation cache key, enabling or removing one regenerates what it covers.

<a id="outcome"></a>
## Outcome
Your plugin's commands appear in `specguard --help`, in `specguard plugin list` and as MCP tools, and its parts take part in the pipelines they extend.

<a id="related"></a>
## Related
- [Quickstart: plugins](../guide/plugins.md)
- [SpecGuard architecture](architecture.md)
- [Developing SpecGuard](developing-specguard.md)

<a id="reference-pages"></a>
## Reference pages

- [Integration Surfaces - CLI, Agents, CI, IDE and Plugins](./reference/integration-surfaces.md)
- [Workspaces - Multi-Repo and Monorepo](./reference/workspaces.md)
- [Documentation and API](./reference/documentation-api.md)
- [Security Scanning and Remediation](./reference/security-and-remediation.md)
