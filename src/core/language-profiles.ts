/**
 * Language profiles — the single source of truth for everything
 * language-specific in SpecGuard.
 *
 * Spec: specs/core/language-profiles.md
 *
 * A `LanguageProfile` is a pure data+function record. Pipelines never hardcode
 * `.test.ts`, `npm test`, `vitest`, or `.ts` regexes; they call
 * `resolveProfile(app)` and read the relevant field. The TypeScript profile
 * reproduces the values previously hardcoded across the pipelines exactly, so
 * existing configs (which carry no `language` field) behave identically.
 */
import path from 'node:path';

import type { AppSources } from './types.js';
import { fileExists, expandGlobs, readFile } from './reader.js';

export type LanguageId = 'typescript' | 'python' | 'go' | 'rust' | 'java';

/** Test-generation / heal maturity for a profile. */
export type Capability = 'full' | 'stub';

/** Marker for a runner that has no equivalent in a given language. */
export type RunnerSupport<T extends string> = T | 'unsupported';

/** A single failing test parsed from a test-runner's machine-readable output. */
export interface FailingTest {
  file: string;
  name: string;
  message: string;
}

export interface LanguageProfile {
  id: LanguageId;
  capability: Capability;

  // --- detection ---------------------------------------------------------
  /** Marker files whose presence indicates this language (e.g. package.json). */
  detectFiles: string[];
  /** Source-extension globs used to count files when markers are ambiguous. */
  detectGlobs: string[];

  // --- config defaults emitted by init -----------------------------------
  sourceGlobs: Required<Pick<AppSources, 'routes' | 'api' | 'tests'>>;
  testOutput: string;
  /** Default test framework written into config (`framework`). */
  testFramework: string;
  /** Default `heal.testCommand`. */
  testCommand: string;
  /** Suffix appended to the test command so output is machine-readable. */
  testReporterArgs: string;

  // --- feature / extension derivation ------------------------------------
  /**
   * Suffix appended to a feature key to form the canonical generated test
   * filename (e.g. `.test.ts` ⇒ `reader.test.ts`, `_test.py` ⇒ `reader_test.py`).
   */
  testExt: string;
  /** Ordered regexes stripped from a source path to derive its feature key. */
  featureExtRegex: RegExp[];
  /**
   * Relative test filenames to probe when checking whether a feature already
   * has a test (covers per-language naming conventions, not just the canonical
   * `testExt`). Returns names without a directory prefix.
   */
  testFileCandidates: (feature: string) => string[];

  // --- LLM prompt fragments ----------------------------------------------
  testPromptRules: Record<'unit' | 'integration' | 'e2e', string[]>;
  testPromptDefault: string[];
  securityPromptRules: string[];
  /** Example file path shown to the LLM in gap-analysis plan schemas. */
  planFileHint: string;

  // --- heal ---------------------------------------------------------------
  /** Parse the test runner's machine-readable output into failing tests. */
  parseTestOutput: (stdout: string) => FailingTest[] | null;

  // --- quality / deps adapters -------------------------------------------
  lintRunner: RunnerSupport<'eslint' | 'ruff'>;
  deadCodeRunner: RunnerSupport<'knip' | 'vulture'>;
  auditRunner: RunnerSupport<'npm-audit' | 'pip-audit'>;
}

// ---------------------------------------------------------------------------
// Shared parsers
// ---------------------------------------------------------------------------

/** Locate the first balanced top-level JSON object in arbitrary stdout. */
function extractJsonObject(stdout: string): string | null {
  const start = stdout.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i += 1) {
    const ch = stdout[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return stdout.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse vitest's Jest-compatible JSON reporter output. Mirrors the original
 * `parseVitestJson` in heal.ts exactly. Returns `null` when no JSON object can
 * be located/parsed so callers can degrade gracefully.
 */
export function parseVitestJson(stdout: string): FailingTest[] | null {
  const json = extractJsonObject(stdout);
  if (!json) return null;

  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;

  const testResults = (doc as { testResults?: unknown }).testResults;
  if (!Array.isArray(testResults)) return [];

  const failures: FailingTest[] = [];
  for (const tr of testResults) {
    if (!tr || typeof tr !== 'object') continue;
    const file = String((tr as { name?: unknown }).name ?? '');
    const assertions = (tr as { assertionResults?: unknown }).assertionResults;
    if (!Array.isArray(assertions)) continue;
    for (const a of assertions) {
      if (!a || typeof a !== 'object') continue;
      if ((a as { status?: unknown }).status !== 'failed') continue;
      const ar = a as { title?: unknown; fullName?: unknown; failureMessages?: unknown };
      const name = String(ar.title ?? ar.fullName ?? '(unnamed test)');
      const msgs = Array.isArray(ar.failureMessages)
        ? ar.failureMessages.map((m) => String(m)).join('\n')
        : '';
      failures.push({ file, name, message: msgs });
    }
  }
  return failures;
}

/**
 * Parse `pytest --json-report` output (pytest-json-report plugin). Returns
 * `null` when no JSON object is present.
 */
export function parsePytestJson(stdout: string): FailingTest[] | null {
  const json = extractJsonObject(stdout);
  if (!json) return null;

  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;

  const tests = (doc as { tests?: unknown }).tests;
  if (!Array.isArray(tests)) return [];

  const failures: FailingTest[] = [];
  for (const t of tests) {
    if (!t || typeof t !== 'object') continue;
    const outcome = (t as { outcome?: unknown }).outcome;
    if (outcome !== 'failed' && outcome !== 'error') continue;
    const nodeid = String((t as { nodeid?: unknown }).nodeid ?? '');
    // nodeid looks like `tests/foo_test.py::test_thing`.
    const [file, name] = nodeid.includes('::')
      ? [nodeid.slice(0, nodeid.indexOf('::')), nodeid.slice(nodeid.indexOf('::') + 2)]
      : [nodeid, '(unnamed test)'];
    const call = (t as { call?: { longrepr?: unknown; crash?: { message?: unknown } } }).call;
    const message = String(call?.longrepr ?? call?.crash?.message ?? '');
    failures.push({ file, name: name || '(unnamed test)', message });
  }
  return failures;
}

const STUB_PROMPT_RULES: LanguageProfile['testPromptRules'] = {
  unit: [
    '- TEST TYPE: unit. Mock external dependencies. Focus on one function/class in isolation.',
  ],
  integration: ['- TEST TYPE: integration. Use real dependencies supplied by the environment.'],
  e2e: ['- TEST TYPE: e2e. Drive the running application end to end.'],
};

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const TS_FEATURE_REGEX: RegExp[] = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /\.[cm]?[jt]sx?$/i,
];

/** Legacy TS probe matrix: `<feature>.<kind>.<ext>` for kind×ext. */
function tsTestFileCandidates(feature: string): string[] {
  const exts = ['ts', 'tsx', 'js', 'jsx'];
  const kinds = ['test', 'spec'];
  const out: string[] = [];
  for (const kind of kinds) {
    for (const ext of exts) {
      out.push(`${feature}.${kind}.${ext}`);
    }
  }
  return out;
}

const typescript: LanguageProfile = {
  id: 'typescript',
  capability: 'full',
  detectFiles: ['package.json', 'tsconfig.json'],
  detectGlobs: ['**/*.{ts,tsx}', '**/*.{js,jsx}'],
  sourceGlobs: {
    routes: ['src/**/*.{ts,tsx,js,jsx}'],
    api: ['src/api/**/*.{ts,js}'],
    tests: ['tests/**/*.test.{ts,js}'],
  },
  testOutput: 'tests/',
  testFramework: 'vitest',
  testCommand: 'npm test',
  testReporterArgs: ' -- --reporter=json',
  testExt: '.test.ts',
  featureExtRegex: TS_FEATURE_REGEX,
  testFileCandidates: tsTestFileCandidates,
  testPromptRules: {
    unit: [
      '- TEST TYPE: unit. Mock all external dependencies (db, http, fs) with vitest.fn() / vi.mock().',
      '- Focus on a single function or class in isolation.',
      '- Use vitest idioms: import { describe, it, expect, vi } from "vitest".',
    ],
    integration: [
      '- TEST TYPE: integration. Use real dependencies (no mocking); assume test containers / env vars supply backing services.',
      '- Use vitest idioms with setup/teardown hooks for connection lifecycle.',
      '- Mark long-running tests with test.timeout(30_000).',
    ],
    e2e: [
      '- TEST TYPE: e2e. Use Playwright Browser automation targeting the live app URL from spec metadata.',
      '- Use import { test, expect } from "@playwright/test".',
    ],
  },
  testPromptDefault: [
    '- Use the requested framework\'s idioms (vitest: import from "vitest"; jest: global describe/it;',
    '  playwright: import { test, expect } from "@playwright/test").',
  ],
  securityPromptRules: [
    '- Emit ONE complete vitest test file containing security test stubs.',
    '- Use vitest idioms: import { describe, it, expect } from "vitest".',
  ],
  planFileHint: 'src/api/board.ts',
  parseTestOutput: parseVitestJson,
  lintRunner: 'eslint',
  deadCodeRunner: 'knip',
  auditRunner: 'npm-audit',
};

const python: LanguageProfile = {
  id: 'python',
  capability: 'full',
  detectFiles: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'],
  detectGlobs: ['**/*.py'],
  sourceGlobs: {
    routes: ['**/*.py', '!**/*_test.py', '!**/test_*.py', '!tests/**'],
    api: ['**/api/**/*.py'],
    tests: ['tests/**/*_test.py', 'tests/**/test_*.py'],
  },
  testOutput: 'tests/',
  testFramework: 'pytest',
  testCommand: 'pytest',
  testReporterArgs: ' --json-report --json-report-file=/dev/stdout -q',
  testExt: '_test.py',
  featureExtRegex: [/_test\.py$/i, /^test_/i, /\.py$/i],
  testFileCandidates: (feature) => [`${feature}_test.py`, `test_${feature}.py`],
  testPromptRules: {
    unit: [
      '- TEST TYPE: unit. Mock external dependencies with unittest.mock (monkeypatch / MagicMock).',
      '- Focus on a single function or class in isolation.',
      '- Use pytest idioms: plain `def test_*()` functions and `assert` statements.',
    ],
    integration: [
      '- TEST TYPE: integration. Use real dependencies; assume fixtures / env vars supply backing services.',
      '- Use pytest fixtures for setup/teardown.',
    ],
    e2e: [
      '- TEST TYPE: e2e. Drive the running application end to end (e.g. via requests or the Playwright Python API).',
    ],
  },
  testPromptDefault: [
    '- Use pytest idioms: `def test_*()` functions with `assert`; group with classes only when natural.',
  ],
  securityPromptRules: [
    '- Emit ONE complete pytest test file containing security test stubs.',
    '- Use pytest idioms: `def test_*()` functions with `assert` statements.',
  ],
  planFileHint: 'app/api/board.py',
  parseTestOutput: parsePytestJson,
  lintRunner: 'ruff',
  deadCodeRunner: 'unsupported',
  auditRunner: 'pip-audit',
};

const go: LanguageProfile = {
  id: 'go',
  capability: 'stub',
  detectFiles: ['go.mod'],
  detectGlobs: ['**/*.go'],
  sourceGlobs: {
    routes: ['**/*.go', '!**/*_test.go'],
    api: ['**/api/**/*.go'],
    tests: ['**/*_test.go'],
  },
  testOutput: 'tests/',
  testFramework: 'go-test',
  testCommand: 'go test ./...',
  testReporterArgs: ' -json',
  testExt: '_test.go',
  featureExtRegex: [/_test\.go$/i, /\.go$/i],
  testFileCandidates: (feature) => [`${feature}_test.go`],
  testPromptRules: STUB_PROMPT_RULES,
  testPromptDefault: ['- Use Go idioms: `func TestXxx(t *testing.T)` with the standard `testing` package.'],
  securityPromptRules: ['- Emit ONE complete Go test file with security test stubs using the `testing` package.'],
  planFileHint: 'internal/api/board.go',
  parseTestOutput: () => null,
  lintRunner: 'unsupported',
  deadCodeRunner: 'unsupported',
  auditRunner: 'unsupported',
};

const rust: LanguageProfile = {
  id: 'rust',
  capability: 'stub',
  detectFiles: ['Cargo.toml'],
  detectGlobs: ['**/*.rs'],
  sourceGlobs: {
    routes: ['src/**/*.rs'],
    api: ['src/api/**/*.rs'],
    tests: ['tests/**/*.rs'],
  },
  testOutput: 'tests/',
  testFramework: 'cargo-test',
  testCommand: 'cargo test',
  testReporterArgs: ' -- -Z unstable-options --format json',
  testExt: '_test.rs',
  featureExtRegex: [/_test\.rs$/i, /\.rs$/i],
  testFileCandidates: (feature) => [`${feature}_test.rs`],
  testPromptRules: STUB_PROMPT_RULES,
  testPromptDefault: ['- Use Rust idioms: `#[test]` functions inside a `#[cfg(test)] mod tests` block.'],
  securityPromptRules: ['- Emit ONE complete Rust test module with security test stubs using `#[test]`.'],
  planFileHint: 'src/api/board.rs',
  parseTestOutput: () => null,
  lintRunner: 'unsupported',
  deadCodeRunner: 'unsupported',
  auditRunner: 'unsupported',
};

const java: LanguageProfile = {
  id: 'java',
  capability: 'stub',
  detectFiles: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  detectGlobs: ['**/*.java'],
  sourceGlobs: {
    routes: ['src/main/java/**/*.java'],
    api: ['src/main/java/**/api/**/*.java'],
    tests: ['src/test/java/**/*.java'],
  },
  testOutput: 'src/test/java/',
  testFramework: 'junit',
  testCommand: 'mvn test',
  testReporterArgs: '',
  testExt: 'Test.java',
  featureExtRegex: [/Test\.java$/i, /\.java$/i],
  testFileCandidates: (feature) => [`${feature}Test.java`],
  testPromptRules: STUB_PROMPT_RULES,
  testPromptDefault: ['- Use JUnit 5 idioms: `@Test` methods with `org.junit.jupiter.api.Assertions`.'],
  securityPromptRules: ['- Emit ONE complete JUnit 5 test class with security test stubs using `@Test`.'],
  planFileHint: 'src/main/java/com/example/api/Board.java',
  parseTestOutput: () => null,
  lintRunner: 'unsupported',
  deadCodeRunner: 'unsupported',
  auditRunner: 'unsupported',
};

const REGISTRY: Record<LanguageId, LanguageProfile> = {
  typescript,
  python,
  go,
  rust,
  java,
};

/** Fixed precedence used to break detection ties between languages. */
const DETECTION_PRIORITY: LanguageId[] = ['typescript', 'python', 'go', 'rust', 'java'];

/** Return the profile for a language id, throwing on an unknown id. */
export function getProfile(id: string): LanguageProfile {
  const profile = REGISTRY[id as LanguageId];
  if (!profile) {
    throw new Error(
      `Unknown language '${id}'. Supported: ${DETECTION_PRIORITY.join(', ')}.`,
    );
  }
  return profile;
}

/**
 * Resolve the profile for an app config, defaulting to TypeScript when the
 * config has no `language` field (backward compatibility guarantee).
 */
export function resolveProfile(app: { language?: string }): LanguageProfile {
  return getProfile(app.language ?? 'typescript');
}

/**
 * Derive the feature path (no extension) for a source file relative to its
 * repo. Centralizes the logic previously duplicated in reverse/status/gap:
 *   1. Drop a leading `src/` or `tests/` segment.
 *   2. Drop the next (area) segment — already encoded by `specDir`.
 *   3. Apply each `featureExtRegex` entry in order.
 */
export function featureFromPath(
  absFile: string,
  repoDir: string,
  profile: LanguageProfile,
): string {
  let rel = path.relative(repoDir, absFile).split(path.sep).join('/');
  const segments = rel.split('/');

  if (segments.length > 1 && (segments[0] === 'src' || segments[0] === 'tests')) {
    segments.shift();
  }
  if (segments.length > 1) {
    segments.shift();
  }

  rel = segments.join('/');
  for (const re of profile.featureExtRegex) {
    rel = rel.replace(re, '');
  }
  return rel;
}

/**
 * Detect the target language of a project directory. Read-only — inspects
 * marker files and counts source files; never executes project code.
 */
export async function detectLanguage(cwd: string): Promise<LanguageId> {
  const present: LanguageId[] = [];
  for (const id of DETECTION_PRIORITY) {
    const profile = REGISTRY[id];
    for (const marker of profile.detectFiles) {
      if (await fileExists(path.join(cwd, marker))) {
        present.push(id);
        break;
      }
    }
  }

  if (present.length === 1) return present[0];

  if (present.length > 1) {
    // Tie-break by source-file count; fall back to priority order on a tie.
    let best: LanguageId = present[0];
    let bestCount = -1;
    for (const id of present) {
      const files = await expandGlobs(REGISTRY[id].detectGlobs, cwd);
      if (files.length > bestCount) {
        bestCount = files.length;
        best = id;
      }
    }
    return best;
  }

  // No markers or source files found — scan generated plan files for language hints.
  // Handles spec-only projects (e.g. honeypenny) that have plans but no source yet.
  const planDir = path.join(cwd, '.specguard', 'plans');
  if (await fileExists(planDir)) {
    try {
      const planFiles = await expandGlobs(['**/*.md'], planDir);
      const extVotes: Record<string, number> = {};
      for (const f of planFiles) {
        const text = await readFile(f);
        for (const m of text.matchAll(/`[^`]*\.(py|go|rs|java)\b/g)) {
          const ext = m[1];
          extVotes[ext] = (extVotes[ext] ?? 0) + 1;
        }
      }
      const extMap: Record<string, LanguageId> = { py: 'python', go: 'go', rs: 'rust', java: 'java' };
      const winner = Object.entries(extVotes).sort((a, b) => b[1] - a[1])[0];
      if (winner && winner[1] >= 3) return extMap[winner[0]] ?? 'typescript';
    } catch { /* best-effort; fall through */ }
  }

  return 'typescript';
}
