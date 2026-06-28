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

import type { SpecGuardConfig, AppConfig, PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import { readFile, fileExists } from '../core/reader.js';
import { writeFile } from '../core/writer.js';
import { llmGenerateText } from '../core/llm.js';

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
}

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

  // Derive output path.
  const slug = deriveSlug(content);
  const specDirAbs = resolveFromRoot(config, app.specDir);
  const targetPath = opts.out
    ? resolveFromRoot(config, opts.out)
    : path.join(specDirAbs, `${slug}.md`);

  // Skip if exists and not force.
  if (!opts.force && (await fileExists(targetPath))) {
    log(`[skip] ${targetPath} already exists (use --force to overwrite)`);
    result.skipped = 1;
    result.items.push({ key: slug, status: 'skipped', path: targetPath, message: 'spec already exists' });
    return result;
  }

  // LLM transformation.
  const prompt = [
    `Convert the following requirements document into a Living Specification:`,
    '',
    '--- SOURCE DOCUMENT START ---',
    content.slice(0, 24_000), // cap to avoid token overflow
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
    log(`[import] ${slug} → ${targetPath}`);
    result.created = 1;
    result.items.push({ key: slug, status: 'created', path: targetPath });
    result.exitCode = ExitCode.Success;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    log(`[fail] LLM error: ${message}`);
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    result.items.push({ key: slug, status: 'failed', path: targetPath, message });
  }

  return result;
}
