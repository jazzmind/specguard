# specguard init — Scaffold Config and Specs Directory

<!-- module: src/cli/commands/init.ts / type: cli / status: draft -->

## Overview

The `specguard init` command bootstraps a new SpecGuard workspace by creating the `.specguard/config.json` configuration file, a `specs/README.md` living-specification directory, a `.specguard/.env` placeholder for the LLM API key, and a `.specguard/drift-registry.json` registry file. It never overwrites files that already exist, reporting each path as either `created` or `skipped`. The command auto-detects the test framework (`playwright` > `jest` > `vitest`) from the nearest `package.json` dependencies, with an explicit `--withPlaywright` flag available to force Playwright regardless of detection. After scaffolding, it appends `.specguard/.env` to `.gitignore` on a best-effort basis to prevent accidental credential commits, then prints next-step instructions and exits.

## Acceptance Criteria

- AC-1: Running `specguard init` in a clean directory creates `.specguard/config.json`, `specs/README.md`, `.specguard/.env`, and `.specguard/drift-registry.json`.
- AC-2: Re-running `specguard init` in a directory where those files already exist skips all four files without modifying them.
- AC-3: The detected framework is reflected in `config.json` (`framework` field and `heal.testCommand`).
- AC-4: When `opts.withPlaywright` is `true`, the framework is forced to `playwright` regardless of `package.json` contents.
- AC-5: Framework detection priority is: `@playwright/test` or `playwright` → `jest` → `vitest`; falls back to `vitest` when `package.json` is absent or malformed.
- AC-6: `.specguard/.env` contains only a placeholder value for `ANTHROPIC_API_KEY`; no real secret is written.
- AC-7: `.specguard/.env` is appended to `.gitignore` if the entry is not already present; the existing `.gitignore` content is preserved.
- AC-8: `drift-registry.json` is initialised with the content `{}\n`.
- AC-9: stdout reports the detected framework, each `created` path, each `skipped` path, and next-step instructions.
- AC-10: The process exits with code `0` after successful execution.

## Scenarios

### Scenario 1: Fresh workspace with no package.json

**Steps:**
1. Set `cwd` to an empty temporary directory containing no files.
2. Call `initCommand({})`.

**Expected Results:**
- `.specguard/config.json` is created with `framework` set to `"vitest"` and `heal.testCommand` set to `"npm test"`.
- `specs/README.md` is created and contains the heading `# Living Specifications`.
- `.specguard/.env` is created and contains the line `ANTHROPIC_API_KEY=your-api-key-here` (placeholder only — no real key).
- `.specguard/drift-registry.json` is created with content `{}\n`.
- `.gitignore` is created and contains `.specguard/.env`.
- stdout includes `framework: vitest`, four `created` lines, and the next-steps block.
- Process exits with code `0`.

### Scenario 2: Framework auto-detection — Playwright wins

**Steps:**
1. Set `cwd` to a temporary directory containing a `package.json` with `devDependencies` including `"@playwright/test": "^1.0.0"` and `"jest": "^29.0.0"`.
2. Call `initCommand({})`.

**Expected Results:**
- `.specguard/config.json` is created with `framework` set to `"playwright"`.
- `heal.testCommand` in the generated config equals `"npx playwright test"`.
- stdout includes `framework: playwright`.

### Scenario 3: Framework auto-detection — Jest wins over Vitest

**Steps:**
1. Set `cwd` to a temporary directory containing a `package.json` with `devDependencies` including `"jest": "^29.0.0"` and `"vitest": "^1.0.0"`.
2. Call `initCommand({})`.

**Expected Results:**
- `.specguard/config.json` is created with `framework` set to `"jest"`.
- `heal.testCommand` in the generated config equals `"npm test"`.
- stdout includes `framework: jest`.

### Scenario 4: --withPlaywright flag overrides detection

**Steps:**
1. Set `cwd` to a temporary directory containing a `package.json` with only `"jest"` in `devDependencies`.
2. Call `initCommand({ withPlaywright: true })`.

**Expected Results:**
- `.specguard/config.json` is created with `framework` set to `"playwright"`.
- `heal.testCommand` equals `"npx playwright test"`.
- stdout includes `framework: playwright`.

### Scenario 5: All files already exist — nothing overwritten

**Steps:**
1. Set `cwd` to a temporary directory that already contains `.specguard/config.json`, `specs/README.md`, `.specguard/.env`, and `.specguard/drift-registry.json`, each with distinct sentinel content.
2. Record the content of each file before calling `initCommand({})`.
3. Call `initCommand({})`.
4. Read the content of each file after the call.

**Expected Results:**
- The content of each file is identical to the sentinel content recorded in step 2 (no overwrite occurred).
- stdout contains four `skipped` lines, one for each file path.
- No `created` lines appear in stdout.
- Process exits with code `0`.

### Scenario 6: .gitignore already contains the entry

**Steps:**
1. Set `cwd` to a temporary directory with an existing `.gitignore` whose content already includes `.specguard/.env`.
2. Record the exact content of `.gitignore`.
3. Call `initCommand({})`.
4. Read `.gitignore` after the call.

**Expected Results:**
- `.gitignore` content is identical to the content recorded in step 2 (no duplicate entry appended).
- stdout does not include `.gitignore (updated)` in the `created` list.

### Scenario 7: .gitignore exists but lacks the entry

**Steps:**
1. Set `cwd` to a temporary directory with an existing `.gitignore` containing `node_modules/` but not `.specguard/.env`.
2. Call `initCommand({})`.
3. Read `.gitignore` after the call.

**Expected Results:**
- `.gitignore` still contains `node_modules/`.
- `.gitignore` now also contains `.specguard/.env`.
- stdout includes `.gitignore (updated)` in the `created` list.

### Scenario 8: Malformed package.json falls back to vitest

**Steps:**
1. Set `cwd` to a temporary directory containing a `package.json` with invalid JSON content (e.g., `{ broken`).
2. Call `initCommand({})`.

**Expected Results:**
- `.specguard/config.json` is created with `framework` set to `"vitest"`.
- The command does not throw or crash.
- stdout includes `framework: vitest`.

## Security Notes

- The `.specguard/.env` file is written with a placeholder string (`your-api-key-here`) only; no real API key or secret value is ever written by this command.
- The `apiKeyEnv` field in `config.json` stores only the environment variable **name** (`ANTHROPIC_API_KEY`), not the key value itself.
- The command appends `.specguard/.env` to `.gitignore` to reduce the risk of accidental credential exposure in version control.
- The `.gitignore` update is best-effort; failures are silently swallowed, so users should verify the entry is present after running `init`.

## Dependencies

- `src/core/reader.ts` — `fileExists`, `readFile` utilities used for existence checks and reading `package.json` / `.gitignore`.
- `src/core/writer.ts` — `writeFile` utility used to create all scaffolded files.
- Node.js built-in `node:path` — path construction for all target file locations.
- `package.json` in the working directory — optional; used for framework auto-detection.