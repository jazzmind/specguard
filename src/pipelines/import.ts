/**
 * Import pipeline.
 *
 * Transforms unstructured external requirement documents (Markdown, plain
 * text, URLs) into Living Specification format via LLM.
 *
 * Spec: specs/pipelines/import.md
 */
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';

import { z } from 'zod';

import type { SpecGuardConfig, AppConfig, PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import { readFile, fileExists } from '../core/reader.js';
import { writeFile } from '../core/writer.js';
import { llmGenerateText, llmGenerateObject } from '../core/llm.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportOpts {
  /** Path to a local file or a https:// URL. */
  source: string;
  /** App name to write the spec into. Required when config has multiple apps. */
  app?: string;
  /** Override output spec path (relative to rootDir or absolute). */
  out?: string;
  /** Overwrite an existing spec file. */
  force?: boolean;
  /**
   * Force single-spec output instead of decomposing a multi-section document
   * into a set of specs. Defaults to false (decompose when the document has
   * more than one top-level section). Implied when `out` is set, since `out`
   * names a single file.
   */
  single?: boolean;
}

/** Max characters of source text sent to the LLM in one generation call. */
const MAX_SOURCE_CHARS = 48_000;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are SpecGuard, converting a requirements document into a Living Specification.',
  '',
  'Output ONLY the Living Spec Markdown. Follow this format exactly:',
  '',
  '# <Title>',
  '',
  '<!-- module: (leave blank or infer) -->',
  '<!-- type: feature -->',
  '<!-- status: draft -->',
  '',
  '## Overview',
  '<1-3 sentence overview of the feature>',
  '',
  '## Acceptance Criteria',
  '<bulleted list of testable acceptance criteria>',
  '',
  '## Scenarios',
  '',
  '### Scenario 1: <name>',
  '**Steps:**',
  '1. ...',
  '',
  '**Expected Results:**',
  '- ...',
  '',
  '## Security Notes',
  '<any security considerations, or "(none identified)">',
  '',
  '## Dependencies',
  '<related modules or services, or "(none)">',
  '',
  'Rules:',
  '- Extract ALL requirements and acceptance criteria from the source document.',
  '- Each scenario must have concrete steps and expected results.',
  '- Do not invent requirements not present in the source.',
  '- Output ONLY valid Markdown — no code fences, no prose before the H1.',
].join('\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFromRoot(config: SpecGuardConfig, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.rootDir ?? process.cwd(), p);
}

/** Derive a slug from the document title (first H1 or first non-empty line). */
function deriveSlug(content: string): string {
  const h1Match = content.match(/^#\s+(.+)/m);
  const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? 'imported';
  const title = h1Match ? h1Match[1] : firstLine;
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Sanitise an arbitrary string into a filesystem-safe kebab-case slug. */
function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** A top-level (`##`) section of the source document. */
interface DocSection {
  index: number;
  heading: string;
  body: string;
}

/**
 * Split a Markdown document into its top-level (`##`) sections.
 *
 * Anything before the first `##` heading (the H1 title and any intro prose) is
 * returned as `preamble` and is prepended to every generated spec for context.
 */
function splitSections(content: string): { preamble: string; sections: DocSection[] } {
  const lines = content.split('\n');
  const h2 = /^##\s+(.+?)\s*$/; // matches "## Heading" but not "### " or "# "
  const sections: DocSection[] = [];
  const preambleLines: string[] = [];
  let current: { heading: string; lines: string[] } | null = null;

  const flush = (): void => {
    if (current) {
      sections.push({ index: sections.length, heading: current.heading, body: current.lines.join('\n') });
    }
  };

  for (const line of lines) {
    const m = line.match(h2);
    if (m) {
      flush();
      current = { heading: m[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  flush();

  return { preamble: preambleLines.join('\n').trim(), sections };
}

// ---------------------------------------------------------------------------
// Decomposition planner
// ---------------------------------------------------------------------------

const PLAN_SCHEMA = z.object({
  specs: z
    .array(
      z.object({
        slug: z.string().describe('Short kebab-case filename slug, unique across the set.'),
        title: z.string().describe('Human-readable spec title.'),
        sectionIndexes: z
          .array(z.number().int())
          .describe('Indexes of the source sections that belong to this spec.'),
      }),
    )
    .min(1),
});

type Plan = z.infer<typeof PLAN_SCHEMA>;

const PLAN_SYSTEM = [
  'You are SpecGuard, planning how to decompose a requirements document into a SET of Living Specifications.',
  'You are given the document title and a numbered outline of its top-level sections.',
  '',
  'Group the sections into coherent specs — one spec per distinct feature, component, subsystem, or capability area.',
  '',
  'Rules:',
  '- Prefer multiple focused specs over one giant spec. A typical PRD yields one spec per major component/subsystem.',
  '- Assign every section index to exactly one spec. Cross-cutting sections (success metrics, risks, open questions, deployment) go with the most relevant spec, or their own spec.',
  '- Do not invent components that are not described by a section.',
  '- slug: short, kebab-case, unique within the set, derived from the title.',
  '- title: a clear, specific spec title.',
].join('\n');

/** Ask the model how to split a multi-section document into a set of specs. */
async function planDecomposition(
  config: SpecGuardConfig,
  docTitle: string,
  sections: DocSection[],
): Promise<Plan> {
  const outline = sections.map((s) => `[${s.index}] ${s.heading}`).join('\n');
  const prompt = [
    `Document title: ${docTitle}`,
    '',
    'Section outline:',
    outline,
    '',
    'Produce the decomposition plan.',
  ].join('\n');

  return llmGenerateObject({
    provider: config.llm.provider,
    model: config.llm.model,
    apiKeyEnv: config.llm.apiKeyEnv,
    system: PLAN_SYSTEM,
    prompt,
    schema: PLAN_SCHEMA,
  });
}

/** Fetch content from an http/https URL. Rejects on redirect to file:// or private IPs. */
export function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      reject(new Error(`Unsupported protocol: ${parsedUrl.protocol}`));
      return;
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      { headers: { 'User-Agent': 'SpecGuard/1.0' } },
      (res) => {
        // Follow one redirect.
        if (
          (res.statusCode === 301 || res.statusCode === 302) &&
          res.headers.location &&
          (res.headers.location.startsWith('http://') || res.headers.location.startsWith('https://'))
        ) {
          fetchUrl(res.headers.location).then(resolve).catch(reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runImport(
  config: SpecGuardConfig,
  opts: ImportOpts,
): Promise<PipelineResult> {
  const result = emptyResult('import');
  const log = (line: string) => result.messages.push(line);

  if (!opts.source) {
    throw new SpecGuardError('No source provided. Pass a file path or URL.', ExitCode.InternalError);
  }

  // Resolve target app.
  let app: AppConfig;
  if (opts.app) {
    const found = config.apps.find((a) => a.name === opts.app);
    if (!found) {
      throw new SpecGuardError(
        `Unknown app: ${opts.app}. Known: ${config.apps.map((a) => a.name).join(', ')}`,
        ExitCode.InternalError,
      );
    }
    app = found;
  } else if (config.apps.length === 1) {
    app = config.apps[0];
  } else {
    throw new SpecGuardError(
      `Multiple apps in config — specify --app <name>. Known: ${config.apps.map((a) => a.name).join(', ')}`,
      ExitCode.InternalError,
    );
  }

  // Load source content.
  let content: string;
  const isUrl = opts.source.startsWith('http://') || opts.source.startsWith('https://');
  try {
    if (isUrl) {
      log(`[fetch] ${opts.source}`);
      content = await fetchUrl(opts.source);
    } else {
      const absPath = resolveFromRoot(config, opts.source);
      content = await readFile(absPath);
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    log(`[fail] Could not load source: ${message}`);
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    result.items.push({ key: opts.source, status: 'failed', message });
    return result;
  }

  const specDirAbs = resolveFromRoot(config, app.specDir);

  /** Generate one Living Spec from `sourceText` and write it to `targetPath`. */
  const generateSpec = async (
    key: string,
    sourceText: string,
    targetPath: string,
    title?: string,
  ): Promise<void> => {
    if (!opts.force && (await fileExists(targetPath))) {
      log(`[skip] ${targetPath} already exists (use --force to overwrite)`);
      result.skipped += 1;
      result.items.push({ key, status: 'skipped', path: targetPath, message: 'spec already exists' });
      return;
    }

    const prompt = [
      `Convert the following requirements document into a Living Specification:`,
      ...(title ? [`Suggested spec title: ${title}`] : []),
      '',
      '--- SOURCE DOCUMENT START ---',
      sourceText.slice(0, MAX_SOURCE_CHARS),
      '--- SOURCE DOCUMENT END ---',
    ].join('\n');

    try {
      const specContent = await llmGenerateText({
        provider: config.llm.provider,
        model: config.llm.model,
        apiKeyEnv: config.llm.apiKeyEnv,
        system: SYSTEM_PROMPT,
        prompt,
      });
      await writeFile(targetPath, specContent.endsWith('\n') ? specContent : specContent + '\n');
      log(`[import] ${key} → ${targetPath}`);
      result.created += 1;
      result.items.push({ key, status: 'created', path: targetPath });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      log(`[fail] LLM error: ${message}`);
      result.failed += 1;
      result.items.push({ key, status: 'failed', path: targetPath, message });
    }
  };

  const finalize = (): PipelineResult => {
    result.exitCode =
      result.created === 0 && result.failed > 0 ? ExitCode.InternalError : ExitCode.Success;
    return result;
  };

  // Decide: single spec or decompose into a set of specs.
  // `out` names a single file, so it implies single-spec output.
  const { preamble, sections } = splitSections(content);
  const docTitle = (content.match(/^#\s+(.+)/m)?.[1] ?? deriveSlug(content)).trim();
  const single = opts.single === true || !!opts.out || sections.length <= 1;

  if (single) {
    const slug = deriveSlug(content);
    const targetPath = opts.out
      ? resolveFromRoot(config, opts.out)
      : path.join(specDirAbs, `${slug}.md`);
    await generateSpec(slug, content, targetPath);
    return finalize();
  }

  // Multi-section document: plan a decomposition, then generate one spec per group.
  let plan: Plan;
  try {
    plan = await planDecomposition(config, docTitle, sections);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    log(`[warn] decomposition planning failed (${message}); falling back to a single spec`);
    const slug = deriveSlug(content);
    await generateSpec(slug, content, path.join(specDirAbs, `${slug}.md`));
    return finalize();
  }

  // Attach any section the planner left unassigned to the first spec, so no
  // content is silently dropped.
  const assigned = new Set<number>();
  for (const spec of plan.specs) {
    for (const i of spec.sectionIndexes) assigned.add(i);
  }
  const orphans = sections.map((s) => s.index).filter((i) => !assigned.has(i));
  if (orphans.length > 0 && plan.specs.length > 0) {
    plan.specs[0].sectionIndexes.push(...orphans);
    log(`[info] ${orphans.length} unassigned section(s) attached to "${plan.specs[0].slug}"`);
  }

  log(`[plan] ${plan.specs.length} spec(s): ${plan.specs.map((s) => s.slug).join(', ')}`);

  const usedSlugs = new Set<string>();
  for (const spec of plan.specs) {
    let slug = sanitizeSlug(spec.slug) || sanitizeSlug(spec.title) || 'spec';
    if (usedSlugs.has(slug)) {
      let n = 2;
      while (usedSlugs.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
    }
    usedSlugs.add(slug);

    // Assemble this spec's source slice: preamble + its sections in document order.
    const picked = spec.sectionIndexes
      .filter((i) => i >= 0 && i < sections.length)
      .sort((a, b) => a - b)
      .map((i) => sections[i].body);
    const sourceText = [preamble, ...picked].filter(Boolean).join('\n\n');

    await generateSpec(slug, sourceText, path.join(specDirAbs, `${slug}.md`), spec.title);
  }

  return finalize();
}
