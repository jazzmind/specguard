/**
 * Requirement history: `history add`, `history log`, and the two hook entry
 * points `history inbox` and `history capture`.
 *
 * Hooks must never disturb the session: they print nothing, tolerate any
 * input, and redact before anything touches disk.
 *
 * Spec: specs/capabilities/requirement-history.md
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import {
  addHistoryRef,
  historyDir,
  historyId,
  listHistory,
  renderHistoryEntry,
  type HistoryKind,
} from '../core/history.js';
import { ExitCode } from '../core/exit-codes.js';
import { llmGenerateObject } from '../core/llm.js';
import { createRedactor } from '../core/redact.js';
import { buildSpecGraph } from '../core/spec-graph.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { writeFile } from '../core/writer.js';

export interface HistoryAddOpts {
  prompt?: string;
  /** Plan text, or a path to a file holding it. */
  plan?: string;
  decision?: string;
  title?: string;
  kind?: HistoryKind;
  affects?: string[];
  source?: string;
  author?: string;
  /** Date override for tests, `YYYY-MM-DD`. */
  date?: string;
  /** Approval entries (`kind: approval`): the claims approved, as `ref@hash`. */
  approves?: string[];
  /** Approval entries: how the approval was given. */
  method?: string;
  /** Decision entries: policy changes made, one short line each (for example `enforce cart observe->warn`). */
  policy?: string[];
}

const INBOX = '.specguard/history/inbox.jsonl';
const CAPTURED = '.specguard/history/captured.json';
const INBOX_MAX_BYTES = 1_000_000;
/** A single prompt is cut to this many characters before it is redacted and stored. */
const PROMPT_MAX_CHARS = 50_000;
const INBOX_KEEP_LINES = 300;
const PROPOSE_TIMEOUT_MS = 25_000;

const rootOf = (config: SpecGuardConfig): string => config.rootDir ?? process.cwd();

function authorOf(root: string): string | undefined {
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (name) return name;
  } catch {
    /* not a git repo */
  }
  return process.env.USER || undefined;
}

const redactor = (config: SpecGuardConfig) => createRedactor(config.validate?.redaction);

const AffectsSchema = z.object({
  capabilities: z.array(z.string()).describe('Ids of the capabilities the text changes or constrains. Empty when none clearly apply.'),
});

/** A short summary of uncommitted changes, to ground the proposal. Empty outside git or with a clean tree. */
function workingTreeSummary(root: string): string {
  try {
    return execFileSync('git', ['diff', 'HEAD', '--stat'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().slice(0, 2000);
  } catch {
    return '';
  }
}

/** Ask the fast model which capabilities a piece of text affects. Returns [] when unavailable. */
export async function proposeAffects(config: SpecGuardConfig, text: string): Promise<string[]> {
  const graph = await buildSpecGraph(config);
  const caps = [...graph.nodes.values()].filter((n) => n.kind === 'capability');
  if (caps.length === 0 || config.llm.provider === 'none') return [];
  const known = new Set(caps.map((c) => c.id));
  try {
    const call = llmGenerateObject({
      provider: config.llm.provider,
      model: config.llm.model,
      apiKeyEnv: config.llm.apiKeyEnv,
      pipeline: 'history',
      hostAgent: false, // runs from hooks: with no key it returns [], it never leaves a request for the agent
      system: 'You decide which capabilities of a system a requirements change affects. Choose only from the listed ids.',
      prompt: `Capabilities:\n${caps.map((c) => `- ${c.id}: ${c.spec.meta.value ?? c.spec.title}`).join('\n')}\n\nChange:\n${text.slice(0, 12_000)}${workingTreeSummary(rootOf(config)) ? `\n\nUncommitted changes:\n${workingTreeSummary(rootOf(config))}` : ''}`,
      schema: AffectsSchema,
    });
    const res = await Promise.race([
      call,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), PROPOSE_TIMEOUT_MS).unref()),
    ]);
    return res.capabilities.filter((id) => known.has(id));
  } catch {
    return [];
  }
}

/** Write one entry and add its back-reference to every affected capability. Returns the entry id. */
export async function writeHistory(config: SpecGuardConfig, opts: HistoryAddOpts, log: (line: string) => void = () => undefined): Promise<string> {
  const root = rootOf(config);
  const redact = redactor(config);
  const dir = historyDir(config);
  const taken = new Set(listHistory(config).map((e) => e.id));

  const sections: string[] = [];
  if (opts.prompt?.trim()) sections.push(`## Prompt\n\n${redact.text(opts.prompt.trim())}`);
  if (opts.plan?.trim()) sections.push(`## Plan\n\n${redact.text(opts.plan.trim())}`);
  if (opts.decision?.trim()) sections.push(`## Decision\n\n${redact.text(opts.decision.trim())}`);
  const body = sections.join('\n\n');

  const kind: HistoryKind = opts.kind ?? (opts.prompt && opts.plan ? 'prompt+plan' : opts.plan ? 'plan' : opts.decision ? 'decision' : 'prompt');
  // The title becomes the file name and a frontmatter field, so it is built from redacted text only.
  const heading = opts.plan ? redact.text(opts.plan).match(/^#\s+(.+)$/m)?.[1] : undefined;
  const title = redact.text(opts.title ?? heading ?? (opts.decision ?? opts.prompt ?? 'entry').split(/\r?\n/)[0].slice(0, 80));
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const id = historyId(date, title, taken);

  const graph = await buildSpecGraph(config);
  let affects = opts.affects ?? [];
  if (!opts.affects) {
    affects = await proposeAffects(config, `${title}\n${body}`);
    if (affects.length > 0) log(`[info] affects (proposed): ${affects.join(', ')}`);
    // With no proposal, the entry is about the system as a whole.
    if (affects.length === 0 && graph.system) {
      affects = [graph.system.id];
      log('[info] no capability proposed; recorded against the system spec');
    }
  }

  await writeFile(
    path.join(dir, `${id}.md`),
    renderHistoryEntry({ id, date, kind, author: opts.author ?? authorOf(root), source: opts.source ?? 'manual', title, affects, approves: opts.approves, method: opts.method, policy: opts.policy?.map((p) => redact.text(p)) }, `# ${title}\n\n${body}`),
  );
  for (const a of affects) {
    const node = graph.nodes.get(a);
    if (!node) continue;
    const file = path.join(path.dirname(dir), `${node.specKey}.md`);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = addHistoryRef(before, id);
    if (after !== before) await writeFile(file, after);
  }
  return id;
}

export async function runHistoryAdd(config: SpecGuardConfig, opts: HistoryAddOpts): Promise<PipelineResult> {
  const result = emptyResult('history-add');
  // An approval says a person agrees with a requirement: only `spec approve` (person-run, with its guards) writes one.
  if (opts.kind === 'approval' || (opts.approves && opts.approves.length > 0)) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    result.messages.push('approvals are recorded by `specguard spec approve`, run by a person; history add cannot write them');
    return result;
  }
  if (!opts.prompt && !opts.plan && !opts.decision) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    result.messages.push('give at least one of --prompt, --plan or --decision');
    return result;
  }
  if (opts.affects && opts.affects.length > 0) {
    const graph = await buildSpecGraph(config);
    const unknown = opts.affects.filter((id) => !graph.nodes.has(id));
    if (unknown.length > 0) {
      result.failed = 1;
      result.exitCode = ExitCode.ValidationFailed;
      result.messages.push(`unknown capability id(s): ${unknown.join(', ')}. Nothing was written.`);
      return result;
    }
  }
  let plan = opts.plan;
  if (plan && !plan.includes('\n') && fs.existsSync(path.resolve(rootOf(config), plan))) {
    plan = fs.readFileSync(path.resolve(rootOf(config), plan), 'utf8');
  }
  const id = await writeHistory(config, { ...opts, plan }, (l) => result.messages.push(l));
  result.created = 1;
  result.items.push({ key: id, status: 'created', path: path.join(historyDir(config), `${id}.md`) });
  result.messages.push(`recorded ${id}`);
  return result;
}

export async function runHistoryLog(config: SpecGuardConfig, opts: { capability?: string } = {}): Promise<PipelineResult> {
  const result = emptyResult('history-log');
  const graph = await buildSpecGraph(config);
  const linked = new Set(graph.nodes.get(opts.capability ?? '')?.spec.meta.history ?? []);
  const entries = listHistory(config)
    .filter((e) => !opts.capability || e.affects.includes(opts.capability) || linked.has(e.id))
    .reverse();
  for (const e of entries) {
    result.messages.push(`${e.date}  ${e.kind.padEnd(11)}  ${e.id}${e.affects.length > 0 ? `  -> ${e.affects.join(', ')}` : ''}${e.title ? `  ${e.title}` : ''}`);
    result.items.push({ key: e.id, status: 'ok', path: e.file });
  }
  if (entries.length === 0) result.messages.push(opts.capability ? `no history for ${opts.capability}` : 'no history yet');
  result.created = entries.length;
  return result;
}

// ---------------------------------------------------------------------------
// Hook entry points
// ---------------------------------------------------------------------------

interface InboxLine {
  ts: number;
  session: string;
  cwd?: string;
  prompt: string;
}

function readJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** UserPromptSubmit hook: append the (redacted) prompt to the uncommitted inbox. Never throws, never prints. */
export function recordPrompt(config: SpecGuardConfig, stdin: string, now = Date.now()): boolean {
  const input = readJson(stdin);
  const prompt = input && typeof input.prompt === 'string' ? input.prompt : '';
  if (!input || !prompt.trim()) return false;
  const file = path.join(rootOf(config), INBOX);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const isNew = !fs.existsSync(file);
    const line: InboxLine = {
      ts: now,
      session: String(input.session_id ?? 'unknown'),
      cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
      prompt: redactor(config).text(prompt.length > PROMPT_MAX_CHARS ? `${prompt.slice(0, PROMPT_MAX_CHARS)}\n[truncated]` : prompt),
    };
    // Prompts can hold sensitive text even after redaction: the inbox is for its owner only.
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    if (isNew) fs.chmodSync(file, 0o600);
    if (fs.statSync(file).size > INBOX_MAX_BYTES) {
      const keep = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-INBOX_KEEP_LINES);
      fs.writeFileSync(file, `${keep.join('\n')}\n`);
    }
    return true;
  } catch {
    return false;
  }
}

function readInbox(root: string): InboxLine[] {
  try {
    return fs
      .readFileSync(path.join(root, INBOX), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as InboxLine);
  } catch {
    return [];
  }
}

/** The plan from an ExitPlanMode tool call: the hook input first, else the last such call in the transcript. */
export function planFromHook(input: Record<string, unknown>): string | undefined {
  const direct = (input.tool_input as { plan?: unknown } | undefined)?.plan;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const transcript = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (!transcript || !fs.existsSync(transcript)) return undefined;
  const lines = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = readJson(lines[i]);
    const content = (row?.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<Record<string, unknown>>) {
      const plan = (part.input as { plan?: unknown } | undefined)?.plan;
      if (part.type === 'tool_use' && part.name === 'ExitPlanMode' && typeof plan === 'string') return plan;
    }
  }
  return undefined;
}

/**
 * PostToolUse hook on ExitPlanMode: write one committed entry holding the
 * approved plan and that session's prompts since the last capture.
 * Returns the entry id, or undefined when there was nothing to capture.
 */
export async function capturePlan(config: SpecGuardConfig, stdin: string): Promise<string | undefined> {
  const input = readJson(stdin);
  if (!input) return undefined;
  const plan = planFromHook(input);
  if (!plan) return undefined;
  const root = rootOf(config);
  const session = String(input.session_id ?? 'unknown');

  let captured: Record<string, number> = {};
  try {
    captured = JSON.parse(fs.readFileSync(path.join(root, CAPTURED), 'utf8')) as Record<string, number>;
  } catch {
    /* first capture */
  }
  const since = captured[session] ?? 0;
  const prompts = readInbox(root).filter((l) => l.session === session && l.ts > since);

  const id = await writeHistory(config, {
    prompt: prompts.map((p) => p.prompt).join('\n\n---\n\n') || undefined,
    plan,
    kind: prompts.length > 0 ? 'prompt+plan' : 'plan',
    source: 'claude-code',
  });
  captured[session] = prompts.length > 0 ? Math.max(...prompts.map((p) => p.ts)) : Date.now();
  await writeFile(path.join(root, CAPTURED), JSON.stringify(captured, null, 2) + '\n');
  return id;
}
