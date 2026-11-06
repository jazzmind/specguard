---
title: "How SpecGuard fits with other tools"
audience: user
order: 2
source: "specs/guides/fits-with-tools.md"
generated: true
---
<a id="how-specguard-fits-with-other-tools"></a>
# How SpecGuard fits with other tools

<a id="goal"></a>
## Goal
See where SpecGuard plugs into the tools you already use: coding agents, CI, your editor, your test frameworks, a model provider, and an optional team server.

<a id="prerequisites"></a>
## Prerequisites
Node.js 20 or newer. The CLI is the npm package `specguard-ai`; the command is `specguard`. The name `specguard` alone on npm is a different, unrelated package, so `npx specguard` is the wrong command.

<a id="steps"></a>
## Steps
<a id="coding-agents-claude-code-codex-cursor"></a>
### Coding agents: Claude Code, Codex, Cursor
Three mechanisms connect SpecGuard to an agent, and they share one core.

- **MCP server.** `specguard-mcp` exposes SpecGuard as tools (`specguard_check`, `specguard_test_run`, `specguard_change_start`, `specguard_docs` and more) so an agent can call them without a shell. `specguard init` registers it; to do it by hand add it to your MCP configuration:

```json
{
  "mcpServers": {
    "specguard-mcp": { "command": "npx", "args": ["-y", "-p", "specguard-ai", "specguard-mcp"] }
  }
}
```

- **Hooks.** An edit guard runs before every agent edit or shell command and enforces the capability's `enforce` level (`observe`, `warn` or `enforce`). The Claude Code plugin wires it already; for Codex run `specguard init --codex`.
- **Skills and plugins.** The Claude Code plugin ships skills (`specguard`, `specguard-change`, `specguard-agent-work`) and the commands `/specguard:start` and `/specguard:check`. Cursor reads `.cursor/skills/specguard/SKILL.md`.

```
/plugin marketplace add jazzmind/specguard
/plugin install specguard@specguard
/specguard:start
```

<a id="host-agent-mode-no-api-key"></a>
### Host-agent mode: no API key
Inside a coding agent the agent itself does the model work. When a step needs a model, SpecGuard writes a request under `.specguard/agent-requests/` and exits with code 12, which means "waiting for the agent", not failure. The agent answers with `specguard agent pending` and `specguard agent answer`, and you rerun the same command. Set `SPECGUARD_HOST_AGENT=1` in shells that do not announce themselves (Codex).

<a id="model-providers-including-proxies"></a>
### Model providers, including proxies
Outside an agent, set the provider in `llm` in `.specguard/config.json`: `anthropic`, `openai`, `litellm`, `replay` or `none`. The `litellm` provider talks to any LiteLLM-style proxy at `LITELLM_BASE_URL` (default `http://localhost:4000`), and `openai` accepts `OPENAI_BASE_URL` for any OpenAI-compatible server, so a company gateway or a local model works. Keep keys out of the committed config with `specguard key set`. Use `llm.budget` to cap spend, per-pipeline model overrides to use a cheaper model where it is enough, and `replay` to run CI offline from recorded answers.

<a id="test-frameworks-and-results"></a>
### Test frameworks and results
SpecGuard never replaces your runner. Tag tests with the requirement they prove (`// [claims: capabilities/shop#free-shipping]`), run them however you do now, and ingest the reports:

```bash
specguard results ingest reports/vitest.json reports/playwright.json
specguard proof status
```

Reports from Vitest, Jest, Playwright, JUnit XML (also pytest, Maven and `go-junit-report`), `go test -json` and `cargo test` are read directly. `specguard test run` runs the configured suites itself and ingests each with its layer.

<a id="ci-the-github-action"></a>
### CI: the GitHub Action
The action `jazzmind/specguard@v0` runs the gates you choose (`check`, `test`, `scan`, `proof`, `publish` and others), comments on the pull request, uploads findings to code scanning, and stores evidence. `specguard init --ci github` writes the workflows. See [QA automation](qa-automation.md).

<a id="git-notes-proof-store"></a>
### Git-notes proof store
CI evidence is written as a git note on the commit under `refs/notes/specguard` by `specguard proof publish` (or `specguard ci run`). `check` reads it after `specguard proof fetch`. No server and no artifact store is needed to know what CI proved for a commit.

<a id="vs-code-and-cursor-extension"></a>
### VS Code and Cursor extension
The extension gives you a dashboard per repository, a workspace dashboard across repositories, sidebar views, and this documentation inside the editor. See [The VS Code extension](vscode-extension.md).

<a id="team-server"></a>
### Team server
An optional server shows everyone the same proof state, documents and security findings. If it is down, commands fall back to local files. See [Collaborating with a team](team-collaboration.md).

<a id="outcome"></a>
## Outcome
You know which integration to use for which job: MCP and hooks for agents, the action for CI, the extension for people, the proof store for CI evidence, and a provider (or the host agent) for model work.

<a id="related"></a>
## Related
- [Core concepts](concepts.md)
- [Quickstart: one repository](single-repo.md)
- [QA automation](qa-automation.md)

<a id="reference-pages"></a>
## Reference pages

- [Integration Surfaces - CLI, Agents, CI, IDE and Plugins](./reference/integration-surfaces.md)
- [Platform Foundation](./reference/platform-foundation.md)
- [Proof Store](./reference/proof-store.md)
- [Local-first operation with an optional team server](./reference/team-server.md)
