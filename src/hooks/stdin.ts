/**
 * Reads the JSON a coding agent sends a hook on stdin (Claude Code or Codex PreToolUse, PostToolUse, SessionStart) and
 * turns it into the `HookEvent` the decision table understands. Pure and defensive: malformed JSON, an unexpected shape
 * or a tool it does not know becomes an event that writes nothing (so the table allows it), never an exception. The
 * hook must not break an agent's session over a payload it cannot read.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */
import path from 'node:path';

import type { HookEvent } from './decide.js';

export type StdinNoopReason = 'malformed-json' | 'not-an-object' | 'no-tool' | 'unknown-event' | 'no-paths';

export interface ParsedHookInput {
  /** Always usable: when the payload carries nothing to guard it has no paths and no command, and the table allows it. */
  event: HookEvent;
  /** `hook_event_name` as sent (PreToolUse, PostToolUse, SessionStart, ...), when present. */
  hookEventName?: string;
  /** SessionStart's `source` (startup, resume, clear, compact, fork). */
  source?: string;
  session?: string;
  cwd?: string;
  /** Paths the tool would write that fall outside the repository root. They are not in `event.paths`; the entry answers OUTSIDE_REPO for an event whose paths all land here. */
  outside: string[];
  /** Why the event guards nothing, when it does not. */
  noop?: StdinNoopReason;
}

export interface ParseOptions {
  /** Which host sent it; inferred from the payload (Codex sends `turn_id`) when absent. */
  agent?: 'claude' | 'codex';
  /** Repository root, absolute. Defaults to the payload's `cwd`. Paths are made relative to it. */
  root?: string;
}

const MAX_INPUT_CHARS = 5_000_000;
const MAX_TEXT_CHARS = 200_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** A shell command as one string: Codex sends an argv array, where `[shell, '-lc', script]` means the script. */
function commandText(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length > 0 ? v : undefined;
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) return undefined;
  const argv = v as string[];
  if (argv.length >= 3 && /(^|\/)(ba|z|da|k)?sh$/.test(argv[0]!) && /^-[a-zA-Z]*c$/.test(argv[1]!)) return argv[2];
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** The paths a Codex/`git apply` patch touches, and the lines it adds (the new text of its files). */
export function parsePatch(patch: string): { paths: string[]; added: string } {
  const paths: string[] = [];
  const added: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | undefined): void => {
    const t = p?.trim().replace(/^["']|["']$/g, '');
    if (!t || t === '/dev/null' || seen.has(t)) return;
    seen.add(t);
    paths.push(t);
  };
  for (const raw of String(patch ?? '').slice(0, MAX_TEXT_CHARS * 5).split('\n')) {
    const line = raw.replace(/\r$/, '');
    let m = /^\s*\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line);
    if (m) {
      add(m[1]);
      continue;
    }
    m = /^\s*\*\*\* Move to:\s*(.+?)\s*$/.exec(line);
    if (m) {
      add(m[1]);
      continue;
    }
    m = /^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/.exec(line);
    if (m) {
      add(m[1]);
      continue;
    }
    if (line.startsWith('+')) added.push(line.slice(1));
  }
  return { paths, added: added.join('\n') };
}

const looksLikePatch = (text: string): boolean => /^\s*\*\*\* (?:Begin Patch|(?:Add|Update|Delete) File:)/m.test(text);

const EDIT_NAMES = /edit|write|patch|replace|create/i;
const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;

function limitText(text: string | undefined): string | undefined {
  return text === undefined ? undefined : text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
}

/** Repo-relative POSIX path, or null when it lands outside `root`. */
function relativize(p: string, cwd: string | undefined, root: string | undefined): string | null {
  const clean = p.replace(/\\/g, '/');
  if (!root && !cwd) {
    // Without a directory to anchor on, only a relative path that stays put can be answered.
    if (path.posix.isAbsolute(clean)) return null;
    const rel = path.posix.normalize(clean);
    return rel === '..' || rel.startsWith('../') ? null : rel;
  }
  const base = (cwd ?? root)!;
  const abs = path.posix.isAbsolute(clean) ? path.posix.normalize(clean) : path.posix.resolve(base.replace(/\\/g, '/'), clean);
  const rel = path.posix.relative((root ?? base).replace(/\\/g, '/'), abs);
  if (rel === '' || rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) return null;
  return rel;
}

/** Text the tool would write: Write `content`, Edit `new_string`, MultiEdit every `new_string`, NotebookEdit `new_source`. */
function newTextOf(input: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const k of ['content', 'new_string', 'new_source', 'text', 'file_text', 'new_str'] as const) {
    const v = input[k];
    if (typeof v === 'string') parts.push(v);
  }
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (isRecord(e) && typeof e.new_string === 'string') parts.push(e.new_string);
  }
  return parts.length > 0 ? limitText(parts.join('\n')) : undefined;
}

export function parseHookInput(raw: string, opts: ParseOptions = {}): ParsedHookInput {
  const noop = (reason: StdinNoopReason, agent: 'claude' | 'codex', extra: Partial<ParsedHookInput> = {}): ParsedHookInput => ({
    event: { event: 'PreToolUse', tool: extra.event?.tool ?? '', paths: [], agent },
    outside: [],
    ...extra,
    noop: reason,
  });
  const fallbackAgent = opts.agent ?? 'claude';

  let data: unknown;
  try {
    const text = String(raw ?? '');
    if (text.length > MAX_INPUT_CHARS) return noop('malformed-json', fallbackAgent);
    data = JSON.parse(text);
  } catch {
    return noop('malformed-json', fallbackAgent);
  }
  if (!isRecord(data)) return noop('not-an-object', fallbackAgent);

  const agent = opts.agent ?? ('turn_id' in data ? 'codex' : 'claude');
  const cwd = str(data.cwd);
  const root = opts.root ?? cwd;
  const hookEventName = str(data.hook_event_name);
  const meta = {
    ...(hookEventName ? { hookEventName } : {}),
    ...(str(data.source) ? { source: str(data.source) } : {}),
    ...(str(data.session_id) ? { session: str(data.session_id) } : {}),
    ...(cwd ? { cwd } : {}),
  };
  const subagent = str(data.agent_type) ?? str(data.agent_id);

  const phase: HookEvent['event'] | null =
    hookEventName === 'PreToolUse' ? 'PreToolUse'
    : hookEventName === 'PostToolUse' ? 'PostToolUse'
    : hookEventName === undefined && str(data.tool_name) ? ('tool_response' in data ? 'PostToolUse' : 'PreToolUse')
    : null;
  if (phase === null) {
    // SessionStart, UserPromptSubmit and anything newer: nothing to guard. PostToolUse is the table's allow-all phase.
    return { ...noop('unknown-event', agent, meta), event: { event: 'PostToolUse', tool: '', paths: [], agent, ...(subagent ? { subagent } : {}) } };
  }

  const tool = str(data.tool_name);
  const input = isRecord(data.tool_input) ? data.tool_input : {};
  const base: HookEvent = { event: phase, tool: tool ?? '', paths: [], agent, ...(subagent ? { subagent } : {}) };
  if (!tool) return noop('no-tool', agent, { ...meta, event: base });

  const rawPaths: string[] = [];
  let newText: string | undefined;
  let bash: string | undefined;

  const command = commandText(input.command);
  const patchText = [input.input, input.patch, input.command].map((v) => (typeof v === 'string' ? v : commandText(v))).find((t) => t && looksLikePatch(t));

  if (patchText) {
    const parsed = parsePatch(patchText);
    rawPaths.push(...parsed.paths);
    newText = limitText(parsed.added);
    // A patch fed through a shell (`apply_patch <<EOF ...`) is also a command; the Bash guard reads it too.
    if (command && !/^apply_patch$/i.test(tool) && !EDIT_NAMES.test(tool)) bash = limitText(command);
  } else if (command !== undefined && !EDIT_NAMES.test(tool)) {
    bash = limitText(command);
  } else if (EDIT_NAMES.test(tool) || /^(str_replace|str_replace_editor|str_replace_based_edit_tool)$/i.test(tool)) {
    for (const k of PATH_KEYS) {
      const v = str(input[k]);
      if (v) {
        rawPaths.push(v);
        break;
      }
    }
    newText = newTextOf(input);
  }

  const paths: string[] = [];
  const outside: string[] = [];
  for (const p of [...new Set(rawPaths)]) {
    const rel = relativize(p, cwd, root);
    if (rel === null) outside.push(p);
    else if (!paths.includes(rel)) paths.push(rel);
  }

  const event: HookEvent = { ...base, paths, ...(newText !== undefined ? { newText } : {}), ...(bash !== undefined ? { bash } : {}) };
  const result: ParsedHookInput = { event, outside, ...meta };
  if (paths.length === 0 && bash === undefined) result.noop = 'no-paths';
  return result;
}
