/**
 * Reverse Generation pipeline.
 *
 * Reads existing source files (routes, pages, API handlers, existing tests) for
 * an app defined in the SpecGuard config and generates Living Spec Markdown
 * files for features that do not yet have a spec (or overwrites them when
 * `--force` is set).
 *
 * Spec: specs/pipelines/reverse-generate.md
 *
 * Source-file -> spec-key mapping
 * -------------------------------
 * For each discovered source file we derive a stable "feature" name from the
 * file path relative to the app `repo`, then write to `<specDir>/<feature>.md`:
 *
 *   1. Take the path relative to the app repo, normalised to POSIX separators.
 *   2. Drop a leading `src/` or `tests/` segment if present.
 *   3. Drop the next segment if it duplicates the spec directory's basename
 *      (e.g. specDir `specs/core` + source `src/core/foo.ts` -> `foo`, not
 *      `core/foo`), so the spec subpath is not redundant with `specDir`.
 *   4. Strip a `.test`/`.spec` qualifier and the file extension.
 *
 * Examples (specDir = `specs/core`, repo = `.`):
 *   src/core/foo.ts          -> feature `foo`           -> specs/core/foo.md
 *   src/core/sub/bar.tsx     -> feature `sub/bar`       -> specs/core/sub/bar.md
 *   tests/core/foo.test.ts   -> feature `foo`           -> specs/core/foo.md
 *
 * The PipelineItem key / log key is `<app.name>/<feature>` (e.g.
 * `specguard-core/foo`).
 */
import path from 'node:path';

import type { SpecGuardConfig, PipelineResult, PipelineItem } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import { readFile, fileExists, expandGlobs } from '../core/reader.js';
import { writeFile } from '../core/writer.js';
import { llmGenerateText } from '../core/llm.js';

export interface ReverseOpts {
  /** App name from config to target. */
  app: string;
  /** Optional single source file to process (relative to app repo). */
  file?: string;
  /** Overwrite existing specs. */
  force?: boolean;
}

/** Max characters of a source file sent to the LLM. */
const MAX_SOURCE_CHARS = 20_000;

/** Patterns that suggest a source file embeds secrets. */
const SECRET_PATTERNS: RegExp[] = [/sk-[a-zA-Z0-9]{20,}/, /process\.env\./];

/** System prompt instructing the model how to write a Living Spec. */
const SYSTEM_PROMPT = [
  'You are SpecGuard, generating a Living Specification (Markdown) from source code.',
  '',
  'Rules:',
  '- Write ONE spec for the single distinct page, route, or feature area described by the provided source.',
  '- Only document behaviour that is actually visible in the provided source code. Do not invent features.',
  '- Use the exact spec format: start with an H1 title, then an HTML comment metadata block',
  '  (<!-- module: ... / type: ... / status: draft -->), then H2 sections in this order:',
  '  ## Overview, ## Acceptance Criteria, ## Scenarios, ## Security Notes, ## Dependencies.',
  '- Keep ## Overview to 3-6 sentences.',
  '- Under ## Scenarios use "### Scenario N: <name>" with **Steps:** (numbered) and **Expected Results:** (bullets).',
  '- Make each scenario step observable by a test tool (a concrete, checkable action or assertion), not abstract.',
  '- If the source contains secret-like values (API keys, tokens, raw credentials), REDACT them — never reproduce',
  '  a raw secret value in the spec.',
  '- Output ONLY the Markdown content of the spec. No preamble, no explanation, no code fences around the whole doc.',
].join('\n');

/** Resolve a possibly-relative path against the config root dir. */
function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

/** Derive the feature path (no extension) for a source file relative to repo. */
function deriveFeature(absFile: string, repoDir: string): string {
  let rel = path.relative(repoDir, absFile).split(path.sep).join('/');
  const segments = rel.split('/');

  // 1. Drop a leading src/ or tests/ segment.
  if (segments.length > 1 && (segments[0] === 'src' || segments[0] === 'tests')) {
    segments.shift();
  }

  // 2. Drop the next segment — the source group / area directory (e.g. `pages`,
  //    `core`, `routes`). The spec area is already encoded by `specDir`, so this
  //    avoids a redundant subpath. Nested subpaths beyond it are preserved.
  if (segments.length > 1) {
    segments.shift();
  }

  rel = segments.join('/');

  // 3. Strip extension and a .test/.spec qualifier.
  rel = rel.replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, '');
  rel = rel.replace(/\.[cm]?[jt]sx?$/i, '');
  return rel;
}

/** Read a source file, capped at MAX_SOURCE_CHARS. */
async function readCapped(absFile: string): Promise<string> {
  const content = await readFile(absFile);
  if (content.length > MAX_SOURCE_CHARS) {
    return content.slice(0, MAX_SOURCE_CHARS) + '\n... (truncated)';
  }
  return content;
}

/**
 * Generate Living Specs by reading source code for the configured app.
 */
export async function runReverseGenerate(
  config: SpecGuardConfig,
  opts: ReverseOpts,
): Promise<PipelineResult> {
  const result = emptyResult('reverse');

  const app = config.apps.find((a) => a.name === opts.app);
  if (!app) {
    const known = config.apps.map((a) => a.name).join(', ') || '(none)';
    throw new SpecGuardError(
      `Unknown app \`${opts.app}\`. Known apps: ${known}.`,
      ExitCode.InternalError,
    );
  }

  const repoDir = resolveFromRoot(config, app.repo);
  const specDirAbs = resolveFromRoot(config, app.specDir);

  // Collect the absolute source files to process.
  let files: string[];
  if (opts.file) {
    // Single-file mode: resolve relative to the app repo (may not exist).
    files = [path.resolve(repoDir, opts.file)];
  } else {
    const patterns: string[] = [];
    for (const group of Object.values(app.sources)) {
      if (Array.isArray(group)) patterns.push(...group);
    }
    files = await expandGlobs(patterns, repoDir);
  }

  // Accumulate progress lines on the result; the caller (CLI/MCP) prints them.
  const log = (line: string): void => {
    result.messages.push(line);
  };

  /** Count of specs that actually reached the LLM stage (created + failed). */
  let attempted = 0;

  for (const absFile of files) {
    const feature = deriveFeature(absFile, repoDir);
    const key = `${app.name}/${feature}`;

    // Missing source on disk -> warn and continue (no throw).
    if (!(await fileExists(absFile))) {
      log(`[warn] ${key} — source file not found: ${absFile}`);
      continue;
    }

    const targetSpec = path.join(specDirAbs, `${feature}.md`);

    // Skip if the spec already exists and --force is not set.
    if (!opts.force && (await fileExists(targetSpec))) {
      log(`[skip] ${key} — spec already exists`);
      const item: PipelineItem = {
        key,
        status: 'skipped',
        path: targetSpec,
        message: 'spec already exists',
      };
      result.items.push(item);
      result.skipped += 1;
      continue;
    }

    let source: string;
    try {
      source = await readCapped(absFile);
    } catch (err) {
      log(`[warn] ${key} — could not read source file: ${(err as Error).message}`);
      continue;
    }

    // Secret scan before sending to the LLM.
    if (SECRET_PATTERNS.some((re) => re.test(source))) {
      log(`[warn] ${key} — source appears to contain secret-like patterns; prompt will request redaction`);
    }

    const prompt = [
      `Generate a Living Specification for the feature implemented by this source file.`,
      `Spec key: ${key}`,
      `Source path (relative to repo): ${path.relative(repoDir, absFile).split(path.sep).join('/')}`,
      '',
      '--- SOURCE START ---',
      source,
      '--- SOURCE END ---',
    ].join('\n');

    attempted += 1;
    try {
      const specMarkdown = await llmGenerateText({
        provider: config.llm.provider,
        model: config.llm.model,
        apiKeyEnv: config.llm.apiKeyEnv,
        system: SYSTEM_PROMPT,
        prompt,
      });
      await writeFile(targetSpec, specMarkdown);
      log(`[gen] ${key}`);
      result.items.push({ key, status: 'created', path: targetSpec });
      result.created += 1;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      log(`[fail] ${key} — ${message}`);
      result.items.push({ key, status: 'failed', path: targetSpec, message });
      result.failed += 1;
    }
  }

  // Non-zero exit only if every attempted spec failed.
  if (attempted > 0 && result.created === 0 && result.failed === attempted) {
    result.exitCode = ExitCode.InternalError;
  }

  // The summary line is rendered by the caller (CLI/MCP) from the counts;
  // `messages` holds only per-item progress lines.
  return result;
}
