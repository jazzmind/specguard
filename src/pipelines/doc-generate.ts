/**
 * Doc Generation pipeline.
 *
 * Transforms Living Spec Markdown files into clear, user-facing documentation
 * pages. For each spec we strip the internal-only parts (the metadata HTML
 * comment, `## Scenarios`, and `## Security Notes`), hand the remainder to the
 * LLM to rewrite as friendly end-user docs, prepend YAML frontmatter, and write
 * the page to a docs output directory (default `docs/user/`).
 *
 * Spec: specs/pipelines/doc-generate.md
 *
 * Spec -> app -> output-path mapping
 * ----------------------------------
 * Every spec lives under exactly one app's `specDir`. We map a spec back to its
 * owning app by matching the resolved spec file path against each app's resolved
 * `specDir` (the same convention as forward-generate). The output path is:
 *
 *   <out>/<feature>.md
 *
 * where `out` defaults to `docs/user` (resolved relative to `config.rootDir`)
 * and `feature` is the spec file path relative to the owning app's `specDir`
 * with the `.md` extension dropped.
 *
 * Docs are regenerable artifacts: existing files are overwritten (no skip step).
 *
 * The PipelineItem key / log key is `<app.name>/<feature>`.
 */
import path from 'node:path';
import { z } from 'zod';

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
import { llmGenerateObject } from '../core/llm.js';
import { syncRootDocs } from '../core/root-doc-sync.js';

/** Category values from most general to most specific — the DocsView groups by this. */
const DOC_CATEGORIES = ['overview', 'getting-started', 'core', 'pipelines', 'adapters', 'reference'] as const;
type DocCategory = typeof DOC_CATEGORIES[number];

/** Schema for the LLM's structured doc output. */
const DocOutputSchema = z.object({
  description: z.string().describe('One or two sentences summarising what this feature does for the user.'),
  category: z.enum(DOC_CATEGORIES).describe(
    'The documentation category that best fits this page. ' +
    '"overview" = high-level product introduction; ' +
    '"getting-started" = installation, first steps, quickstart; ' +
    '"core" = foundational concepts and configuration; ' +
    '"pipelines" = pipeline-specific reference; ' +
    '"adapters" = adapter/runner-specific reference; ' +
    '"reference" = CLI flags, config schema, advanced options.',
  ),
  order: z.number().int().min(0).max(999).describe(
    'Sort order within the category (0 = first, 999 = last). ' +
    'Overview pages should be 0-9; core fundamentals 10-49; specific features 50-99; edge-case / advanced 100+.',
  ),
  body: z.string().describe('The full user-facing documentation body in Markdown prose (no frontmatter, no wrapping code fence).'),
});

export interface DocsOpts {
  /** A spec key (e.g. `core/spec-parser`) or a direct path to a `.md` spec. */
  spec?: string;
  /** Process every spec under each app's specDir. */
  all?: boolean;
  /** Output directory for generated docs (default `docs/user`). */
  out?: string;
  /** Restrict resolution / `--all` to a single app by name. */
  app?: string;
}

/** A spec file paired with the app whose specDir owns it. */
interface OwnedSpec {
  absSpecPath: string;
  app: AppConfig;
  specDirAbs: string;
}

/** Default output directory for generated docs, relative to rootDir. */
const DEFAULT_OUT = 'docs/user';

/** System prompt instructing the model how to write user-facing docs. */
const SYSTEM_PROMPT = [
  'You are SpecGuard, turning an internal Living Specification into clear,',
  'user-facing documentation for the people who USE this feature.',
  '',
  'Rules:',
  '- Write friendly, readable Markdown documentation prose.',
  '- Reframe internal "Acceptance Criteria" as user-facing capability and usage',
  '  prose — describe what the feature does and how to use it, not a checklist',
  '  of developer tasks.',
  '- Stay strictly accurate to the supplied spec content. Do NOT invent',
  '  features, flags, commands, or behavior that the spec does not describe.',
  '- For `description`: one or two plain-English sentences summarising the feature',
  '  at a glance (shown in the dashboard card). No markdown, no code.',
  '- For `category`: pick the most accurate category from the enum. Prefer',
  '  "overview" for top-level product intro, "getting-started" for install/quickstart,',
  '  "core" for foundational config/types, "pipelines" for any specguard pipeline,',
  '  "adapters" for runner adapters, "reference" for CLI/config reference material.',
  '- For `order`: assign a logical reading order within the category (0 = read first).',
  '  Overview pages 0-9, fundamentals 10-49, specifics 50-99.',
  '- For `body`: the full documentation in Markdown prose.',
  '  Do NOT wrap it in a code fence. Do NOT emit YAML frontmatter.',
].join('\n');

/** Resolve a possibly-relative path against the config root dir. */
function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

/** The apps in scope, optionally narrowed to `opts.app`. */
function appsInScope(config: SpecGuardConfig, opts: DocsOpts): AppConfig[] {
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
 * path) to an absolute spec file path.
 */
function resolveSingleSpecPath(
  config: SpecGuardConfig,
  apps: AppConfig[],
  spec: string,
): string {
  if (/\.md$/i.test(spec)) {
    return resolveFromRoot(config, spec);
  }

  const parts = spec.split('/');
  const byArea = apps.find(
    (a) => path.basename(resolveFromRoot(config, a.specDir)) === parts[0],
  );
  const chosen = byArea ?? apps[0];
  if (chosen) {
    const specDirAbs = resolveFromRoot(config, chosen.specDir);
    const base = path.basename(specDirAbs);
    const remainder = parts[0] === base ? parts.slice(1).join('/') : spec;
    return path.join(specDirAbs, `${remainder}.md`);
  }

  return resolveFromRoot(config, `${spec}.md`);
}

/** Derive the feature path (no extension) for a spec relative to its specDir. */
function deriveFeature(absSpecPath: string, specDirAbs: string): string {
  let rel = path.relative(specDirAbs, absSpecPath).split(path.sep).join('/');
  rel = rel.replace(/\.md$/i, '');
  return rel;
}

/**
 * Strip the parts of a spec that should never appear in user-facing docs:
 * the leading metadata HTML comment, the `## Scenarios` section, and the
 * `## Security Notes` section.
 *
 * A section runs from its `## Heading` line up to (but not including) the next
 * `## ` heading, or the end of the file. Exported for unit testing.
 */
export function stripForDocs(content: string): string {
  // Remove the first `<!-- ... -->` metadata comment block.
  let out = content.replace(/<!--[\s\S]*?-->\n?/, '');

  // Section names (case-insensitive) to drop entirely.
  const drop = new Set(['scenarios', 'security notes']);

  const lines = out.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      // Reaching any new H2 ends a skip region; decide whether this one starts one.
      skipping = drop.has(h2[1].trim().toLowerCase());
      if (skipping) continue;
    }
    if (skipping) continue;
    kept.push(line);
  }

  out = kept.join('\n').trim();
  return out ? `${out}\n` : '';
}

/**
 * Strip an accidental Markdown code fence wrapping the entire LLM output.
 */
function stripWrappingFence(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```[^\n]*\n/);
  if (fence) {
    t = t.slice(fence[0].length);
    t = t.replace(/\n?```[ \t]*$/, '');
  }
  return t.trim();
}

/** Build the YAML frontmatter block for a doc page. */
function frontmatter(title: string, description: string, category: string, order: number): string {
  const safe = (s: string) => s.replace(/"/g, '\\"');
  const lines = [
    '---',
    `title: "${safe(title)}"`,
    `sidebar_label: "${safe(title)}"`,
    `description: "${safe(description)}"`,
    `category: "${safe(category)}"`,
    `order: ${order}`,
    'generated: true',
    '---',
    '',
  ];
  return lines.join('\n');
}

/**
 * Generate user-facing documentation from Living Specs.
 */
export async function runDocGenerate(
  config: SpecGuardConfig,
  opts: DocsOpts,
): Promise<PipelineResult> {
  const result = emptyResult('docs');

  if (!opts.spec && !opts.all) {
    throw new SpecGuardError(
      'Nothing to do: pass either --spec <key|path> or --all.',
      ExitCode.InternalError,
    );
  }

  const apps = appsInScope(config, opts);
  const outDirAbs = resolveFromRoot(config, opts.out ?? DEFAULT_OUT);

  // Build the list of owned spec files to process.
  const owned: OwnedSpec[] = [];

  if (opts.spec) {
    const absSpecPath = resolveSingleSpecPath(config, apps, opts.spec);
    const ownerByDir = findOwningApp(config, apps, absSpecPath);
    const app = ownerByDir?.app ?? apps[0];
    const specDirAbs = ownerByDir?.specDirAbs ?? resolveFromRoot(config, app.specDir);
    owned.push({ absSpecPath, app, specDirAbs });
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
    const targetDoc = path.join(outDirAbs, `${feature}.md`);

    if (!(await fileExists(absSpecPath))) {
      log(`[warn] ${key} — spec file not found: ${absSpecPath}`);
      continue;
    }

    let spec: ParsedSpec;
    let stripped: string;
    try {
      const content = await readFile(absSpecPath);
      spec = parseSpecContent(content, absSpecPath, specDirAbs);
      stripped = stripForDocs(content);
    } catch (err) {
      log(`[warn] ${key} — could not read spec: ${(err as Error).message}`);
      continue;
    }

    const title = spec.title || feature;
    const prompt = [
      'Rewrite the following Living Specification as user-facing documentation.',
      `Spec key: ${key}`,
      `Document title: ${title}`,
      '',
      'Source spec (internal sections already removed):',
      stripped || '(no content)',
    ].join('\n');

    attempted += 1;
    try {
      const output = await llmGenerateObject({
        provider: config.llm.provider,
        model: config.llm.model,
        apiKeyEnv: config.llm.apiKeyEnv,
        system: SYSTEM_PROMPT,
        prompt,
        schema: DocOutputSchema,
      });
      const body = stripWrappingFence(output.body);
      const doc = `${frontmatter(title, output.description, output.category, output.order)}\n${body}\n`;
      await writeFile(targetDoc, doc);
      log(`[doc] ${key}`);
      result.items.push({ key, status: 'created', path: targetDoc });
      result.created += 1;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      log(`[fail] ${key} — ${message}`);
      result.items.push({ key, status: 'failed', path: targetDoc, message });
      result.failed += 1;
    }
  }

  // Non-zero exit only if every attempted spec failed.
  if (attempted > 0 && result.created === 0 && result.failed === attempted) {
    result.exitCode = ExitCode.InternalError;
  }

  // After per-spec docs, sync sentinel sections in README.md, CLAUDE.md, and AGENTS.md.
  if (result.created > 0) {
    try {
      const parsedForSync: ParsedSpec[] = (
        await Promise.all(
          owned.map(async ({ absSpecPath, specDirAbs }) => {
            try {
              const content = await readFile(absSpecPath);
              return parseSpecContent(content, absSpecPath, specDirAbs);
            } catch {
              return null;
            }
          })
        )
      ).filter((s): s is ParsedSpec => s !== null);

      await syncRootDocs(config, parsedForSync, log);
    } catch (err) {
      log(`[doc] root-sync failed (non-fatal): ${(err as Error).message}`);
    }
  }

  return result;
}
