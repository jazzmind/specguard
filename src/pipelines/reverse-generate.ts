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
import { resolveProfile, featureFromPath } from '../core/language-profiles.js';

export interface ReverseOpts {
  /** App name from config to target. */
  app: string;
  /** Optional single source file to process (relative to app repo). */
  file?: string;
  /** Overwrite existing specs. */
  force?: boolean;
  /**
   * Progress callback called immediately when each file is processed.
   * When provided, messages are NOT accumulated in result.messages (the caller
   * is responsible for displaying them).  When absent, lines are buffered.
   */
  onLog?: (line: string) => void;
  /**
   * Number of files to process concurrently via the LLM.
   * Defaults to 5.  Set to 1 to force sequential processing.
   */
  concurrency?: number;
  /**
   * Additional collapse glob patterns merged with those in config.
   * Lets callers (CLI --collapse flag) specify patterns without editing config.
   */
  extraCollapse?: string[];
}

/** Max characters of a source file sent to the LLM. */
const MAX_SOURCE_CHARS = 20_000;

/** Patterns that suggest a source file embeds secrets. */
const SECRET_PATTERNS: RegExp[] = [/sk-[a-zA-Z0-9]{20,}/, /process\.env\./];

/** System prompt instructing the model how to write a Living Spec (single source file). */
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

/**
 * System prompt for collapsed specs — multiple source files that together
 * implement a single feature (e.g. GraphQL field resolvers for one entity,
 * Angular component files for one page, React files for one feature module).
 */
const SYSTEM_PROMPT_COLLAPSED = [
  'You are SpecGuard, generating a Living Specification (Markdown) from a group of related source files',
  'that together implement a single feature or module.',
  '',
  'Rules:',
  '- Write ONE comprehensive spec covering the combined behaviour of ALL provided source files.',
  '- Only document behaviour that is actually visible in the provided source code. Do not invent features.',
  '- Group scenarios logically by functional area — do not write a separate spec per file.',
  '- Use the exact spec format: start with an H1 title, then an HTML comment metadata block',
  '  (<!-- module: ... / type: ... / status: draft -->), then H2 sections in this order:',
  '  ## Overview, ## Acceptance Criteria, ## Scenarios, ## Security Notes, ## Dependencies.',
  '- Keep ## Overview to 3-6 sentences describing what the feature module as a whole does.',
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

// Source-path → feature-key derivation lives in core/language-profiles.ts
// (`featureFromPath`), so it stays consistent with status/gap-analysis and is
// language-aware via the app's profile.

/** Read a source file, capped at MAX_SOURCE_CHARS. */
async function readCapped(absFile: string): Promise<string> {
  const content = await readFile(absFile);
  if (content.length > MAX_SOURCE_CHARS) {
    return content.slice(0, MAX_SOURCE_CHARS) + '\n... (truncated)';
  }
  return content;
}

/**
 * Run a list of async tasks with a fixed concurrency limit.
 * Pure JS — no external dependencies.
 */
async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker()));
}

/**
 * Generate Living Specs by reading source code for the configured app.
 */
export async function runReverseGenerate(
  config: SpecGuardConfig,
  opts: ReverseOpts,
): Promise<PipelineResult> {
  const result = emptyResult('reverse');
  const concurrency = opts.concurrency ?? 5;

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
  const profile = resolveProfile(app);

  // Collect the absolute source files to process.
  let allFiles: string[];
  if (opts.file) {
    allFiles = [path.resolve(repoDir, opts.file)];
  } else {
    const patterns: string[] = [];
    for (const group of Object.values(app.sources)) {
      if (Array.isArray(group)) patterns.push(...group);
    }
    allFiles = await expandGlobs(patterns, repoDir);
  }

  // Apply `exclude` patterns — filter out any file matched by an exclude glob.
  const excludePatterns = app.exclude ?? [];
  let files = allFiles;
  if (excludePatterns.length > 0) {
    const excluded = new Set(await expandGlobs(excludePatterns, repoDir));
    files = allFiles.filter((f) => !excluded.has(f));
    const removedCount = allFiles.length - files.length;
    if (removedCount > 0) {
      const log0 = (line: string): void => {
        if (opts.onLog) opts.onLog(line);
        else result.messages.push(line);
      };
      log0(`[info] excluded ${removedCount} file(s) matching exclude patterns`);
    }
  }

  // Apply `collapse` patterns — identify files that should be grouped by
  // parent directory and produce one spec per directory instead of per file.
  const collapsePatterns = [...(app.collapse ?? []), ...(opts.extraCollapse ?? [])];
  const collapseSet = new Set(
    collapsePatterns.length > 0 ? await expandGlobs(collapsePatterns, repoDir) : [],
  );

  // Partition files into individual (1 file → 1 spec) and collapsed groups.
  const individualFiles: string[] = [];
  // Map from directory-level feature key to the list of files in that group.
  const collapsedGroups = new Map<string, string[]>();

  for (const absFile of files) {
    if (collapseSet.has(absFile)) {
      // Derive the directory-level feature key: take the normal feature key
      // and drop the final path segment (the filename).
      const fileFeature = featureFromPath(absFile, repoDir, profile, app);
      const dirFeature = path.posix.dirname(fileFeature);
      // If dirname collapses to '.' the file is at the top of the specDir —
      // treat it as individual to avoid a degenerate '.' spec.
      if (dirFeature === '.') {
        individualFiles.push(absFile);
      } else {
        const group = collapsedGroups.get(dirFeature) ?? [];
        group.push(absFile);
        collapsedGroups.set(dirFeature, group);
      }
    } else {
      individualFiles.push(absFile);
    }
  }

  const total = individualFiles.length + collapsedGroups.size;

  /**
   * Emit a progress line.  When `onLog` is provided the line is written
   * immediately; otherwise it is buffered in result.messages for the caller.
   */
  const log = (line: string): void => {
    if (opts.onLog) {
      opts.onLog(line);
    } else {
      result.messages.push(line);
    }
  };

  // Shared mutable counters — safe because JS is single-threaded; the await
  // points are the only interleaving points and we update atomically around them.
  let done = 0;
  let attempted = 0;

  // --- Process individual files (unchanged 1:1 behaviour) ---
  await runConcurrent(individualFiles, concurrency, async (absFile) => {
    const feature = featureFromPath(absFile, repoDir, profile, app);
    const key = `${app.name}/${feature}`;

    if (!(await fileExists(absFile))) {
      done += 1;
      log(`[warn] [${done}/${total}] ${key} — source file not found`);
      return;
    }

    const targetSpec = path.join(specDirAbs, `${feature}.md`);

    if (!opts.force && (await fileExists(targetSpec))) {
      done += 1;
      log(`[skip] [${done}/${total}] ${key}`);
      const item: PipelineItem = { key, status: 'skipped', path: targetSpec, message: 'spec already exists' };
      result.items.push(item);
      result.skipped += 1;
      return;
    }

    let source: string;
    try {
      source = await readCapped(absFile);
    } catch (err) {
      done += 1;
      log(`[warn] [${done}/${total}] ${key} — could not read: ${(err as Error).message}`);
      return;
    }

    if (SECRET_PATTERNS.some((re) => re.test(source))) {
      log(`[warn] ${key} — source may contain secrets; will be redacted in spec`);
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
      done += 1;
      log(`[gen] [${done}/${total}] ${key}`);
      result.items.push({ key, status: 'created', path: targetSpec });
      result.created += 1;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      done += 1;
      log(`[fail] [${done}/${total}] ${key} — ${message}`);
      result.items.push({ key, status: 'failed', path: targetSpec, message });
      result.failed += 1;
    }
  });

  // --- Process collapsed groups (N files → 1 spec per directory) ---
  const collapsedEntries = Array.from(collapsedGroups.entries());
  await runConcurrent(collapsedEntries, concurrency, async ([dirFeature, groupFiles]) => {
    const key = `${app.name}/${dirFeature}`;
    const targetSpec = path.join(specDirAbs, `${dirFeature}.md`);

    if (!opts.force && (await fileExists(targetSpec))) {
      done += 1;
      log(`[skip] [${done}/${total}] ${key} (collapsed)`);
      const item: PipelineItem = { key, status: 'skipped', path: targetSpec, message: 'spec already exists' };
      result.items.push(item);
      result.skipped += 1;
      return;
    }

    // Concatenate all files in the group. Distribute MAX_SOURCE_CHARS evenly
    // across files to avoid exceeding the LLM context window.
    const perFileCap = Math.max(1000, Math.floor(MAX_SOURCE_CHARS / groupFiles.length));
    const sourceParts: string[] = [];

    for (const absFile of groupFiles) {
      const relPath = path.relative(repoDir, absFile).split(path.sep).join('/');
      let content: string;
      try {
        content = await readCapped(absFile);
      } catch {
        continue;
      }
      if (content.length > perFileCap) {
        content = content.slice(0, perFileCap) + '\n... (truncated)';
      }
      if (SECRET_PATTERNS.some((re) => re.test(content))) {
        log(`[warn] ${key} — ${relPath} may contain secrets; will be redacted in spec`);
      }
      sourceParts.push(`=== ${relPath} ===\n${content}`);
    }

    if (sourceParts.length === 0) {
      done += 1;
      log(`[warn] [${done}/${total}] ${key} — no readable files in collapsed group`);
      return;
    }

    const prompt = [
      `Generate a Living Specification for the feature module implemented by the following group of source files.`,
      `Spec key: ${key}`,
      `Files in this group (${sourceParts.length}):`,
      ...groupFiles.map((f) => `  - ${path.relative(repoDir, f).split(path.sep).join('/')}`),
      '',
      '--- SOURCES START ---',
      sourceParts.join('\n\n'),
      '--- SOURCES END ---',
    ].join('\n');

    attempted += 1;
    try {
      const specMarkdown = await llmGenerateText({
        provider: config.llm.provider,
        model: config.llm.model,
        apiKeyEnv: config.llm.apiKeyEnv,
        system: SYSTEM_PROMPT_COLLAPSED,
        prompt,
      });
      await writeFile(targetSpec, specMarkdown);
      done += 1;
      log(`[gen] [${done}/${total}] ${key} (collapsed ${groupFiles.length} files)`);
      result.items.push({ key, status: 'created', path: targetSpec });
      result.created += 1;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      done += 1;
      log(`[fail] [${done}/${total}] ${key} — ${message}`);
      result.items.push({ key, status: 'failed', path: targetSpec, message });
      result.failed += 1;
    }
  });

  if (attempted > 0 && result.created === 0 && result.failed === attempted) {
    result.exitCode = ExitCode.InternalError;
  }

  return result;
}
