---
title: "Security Pipeline"
sidebar_label: "Security Pipeline"
generated: true
---

# Security Pipeline

## What It Does

The Security Pipeline turns the security constraints documented in your specs into executable test stubs — automatically. For each spec that contains a `## Security Notes` section, the pipeline reads those constraints alongside the referenced source module and asks the AI to generate a [vitest](https://vitest.dev/) test file. Every generated test is annotated with the relevant [OWASP Top 10](https://owasp.org/www-project-top-ten/) category, giving you a direct, traceable link from documented security requirement to runnable test.

Optionally, you can pair stub generation with a live [Semgrep](https://semgrep.dev/) SAST scan of your source tree. When real findings are discovered, they are fed back into the AI prompt so the generated stubs target the concrete issues Semgrep found — not just the abstract constraints in the spec.

---

## Generated Test Files

Security test stubs are written to:

```
tests/security/<feature>.test.ts
```

resolved relative to your project's `rootDir`. The `<feature>` path mirrors the spec's location inside the owning app's `specDir`, with the `.md` extension dropped. For example, a spec at `specDir/auth/login.md` produces `tests/security/auth/login.test.ts`.

Each generated test file contains vitest stubs where every individual test is prefixed with a comment identifying its OWASP category, for example:

```ts
// OWASP A01: Broken Access Control
it('should reject requests from unauthenticated users', () => {
  // TODO: implement
});
```

> **Note:** The pipeline will never overwrite an existing security test file. If a file already exists for a spec, that spec is skipped and recorded as such in the run summary.

---

## Running the Pipeline

### Process a single spec

Use `--spec` with either a spec key or a direct path to a Markdown file:

```
specguard security --spec auth/login
specguard security --spec ./specs/auth/login.md
```

A spec key (e.g. `auth/login`) is resolved under the matching app's configured `specDir`. A direct `.md` path is used as-is.

### Process all specs

Use `--all` to run the pipeline over every spec found under each app's `specDir`:

```
specguard security --all
```

### Include a SAST scan

Add `--with-sast` to any invocation to run a Semgrep scan over the owning app's source repository before generating stubs:

```
specguard security --spec auth/login --with-sast
specguard security --all --with-sast
```

When Semgrep is available and returns findings, those findings are summarised and included in the AI prompt so the generated stubs address real, detected issues. The findings are also included in the run's result detail.

If Docker or Semgrep is unavailable, the SAST step is skipped with a warning — stub generation continues normally and nothing fails.

---

## Exit Codes

| Situation | Exit code |
|---|---|
| Stubs generated successfully (with or without skips) | `0` |
| `--with-sast` ran and returned real findings | `5` |

An exit code of `5` signals that Semgrep found issues worth attention, even if stub generation itself succeeded. This makes the pipeline suitable for use in CI gates.

---

## How the AI Uses Your Spec

The pipeline extracts the `## Security Notes` section from each spec and reads the source module named in the spec's metadata. If the source module is missing or unreadable, the AI is informed of this and generation continues — a missing source file is never a hard failure.

The AI is instructed to:

- Produce a single, complete vitest test file of security stubs
- Annotate every test with the relevant OWASP Top 10 category
- Derive tests from the spec's Security Notes and the surface area of the source module
- Target any SAST findings with concrete regression stubs when findings are provided
- Output only valid TypeScript test code — no Markdown, no prose

Any accidental Markdown fences in the AI's output are stripped automatically before the file is written.

---

## Run Summary

After each run, the pipeline reports:

- How many specs were **generated**, **skipped** (file already exists), or **failed** (AI error)
- Per-spec detail including any SAST findings
- Progress messages throughout the run

A failure on one spec does not stop the pipeline — remaining specs are always processed.
