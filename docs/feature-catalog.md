# Feature catalog

The `feature-catalog` plugin tracks a catalog of product features and the state of each across the channels that implement it: a UI, an API, and agent tools such as an MCP server. It adds `specguard features` and `specguard features --state`, and the `specguard_features` MCP tool.

Nothing about your repo's layout is built in. Where the catalog lives, how feature ids are shaped, which repo implements which channel, and where agent tools are declared are all configuration.

## Enable it

```jsonc
{
  "plugins": ["feature-catalog"],
  "featureState": { /* see below */ }
}
```

A complete example is in [examples/feature-catalog.config.json](examples/feature-catalog.config.json).

## Configuration

All keys are under `featureState`.

| Key | What it does |
|---|---|
| `catalog` | Directory of catalog YAML files, relative to the config or workspace root. |
| `catalogFormat` | `document` (default): files with `version: 1` and a `features:` list. `list`: files that are a bare list of features. |
| `catalogExclude` | File-name globs (`*` and `?`) in the catalog directory that are not features. Matching files are skipped before they are parsed. |
| `resultsDirs` | Directories of normalized test cases (JSON). |
| `reporters` | Test-runner report files or globs read as results (`{ path, kind?, format? }`). |
| `externalIds` | Adapters that read a test-management id from a result: `generic`, `zephyr`, `jira`. |
| `channelByType` | Spec `type:` to channel (`ui`, `api`, `mcp`). |
| `repoChannels` | Repo key to the channel its specs implement, used when a catalog feature omits `requires`. |
| `moduleStems` | Extra directory stems tried when resolving a spec's `module:` to a source file. |
| `idSkipSegments` | Ignore the first N dot-separated segments of a feature id when deciding which sibling feature a test file belongs to. For ids shaped `area.entity.action`, `2` leaves the action. |
| `placeholderSummaryPattern` | Regex. A catalog summary that matches is treated as a placeholder and replaced by the spec's overview. |
| `mcpModulePattern` | Regex (case-insensitive). A spec whose module or key matches implements the MCP channel. |
| `agentTools` | Where agent tools are declared, so a feature's MCP channel can be found from the GraphQL fields its screen calls (below). |

### Finding agent tools

```jsonc
"agentTools": {
  "repo": "mcp-server",                      // key of the repo that holds the tools
  "dir": "src/tools",                        // directory of declarations (default src/tools)
  "namePattern": "server\\.tool\\(\\s*['\"]([^'\"]+)['\"]",   // one capture group: the tool's name (this is the default)
  "excludedPathPattern": "/end-user/"        // tools under matching paths are evidence only
}
```

A tool in an excluded path is recorded but does not count as the feature's MCP channel, which suits tools meant for end users rather than operators.

## Importing contract edges from an older file

Contract edges between repos can also come from a JSON file of spec-to-provider mappings, with the `contract-mappings` plugin:

```jsonc
{
  "plugins": ["contract-mappings"],
  "contractMappings": {
    "file": "qa/links.json",       // default .specguard/contract-mappings.json
    "list": "links",               // key of the list (default "mappings")
    "spec": "consumer",            // key of the consuming spec (default "spec")
    "providers": ["calls"],        // keys listing the files it depends on (default ["providers"])
    "docs": "page",                // key of its documentation page (default "docs")
    "edgeType": "rest"             // contract type for provider edges (default "dependency")
  }
}
```
