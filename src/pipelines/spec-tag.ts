/**
 * `specguard spec tag`: link existing tests to the requirements they prove.
 *
 * For each capability spec, the model is shown its requirements and the leaf
 * tests in the files its `tests:` globs name, and says which requirements each
 * test clearly exercises. The answer is validated (only real requirement ids
 * and test numbers survive) and written as a `[claims: ...]` comment above the
 * test, which the same scanner that reads `@claim` tags picks up. A test that
 * is already tagged is never touched. Dry run unless `--yes`.
 *
 * With `--index <file>` the test sources are never modified (they may belong to
 * another repo): each match is recorded as one line of a plain-text index,
 * `<test-file>:<line> :: <title>  [claims: <ref>, <ref>]`, which `check` reads
 * as a test file listed in `extraTestSources` / a capability's `tests:`.
 *
 * Spec: specs/capabilities/spec-authoring.md
 */
import path from 'node:path';
import { z } from 'zod';

import { ExitCode } from '../core/exit-codes.js';
import { AgentWorkPendingError, pendingThisRun } from '../core/agent-work.js';
import { llmGenerateObject } from '../core/llm.js';
import { expandGlobs, fileExists, readFile } from '../core/reader.js';
import { buildSpecGraph } from '../core/spec-graph.js';
import { insertClaimTags, scanTestDeclarations } from '../core/test-declarations.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { writeFile } from '../core/writer.js';

export interface SpecTagOpts {
  /** One capability id. */
  spec?: string;
  /** Write the tags; without it the run only reports what it would tag. */
  yes?: boolean;
  /** Tests shown to the model per call. Default 120. */
  chunkSize?: number;
  /** Print every test with the requirements it was tagged with, so the result can be reviewed. */
  list?: boolean;
  /**
   * Record matches in this plain-text index (path relative to the config root)
   * instead of editing test sources; re-runnable, and tests it already lists are skipped.
   */
  index?: string;
  onLog?: (line: string) => void;
}

const MatchSchema = z.object({
  matches: z.array(
    z.object({
      test: z.number().int(),
      claims: z.array(
        z.object({
          id: z.string(),
          confidence: z.enum(['high', 'medium']).describe('high: the test directly asserts the behaviour the requirement states. medium: it only touches the same area.'),
        }),
      ),
    }),
  ),
});

const SYSTEM =
  'You link tests to the requirements they prove. For each test, list the requirement ids whose stated behaviour the test asserts. ' +
  'A wrong link is worse than a missing one: it makes a requirement look proven by a test that only touches nearby code. ' +
  'Mark a link "high" only when the test would fail if that requirement stopped holding; mark it "medium" when the test merely exercises the same area, a helper, or an error path the requirement does not state. ' +
  'Leave a test out if nothing fits. Never guess an id; use only ids from the list. A test may prove several requirements.';

interface Planned {
  file: string;
  line: number;
  title: string;
  refs: Set<string>;
}

const INDEX_LINE = /^(.+?):(\d+) :: (.*?)(?:\s+\[claims: ([^\]]*)\])?\s*$/;

interface IndexEntry {
  file: string;
  line: number;
  title: string;
  refs: string[];
}

/** One test per line; text that is not an index line (a header, a note) is kept as `other`. */
export function parseTagIndex(text: string): { entries: IndexEntry[]; other: string[] } {
  const entries: IndexEntry[] = [];
  const other: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = INDEX_LINE.exec(raw);
    if (!m) other.push(raw);
    else entries.push({ file: m[1], line: Number(m[2]), title: m[3], refs: (m[4] ?? '').split(',').map((r) => r.trim()).filter(Boolean) });
  }
  return { entries, other };
}

export function formatIndexEntry(e: IndexEntry): string {
  return `${e.file}:${e.line} :: ${e.title}  [claims: ${e.refs.join(', ')}]`;
}

/** Merge new entries into an index: the same `file:line :: title` is replaced, other lines stay, entries are sorted. */
export function mergeTagIndex(existing: string, fresh: IndexEntry[]): string {
  const { entries, other } = parseTagIndex(existing);
  const byKey = new Map(entries.map((e) => [`${e.file}:${e.line} :: ${e.title}`, e]));
  for (const e of fresh) byKey.set(`${e.file}:${e.line} :: ${e.title}`, e);
  const sorted = [...byKey.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)));
  return `${[...other, ...sorted.map(formatIndexEntry)].join('\n')}\n`;
}

export async function runSpecTag(config: SpecGuardConfig, opts: SpecTagOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('spec-tag');
  const log = (line: string): void => {
    result.messages.push(line);
    opts.onLog?.(line);
  };
  const root = config.rootDir ?? process.cwd();
  const graph = await buildSpecGraph(config);
  const caps = [...graph.nodes.values()]
    .filter((n) => (n.kind === 'capability' || n.kind === 'component') && (!opts.spec || n.id === opts.spec))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (opts.spec && caps.length === 0) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    log(`no capability "${opts.spec}"`);
    return result;
  }
  const chunk = opts.chunkSize ?? 120;
  const indexPath = opts.index ? path.resolve(root, opts.index) : undefined;
  // Tests the index already lists, by `file:line` and by `file` + title (so a test that moved lines is still known).
  const indexed = new Set<string>();
  let indexText = '';
  if (indexPath && (await fileExists(indexPath))) {
    indexText = await readFile(indexPath);
    for (const e of parseTagIndex(indexText).entries) {
      indexed.add(`${e.file}:${e.line}`);
      indexed.add(`${e.file}\0${e.title}`);
    }
  }
  const planned = new Map<string, Planned>();
  let awaitingAgent = false;

  for (const node of caps) {
    const claims = node.spec.claims.filter((c) => c.id);
    const globs = node.spec.meta.tests ?? [];
    if (claims.length === 0 || globs.length === 0) {
      log(`[skip] ${node.id}: ${claims.length === 0 ? 'no requirements with ids' : 'no tests listed'}`);
      result.skipped += 1;
      continue;
    }
    const known = new Set(claims.map((c) => c.id as string));
    const files = (await expandGlobs(globs, root)).map((a) => path.relative(root, a).split(path.sep).join('/'));
    const tests: Array<{ file: string; line: number; title: string }> = [];
    for (const file of files) {
      for (const d of scanTestDeclarations(await readFile(path.join(root, file)), file)) {
        if (!d.tagged && !indexed.has(`${file}:${d.line}`) && !indexed.has(`${file}\0${d.title}`)) tests.push({ file, line: d.line, title: d.title });
      }
    }
    if (tests.length === 0) {
      log(`[skip] ${node.id}: no untagged tests`);
      result.skipped += 1;
      continue;
    }

    const covered = new Set<string>();
    let tagged = 0;
    for (let start = 0; start < tests.length; start += chunk) {
      const batch = tests.slice(start, start + chunk);
      let answer: z.infer<typeof MatchSchema>;
      try {
        answer = await llmGenerateObject({
          provider: config.llm.provider,
          model: config.llm.model,
          apiKeyEnv: config.llm.apiKeyEnv,
          pipeline: 'tag',
          system: SYSTEM,
          prompt:
            `Capability: ${node.spec.title || node.id}\n\nRequirements:\n${claims.map((c) => `- ${c.id}: ${c.text}`).join('\n')}\n\n` +
            `Tests:\n${batch.map((t, i) => `${i}. ${t.file} — ${t.title}`).join('\n')}`,
          schema: MatchSchema,
        });
      } catch (err) {
        // Waiting for the host agent: keep collecting requests for the other capabilities, and apply nothing yet.
        if (err instanceof AgentWorkPendingError) {
          awaitingAgent = true;
          continue;
        }
        throw err;
      }
      for (const m of answer.matches) {
        const test = batch[m.test];
        // Only links the model is sure of: a medium link would overstate what the test proves.
        const ids = [...new Set(m.claims.filter((c) => c.confidence === 'high' && known.has(c.id)).map((c) => c.id))];
        if (!test || ids.length === 0) continue;
        const key = `${test.file}:${test.line}`;
        const entry = planned.get(key) ?? { file: test.file, line: test.line, title: test.title, refs: new Set<string>() };
        for (const id of ids) {
          entry.refs.add(`${node.specKey}#${id}`);
          covered.add(id);
        }
        planned.set(key, entry);
        tagged += 1;
      }
    }
    const uncovered = [...known].filter((id) => !covered.has(id));
    log(`${node.id}: ${tagged} of ${tests.length} untagged test(s) matched; ${covered.size} of ${known.size} requirement(s) now cited${uncovered.length ? `; no test found for: ${uncovered.join(', ')}` : ''}`);
    result.items.push({ key: node.id, status: tagged > 0 ? 'ok' : 'skipped', message: `${tagged} tests, ${uncovered.length} requirements uncovered` });
  }

  if (awaitingAgent) throw new AgentWorkPendingError(pendingThisRun());

  if (indexPath) {
    const fresh = [...planned.values()].map((p) => ({ file: p.file, line: p.line, title: p.title, refs: [...p.refs].sort() }));
    if (opts.list) {
      for (const p of [...planned.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
        log(`  ${p.file}:${p.line}  ${p.title}  ->  ${[...p.refs].sort().join(', ')}`);
      }
    }
    if (opts.yes && fresh.length > 0) await writeFile(indexPath, mergeTagIndex(indexText, fresh));
    result.created = fresh.length;
    const where = path.relative(root, indexPath).split(path.sep).join('/') || opts.index;
    log(opts.yes ? `indexed ${fresh.length} test(s) in ${where}; test sources untouched` : `would index ${fresh.length} test(s) in ${where}; rerun with --yes to write`);
    return result;
  }

  // Apply per file, merging refs when two capabilities claim the same test.
  const byFile = new Map<string, Map<number, string[]>>();
  for (const p of planned.values()) {
    const edits = byFile.get(p.file) ?? new Map<number, string[]>();
    edits.set(p.line, [...p.refs].sort());
    byFile.set(p.file, edits);
  }
  let added = 0;
  for (const [file, edits] of byFile) {
    const abs = path.join(root, file);
    const { text, added: n } = insertClaimTags(await readFile(abs), file, edits);
    added += n;
    if (opts.yes && n > 0) await writeFile(abs, text);
  }
  if (opts.list) {
    for (const p of [...planned.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      log(`  ${p.file}:${p.line}  ${p.title}  ->  ${[...p.refs].sort().join(', ')}`);
    }
  }
  result.created = added;
  log(opts.yes ? `tagged ${added} test(s) in ${byFile.size} file(s)` : `would tag ${added} test(s) in ${byFile.size} file(s); rerun with --yes to write`);
  return result;
}
