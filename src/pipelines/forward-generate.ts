/**
 * Forward Generation pipeline.
 *
 * Reads Living Spec Markdown files and generates executable test files — the
 * inverse of the reverse pipeline. Each `### Scenario` in a spec becomes one
 * `it()` / test block in the target framework, titled with the scenario name,
 * importing the module under test declared in the spec's `module` metadata.
 *
 * Spec: specs/pipelines/forward-generate.md
 *
 * Spec -> app -> output-path mapping
 * ----------------------------------
 * Every spec lives under exactly one app's `specDir`. We map a spec back to its
 * owning app by matching the resolved spec file path against each app's resolved
 * `specDir`. The output path is then:
 *
 *   <app.testOutput>/<feature>.test.ts
 *
 * where `feature` is the spec file path relative to the owning app's `specDir`,
 * with the `.md` extension dropped. The spec "area" (e.g. `core`) is already
 * encoded in `testOutput` (e.g. `tests/core/`), so it is not repeated.
 *
 * Examples (app specguard-core, specDir `specs/core`, testOutput `tests/core/`):
 *   specs/core/spec-parser.md      -> feature `spec-parser` -> tests/core/spec-parser.test.ts
 *   specs/core/sub/reader.md       -> feature `sub/reader`  -> tests/core/sub/reader.test.ts
 *
 * The PipelineItem key / log key is `<app.name>/<feature>`.
 */
import path from 'node:path';

import type {
  SpecGuardConfig,
  AppConfig,
  ParsedSpec,
  PipelineResult,
  PipelineItem,
} from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import { readFile, fileExists } from '../core/reader.js';
import { writeFile } from '../core/writer.js';
import { parseSpecContent, loadAllSpecs } from '../core/spec-parser.js';
import { llmGenerateText } from '../core/llm.js';

export interface ForwardOpts {
  /** A spec key (e.g. `core/spec-parser`) or a direct path to a `.md` spec. */
  spec?: string;
  /** Process every spec under each app's specDir. */
  all?: boolean;
  /** Target test framework override (vitest | playwright | jest). */
  framework?: string;
  /** Restrict resolution / `--all` to a single app by name. */
  app?: string;
  /** Overwrite existing test files. */
  force?: boolean;
}

/** A spec file paired with the app whose specDir owns it. */
interface OwnedSpec {
  absSpecPath: string;
  app: AppConfig;
  specDirAbs: string;
}

/** System prompt instructing the model how to write a test file from a spec. */
const SYSTEM_PROMPT = [
  'You are SpecGuard, generating an executable test file from a Living Specification.',
  '',
  'Rules:',
  '- Emit ONE complete, runnable test file in the requested test framework.',
  '- Create EXACTLY one test block (it() / test()) per scenario, titled with the scenario name.',
  '- Import the module under test from the provided module path.',
  '- Translate each scenario\'s Steps and Expected Results into arrange / act / assert code.',
  '- Use the requested framework\'s idioms (vitest: import from "vitest"; jest: global describe/it;',
  '  playwright: import { test, expect } from "@playwright/test").',
  '- Output ONLY valid test code. No Markdown code fences, no prose, no explanation.',
].join('\n');

/** Resolve a possibly-relative path against the config root dir. */
function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

/** The apps in scope, optionally narrowed to `opts.app`. */
function appsInScope(config: SpecGuardConfig, opts: ForwardOpts): AppConfig[] {
  if (!opts.app) return config.apps;
  const app = config.apps.find((a) => a.name === opts.app);
  if (!app) {
    const known = config.apps.map((a) => a.name).join(', ') || '(none)';
    throw new SpecGuardError(
      `Unknown app \`${opts.app}\`. Known apps: ${known}.`,
      ExitCode.InternalError,
    );
  }
  return [app];
}

/** Return the app whose resolved specDir contains `absSpecPath`, if any. */
function findOwningApp(
  config: SpecGuardConfig,
  apps: AppConfig[],
  absSpecPath: string,
): { app: AppConfig; specDirAbs: string } | null {
  for (const app of apps) {
    const specDirAbs = resolveFromRoot(config, app.specDir);
    const rel = path.relative(specDirAbs, absSpecPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { app, specDirAbs };
    }
  }
  return null;
}

/**
 * Resolve `opts.spec` (a spec key like `core/spec-parser` or a direct `.md`
 * path) to an absolute spec file path, if one can be found.
 */
function resolveSingleSpecPath(
  config: SpecGuardConfig,
  apps: AppConfig[],
  spec: string,
): string | null {
  // Direct path (absolute, or relative to rootDir) ending in `.md`.
  if (/\.md$/i.test(spec)) {
    return resolveFromRoot(config, spec);
  }

  // Spec key: resolve under an app's specDir, allowing the leading segment to be
  // the specDir basename (e.g. key `core/spec-parser` under specDir `specs/core`
  // resolves to `specs/core/spec-parser.md`). Prefer the app whose specDir
  // basename matches the key's area segment; otherwise fall back to the first.
  const parts = spec.split('/');
  const byArea = apps.find((a) => path.basename(resolveFromRoot(config, a.specDir)) === parts[0]);
  const chosen = byArea ?? apps[0];
  if (chosen) {
    const specDirAbs = resolveFromRoot(config, chosen.specDir);
    const base = path.basename(specDirAbs);
    const remainder = parts[0] === base ? parts.slice(1).join('/') : spec;
    return path.join(specDirAbs, `${remainder}.md`);
  }

  // Last resort: relative to root.
  return resolveFromRoot(config, `${spec}.md`);
}

/** Derive the feature path (no extension) for a spec relative to its specDir. */
function deriveFeature(absSpecPath: string, specDirAbs: string): string {
  let rel = path.relative(specDirAbs, absSpecPath).split(path.sep).join('/');
  rel = rel.replace(/\.md$/i, '');
  return rel;
}

/**
 * Strip an accidental Markdown code fence wrapping the LLM output. Handles a
 * leading ```ts / ```typescript / ``` line and a trailing closing fence.
 */
function stripFences(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```[^\n]*\n/);
  if (fence) {
    t = t.slice(fence[0].length);
    t = t.replace(/\n?```[ \t]*$/, '');
  }
  return `${t.trim()}\n`;
}

/** Serialize parsed scenarios into a compact prompt block. */
function scenariosBlock(spec: ParsedSpec): string {
  if (spec.scenarios.length === 0) return '(no scenarios in spec)';
  return spec.scenarios
    .map((s, i) => {
      const steps = s.steps.map((x, j) => `   ${j + 1}. ${x}`).join('\n');
      const expected = s.expectedResults.map((x) => `   - ${x}`).join('\n');
      return [
        `Scenario ${i + 1}: ${s.name}`,
        steps ? ` Steps:\n${steps}` : '',
        expected ? ` Expected Results:\n${expected}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

/**
 * Generate executable tests from Living Specs.
 */
export async function runForwardGenerate(
  config: SpecGuardConfig,
  opts: ForwardOpts,
): Promise<PipelineResult> {
  const result = emptyResult('forward');

  if (!opts.spec && !opts.all) {
    throw new SpecGuardError(
      'Nothing to do: pass either --spec <key|path> or --all.',
      ExitCode.InternalError,
    );
  }

  const apps = appsInScope(config, opts);

  // Build the list of owned spec files to process.
  const owned: OwnedSpec[] = [];

  if (opts.spec) {
    const absSpecPath = resolveSingleSpecPath(config, apps, opts.spec);
    if (absSpecPath) {
      const ownerByDir = findOwningApp(config, apps, absSpecPath);
      const app = ownerByDir?.app ?? apps[0];
      const specDirAbs = ownerByDir?.specDirAbs ?? resolveFromRoot(config, app.specDir);
      owned.push({ absSpecPath, app, specDirAbs });
    }
  }

  if (opts.all) {
    for (const app of apps) {
      const specDirAbs = resolveFromRoot(config, app.specDir);
      for (const parsed of loadAllSpecs(specDirAbs)) {
        owned.push({ absSpecPath: parsed.filePath, app, specDirAbs });
      }
    }
  }

  const log = (line: string): void => {
    result.messages.push(line);
  };

  /** Count of specs that reached the LLM stage (created + failed). */
  let attempted = 0;

  for (const { absSpecPath, app, specDirAbs } of owned) {
    const feature = deriveFeature(absSpecPath, specDirAbs);
    const key = `${app.name}/${feature}`;

    if (!(await fileExists(absSpecPath))) {
      log(`[warn] ${key} — spec file not found: ${absSpecPath}`);
      continue;
    }

    const testOutputAbs = resolveFromRoot(config, app.testOutput);
    const targetTest = path.join(testOutputAbs, `${feature}.test.ts`);

    // Skip if the test file already exists and --force is not set.
    if (!opts.force && (await fileExists(targetTest))) {
      log(`[skip] ${key} — test already exists`);
      const item: PipelineItem = {
        key,
        status: 'skipped',
        path: targetTest,
        message: 'test already exists',
      };
      result.items.push(item);
      result.skipped += 1;
      continue;
    }

    let spec: ParsedSpec;
    try {
      const content = await readFile(absSpecPath);
      spec = parseSpecContent(content, absSpecPath, specDirAbs);
    } catch (err) {
      log(`[warn] ${key} — could not read spec: ${(err as Error).message}`);
      continue;
    }

    const framework = opts.framework ?? app.framework;
    const moduleUnderTest = spec.meta.module ?? '(unknown — infer from spec)';

    const prompt = [
      `Generate a ${framework} test file for this Living Specification.`,
      `Spec key: ${key}`,
      `Spec title: ${spec.title}`,
      `Test framework: ${framework}`,
      `Module under test (import this): ${moduleUnderTest}`,
      '',
      'Overview:',
      spec.overview || '(none)',
      '',
      'Scenarios (one test block each):',
      scenariosBlock(spec),
    ].join('\n');

    attempted += 1;
    try {
      const raw = await llmGenerateText({
        provider: config.llm.provider,
        model: config.llm.model,
        apiKeyEnv: config.llm.apiKeyEnv,
        system: SYSTEM_PROMPT,
        prompt,
      });
      const testCode = stripFences(raw);
      await writeFile(targetTest, testCode);
      log(`[gen] ${key}`);
      result.items.push({ key, status: 'created', path: targetTest });
      result.created += 1;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      log(`[fail] ${key} — ${message}`);
      result.items.push({ key, status: 'failed', path: targetTest, message });
      result.failed += 1;
    }
  }

  // Non-zero exit only if every attempted spec failed.
  if (attempted > 0 && result.created === 0 && result.failed === attempted) {
    result.exitCode = ExitCode.InternalError;
  }

  return result;
}
