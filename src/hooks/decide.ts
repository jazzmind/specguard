/**
 * The agent edit guard's decision table. The hook entry reads the tool call and the ownership index, classifies each
 * path the tool would write, and asks this module whether to allow, deny or ask. Pure: no file, git or process access,
 * so the same table runs in the hook bundle, the CLI and the tests, in well under a millisecond.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */
import type { ChangeKind } from '../core/change-record.js';
import type { EnforceLevel } from '../core/types.js';

export const HOOK_INDEX_VERSION = 1;

/** Longest message the agent sees (deny) or receives as additional context (allow). */
export const HOOK_MESSAGE_MAX = 300;

/**
 * The ownership index (`.specguard/cache/hook-index.json`). Declared here, with the decision table that reads it, so
 * the decision module stays free of the graph and git code that builds it (`src/hooks/index-build.ts`).
 */
export interface HookIndex {
  version: 1;
  builtAt: string;
  /** Cheap staleness key: (path, mtimeMs, size) of every spec file, config, .specguard/changes/*, cache/changes/<id>/red.json. */
  fingerprint: string;
  /** Repo-relative. */
  specsRoot: string;
  /** Repo-relative. */
  historyDir: string;
  /** Union of app test globs. */
  testGlobs: string[];
  /** Exact owned files -> capability ids (from spec-graph ownedFiles). */
  owned: Record<string, string[]>;
  /** For files not yet existing (Write): capability source globs. */
  capabilities: Array<{ id: string; specFile: string; enforce: EnforceLevel; sources: string[] }>;
  openChanges: Array<{
    id: string;
    kind: ChangeKind;
    capabilities: string[];
    /** Test files tagged to the change's changed refs (the stage lock set). */
    lockedTests: string[];
    /** Validity at build time; the entry re-checks it live. */
    red?: { testsHash: string; claimsHash: string; valid: boolean };
    approvedAll: boolean;
  }>;
}

export type PathClass =
  | { kind: 'owned'; capabilities: string[] }
  | { kind: 'test'; /** Change ids. */ lockedBy: string[] }
  | { kind: 'spec'; capability?: string }
  | { kind: 'history'; approvalLike: boolean }
  | { kind: 'change-record'; closed: boolean }
  | { kind: 'specguard-config' }
  | { kind: 'workflow' }
  | { kind: 'other' };

export interface HookEvent {
  event: 'PreToolUse' | 'PostToolUse';
  tool: string;
  /** Repo-relative POSIX paths the tool would write (Edit/Write/MultiEdit/NotebookEdit/apply_patch), [] for Bash. */
  paths: string[];
  /** For Write/Edit: new content (to spot `kind: approval` in history files). */
  newText?: string;
  bash?: string;
  agent: 'claude' | 'codex';
  subagent?: string;
}

export const HOOK_CODES = [
  'OUTSIDE_REPO', 'NOT_SPECGUARD', 'FREE', 'OBSERVED', 'WARN_NO_CHANGE', 'WARN_BEFORE_RED',
  'DENY_NO_CHANGE', 'DENY_BEFORE_RED', 'DENY_NOT_APPROVED', 'ALLOW_CHANGE', 'ALLOW_REFACTOR', 'ALLOW_SPIKE',
  'LOCK_TESTS', 'LOCK_SPEC', 'DENY_APPROVAL_WRITE', 'DENY_RECORD_EDIT', 'DENY_BASH_APPROVE', 'DENY_BASH_NOTES',
  'NOTE_POLICY_FILE', 'ERROR_OPEN', 'ERROR_CLOSED',
] as const;
export type HookCode = (typeof HOOK_CODES)[number];

export const HOOK_DECISIONS = ['allow', 'deny', 'ask'] as const;

export interface HookLogEntry {
  ts: string;
  session?: string;
  agent?: string;
  tool: string;
  paths: string[];
  caps: string[];
  level: EnforceLevel | null;
  decision: HookDecision['decision'];
  code: HookCode;
  change?: string;
}

export interface HookDecision {
  decision: (typeof HOOK_DECISIONS)[number];
  /** Shown to the agent (deny) or as additionalContext (allow). Max HOOK_MESSAGE_MAX chars. */
  message?: string;
  log: HookLogEntry;
}


// ---------------------------------------------------------------------------------------------------------------------
// Constants. Duplicated from the change-record module on purpose: this module imports types only, so the hook bundle
// stays free of the record's parser and schema.
// ---------------------------------------------------------------------------------------------------------------------

const CHANGES_PREFIX = '.specguard/changes/';
const CONFIG_PATH = '.specguard/config.json';
const WORKFLOWS_PREFIX = '.github/workflows/';

type Matcher = (glob: string, path: string) => boolean;
type Level = EnforceLevel;
type OpenChange = HookIndex['openChanges'][number];

const LEVEL_ORDER: Record<Level, number> = { observe: 0, warn: 1, enforce: 2 };

const has = (o: object | undefined, k: string): boolean => o !== undefined && Object.prototype.hasOwnProperty.call(o, k);

/** The index comes from a cache file, so every field is read defensively. */
function capabilitiesOf(index: HookIndex): HookIndex['capabilities'] {
  return Array.isArray(index?.capabilities) ? index.capabilities : [];
}
function openChangesOf(index: HookIndex): OpenChange[] {
  return Array.isArray(index?.openChanges) ? index.openChanges : [];
}

/** POSIX, no leading `./`, no `//`, no `.` segments. `..` segments stay (callers treat them as outside the repo). */
function normalizePath(path: string): string {
  let p = String(path ?? '').replace(/\\/g, '/');
  p = p.replace(/\/{2,}/g, '/');
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' && parts.length > 0) continue;
    if (seg === '.') continue;
    parts.push(seg);
  }
  return parts.join('/');
}

function underDir(path: string, dir: string | undefined): boolean {
  if (!dir) return false;
  const d = normalizePath(dir).replace(/\/$/, '');
  return d.length > 0 && (path === d || path.startsWith(`${d}/`));
}

function isCodeowners(path: string): boolean {
  return /(^|\/)CODEOWNERS$/.test(path);
}

function sourceGlobMatches(globs: string[], path: string, matchGlob: Matcher): boolean {
  let hit = false;
  for (const g of globs) {
    if (typeof g !== 'string' || g.length === 0) continue;
    if (g.startsWith('!')) {
      if (matchGlob(g.slice(1), path)) return false;
    } else if (!hit && matchGlob(g, path)) hit = true;
  }
  return hit;
}

/** One repo-relative POSIX path -> its class, from the index. `matchGlob` is injected (picomatch in the bundle). */
export function classify(path: string, index: HookIndex, matchGlob: (glob: string, path: string) => boolean): PathClass {
  const p = normalizePath(path);
  if (p === '' || p.startsWith('/') || p === '..' || p.startsWith('../')) return { kind: 'other' };

  if (p.startsWith(CHANGES_PREFIX) && p.endsWith('.json') && !p.slice(CHANGES_PREFIX.length).includes('/')) {
    const id = p.slice(CHANGES_PREFIX.length, -'.json'.length);
    return { kind: 'change-record', closed: !openChangesOf(index).some((c) => c?.id === id) };
  }
  if (p === CONFIG_PATH) return { kind: 'specguard-config' };
  if (p.startsWith(WORKFLOWS_PREFIX) || isCodeowners(p)) return { kind: 'workflow' };

  // The history directory usually sits inside the specs root, so it is tested first.
  if (underDir(p, index?.historyDir)) return { kind: 'history', approvalLike: false };

  const caps = capabilitiesOf(index);
  const bySpecFile = caps.find((c) => c?.specFile === p);
  if (bySpecFile) return { kind: 'spec', capability: bySpecFile.id };
  if (underDir(p, index?.specsRoot)) return { kind: 'spec' };

  // A test file is always editable, so it wins over a source glob that happens to cover it.
  const locked = openChangesOf(index).filter((c) => Array.isArray(c?.lockedTests) && c.lockedTests.includes(p));
  const testGlobs = Array.isArray(index?.testGlobs) ? index.testGlobs : [];
  if (locked.length > 0 || sourceGlobMatches(testGlobs, p, matchGlob)) return { kind: 'test', lockedBy: locked.map((c) => c.id) };

  const owners = new Set<string>(has(index?.owned, p) && Array.isArray(index.owned[p]) ? index.owned[p] : []);
  if (owners.size === 0) {
    for (const c of caps) if (c && Array.isArray(c.sources) && sourceGlobMatches(c.sources, p, matchGlob)) owners.add(c.id);
  }
  if (owners.size > 0) return { kind: 'owned', capabilities: [...owners] };
  return { kind: 'other' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Messages. One short line plus one command, at most HOOK_MESSAGE_MAX characters.
// ---------------------------------------------------------------------------------------------------------------------

function clamp(message: string): string {
  const one = message.replace(/\s+/g, ' ').trim();
  return one.length <= HOOK_MESSAGE_MAX ? one : `${one.slice(0, HOOK_MESSAGE_MAX - 1)}\u2026`;
}

function capList(caps: string[]): string {
  if (caps.length <= 2) return caps.join(', ');
  return `${caps.slice(0, 2).join(', ')} +${caps.length - 2}`;
}

const APPROVE_MESSAGE = "Approving requirements is a person's decision. Ask them to run it in their own terminal: specguard spec approve <refs>";

const MESSAGES = {
  noChange: (caps: string[], level: Level): string =>
    `${capList(caps)} is at ${level}: start a change before editing its code. Run: specguard change start ${caps[0] ?? '<capability>'} --why "<what>"`,
  notApproved: (id: string): string =>
    `Change ${id} has requirements nobody approved yet. Ask the person to approve them (or approve a plan); see: specguard change status ${id}`,
  beforeRed: (id: string): string => `Write a failing test first: tag it [claims: <cap>#<claim>], then run: specguard change red ${id}`,
  lockTests: (ids: string[]): string =>
    `Test edited after red: change ${ids[0]}${ids.length > 1 ? ` (+${ids.length - 1} more)` : ''} is back at "red"; rerun specguard change red ${ids[0]} before more code edits`,
  lockSpec: (id: string): string =>
    `Requirement edited after red: change ${id} must prove it again, and the person may need to re-approve. Run: specguard change red ${id}`,
  spike: (id: string): string => `Spike ${id} is code-first and cannot merge as is. When it is ready, the person converts it: specguard change convert ${id} --to feature`,
  policyFile: 'Policy file: CI and reviewers check changes to config, workflows and CODEOWNERS. Run: specguard check',
  recordEdit: 'Change records are managed by commands, not edited by hand. See: specguard change status',
  bashEnforce: (verb: string): string =>
    `Changing a capability's enforcement level is a person's decision. Ask them to run it in their own terminal: specguard enforce ${verb} <caps>`,
  bashChange: (verb: string): string =>
    `Closing or converting a change alters what CI accepts, so a person does it. Ask them to run it in their own terminal: specguard change ${verb} <id>`,
  bashProof: 'Publishing proof notes is CI\u2019s job or a person\u2019s. Ask them to run it in their own terminal: specguard proof publish',
  bashNotes: 'Proof notes are written by CI, not by hand. To read them, run: specguard proof fetch',
  bashHistory: "History entries come from commands, never from shell writes, and approvals are a person's decision. Use: specguard history add",
  errorOpen: (error: string): string => `SpecGuard hook could not decide (${shortError(error)}); edit allowed. CI still checks this change.`,
  errorClosed: (error: string): string =>
    `SpecGuard hook could not decide (${shortError(error)}) and hooks.onError is "deny", so this is blocked. Rebuild the index: specguard hook index`,
};

function shortError(error: string): string {
  const one = String(error ?? 'unknown error').replace(/\s+/g, ' ').trim();
  return one.length <= 80 ? one : `${one.slice(0, 79)}\u2026`;
}

function warnPrefix(text: string): string {
  return `SpecGuard (warn): ${text}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Verdicts. Each path (and the Bash command) gets one; the strictest wins.
// ---------------------------------------------------------------------------------------------------------------------

interface Verdict {
  decision: 'allow' | 'deny';
  code: HookCode;
  message?: string;
  caps: string[];
  level: Level | null;
  change?: string;
}

/** Higher is stricter. A deny beats any allow, an allow with advice beats a silent one. */
const RANK: Record<HookCode, number> = {
  DENY_APPROVAL_WRITE: 100, DENY_BASH_APPROVE: 100, DENY_BASH_NOTES: 100, ERROR_CLOSED: 96, DENY_RECORD_EDIT: 95,
  DENY_NO_CHANGE: 90, DENY_BEFORE_RED: 85, DENY_NOT_APPROVED: 80,
  WARN_NO_CHANGE: 60, WARN_BEFORE_RED: 58, LOCK_TESTS: 52, LOCK_SPEC: 52, ERROR_OPEN: 51, ALLOW_SPIKE: 50, NOTE_POLICY_FILE: 40,
  OBSERVED: 20, ALLOW_CHANGE: 15, ALLOW_REFACTOR: 14, FREE: 0, NOT_SPECGUARD: 0, OUTSIDE_REPO: 0,
};

function strictest(verdicts: Verdict[]): Verdict {
  let best = verdicts[0] ?? { decision: 'allow' as const, code: 'FREE' as const, caps: [], level: null };
  for (const v of verdicts) if (RANK[v.code] > RANK[best.code]) best = v;
  return best;
}

function levelOfCap(index: HookIndex, id: string): Level {
  const c = capabilitiesOf(index).find((x) => x?.id === id);
  return c && c.enforce in LEVEL_ORDER ? c.enforce : 'observe';
}

function strictestLevel(index: HookIndex, caps: string[]): Level | null {
  let best: Level | null = null;
  for (const id of caps) {
    const l = levelOfCap(index, id);
    if (best === null || LEVEL_ORDER[l] > LEVEL_ORDER[best]) best = l;
  }
  return best;
}

type Live = { redValid: Map<string, boolean> };

/** Red is valid when the entry says so live; the build-time flag is the fallback. */
function redValid(c: OpenChange, live: Live): boolean {
  const l = live?.redValid?.get(c.id);
  return l !== undefined ? l : c.red?.valid === true;
}

const FREE: Verdict = { decision: 'allow', code: 'FREE', caps: [], level: null };

function ownedVerdict(caps: string[], index: HookIndex, live: Live): Verdict {
  const level = strictestLevel(index, caps) ?? 'observe';
  const covering = openChangesOf(index).filter((c) => c && Array.isArray(c.capabilities) && caps.every((cap) => c.capabilities.includes(cap)));
  const base = { caps, level };

  // The best covering change decides: a change that allows the edit beats one that does not.
  let pick: { state: 'feature-ok' | 'refactor' | 'spike' | 'before-red' | 'not-approved'; change: OpenChange } | undefined;
  const order = { 'feature-ok': 5, refactor: 4, spike: 3, 'before-red': 2, 'not-approved': 1 } as const;
  for (const c of covering) {
    const state =
      c.kind === 'refactor' ? 'refactor'
      : c.kind === 'spike' ? 'spike'
      : !c.approvedAll ? 'not-approved'
      : redValid(c, live) ? 'feature-ok'
      : 'before-red';
    if (!pick || order[state] > order[pick.state]) pick = { state, change: c };
  }

  if (!pick) {
    if (level === 'observe') return { ...base, decision: 'allow', code: 'OBSERVED' };
    const text = MESSAGES.noChange(caps, level);
    return level === 'warn'
      ? { ...base, decision: 'allow', code: 'WARN_NO_CHANGE', message: clamp(warnPrefix(text)) }
      : { ...base, decision: 'deny', code: 'DENY_NO_CHANGE', message: clamp(text) };
  }
  const change = pick.change.id;
  switch (pick.state) {
    case 'feature-ok': return { ...base, decision: 'allow', code: 'ALLOW_CHANGE', change };
    case 'refactor': return { ...base, decision: 'allow', code: 'ALLOW_REFACTOR', change };
    case 'spike':
      return level === 'observe'
        ? { ...base, decision: 'allow', code: 'ALLOW_SPIKE', change }
        : { ...base, decision: 'allow', code: 'ALLOW_SPIKE', change, message: clamp(MESSAGES.spike(change)) };
    case 'before-red':
    case 'not-approved': {
      const notApproved = pick.state === 'not-approved';
      if (level === 'observe') return { ...base, decision: 'allow', code: 'OBSERVED', change };
      const text = notApproved ? MESSAGES.notApproved(change) : MESSAGES.beforeRed(change);
      if (level === 'warn') return { ...base, decision: 'allow', code: 'WARN_BEFORE_RED', change, message: clamp(warnPrefix(text)) };
      return { ...base, decision: 'deny', code: notApproved ? 'DENY_NOT_APPROVED' : 'DENY_BEFORE_RED', change, message: clamp(text) };
    }
  }
}

/** `kind: approval`, or a `method:` key together with `approves:`, in text a tool would write into a history file. */
export function looksLikeApproval(text: string | undefined): boolean {
  if (!text) return false;
  if (/(^|[\s{,])["']?kind["']?\s*:\s*["']?approval\b/m.test(text)) return true;
  return /(^|[\s{,])["']?method["']?\s*:/m.test(text) && /(^|[\s{,])["']?approves["']?\s*:/m.test(text);
}

/** An edit that would set `kind` or `closed` in a change record. */
function touchesRecordIntent(text: string | undefined): boolean {
  return !!text && /(^|[\s{,])["']?(kind|closed)["']?\s*:/m.test(text);
}

function pathVerdict(cls: PathClass, ev: HookEvent, index: HookIndex, live: Live): Verdict {
  switch (cls.kind) {
    case 'owned':
      return ownedVerdict(Array.isArray(cls.capabilities) ? cls.capabilities : [], index, live);
    case 'test': {
      const changes = openChangesOf(index).filter((c) => (cls.lockedBy ?? []).includes(c?.id) && redValid(c, live));
      if (changes.length === 0) return FREE;
      const caps = [...new Set(changes.flatMap((c) => c.capabilities ?? []))];
      return {
        decision: 'allow', code: 'LOCK_TESTS', message: clamp(MESSAGES.lockTests(changes.map((c) => c.id))),
        caps, level: strictestLevel(index, caps), change: changes[0]!.id,
      };
    }
    case 'spec': {
      if (!cls.capability) return FREE;
      const c = openChangesOf(index).find((x) => Array.isArray(x?.capabilities) && x.capabilities.includes(cls.capability!) && redValid(x, live));
      if (!c) return { ...FREE, caps: [cls.capability], level: levelOfCap(index, cls.capability) };
      return {
        decision: 'allow', code: 'LOCK_SPEC', message: clamp(MESSAGES.lockSpec(c.id)),
        caps: [cls.capability], level: levelOfCap(index, cls.capability), change: c.id,
      };
    }
    case 'history':
      if (cls.approvalLike || looksLikeApproval(ev.newText)) {
        return { decision: 'deny', code: 'DENY_APPROVAL_WRITE', message: clamp(APPROVE_MESSAGE), caps: [], level: null };
      }
      return FREE;
    case 'change-record':
      if (cls.closed || touchesRecordIntent(ev.newText)) {
        return { decision: 'deny', code: 'DENY_RECORD_EDIT', message: clamp(MESSAGES.recordEdit), caps: [], level: null };
      }
      return FREE;
    case 'specguard-config':
    case 'workflow':
      return { decision: 'allow', code: 'NOTE_POLICY_FILE', message: clamp(MESSAGES.policyFile), caps: [], level: null };
    default:
      return FREE;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Bash guard. A speed bump, not a gate: it reads the command the way a shell would split it (quotes, escapes, operators,
// here-documents, `bash -c`, `eval`, `$(...)`), and gives up quietly on anything it cannot read. CI is the gate.
// ---------------------------------------------------------------------------------------------------------------------

interface SimpleCommand {
  words: string[];
  /** Targets of output redirections (`>`, `>>`, `&>`, `>|`). */
  redirects: string[];
}

const MAX_COMMAND_CHARS = 20_000;
const MAX_DEPTH = 4;

/** Splits a command line into simple commands. Never throws; an unterminated quote runs to the end of the text. */
export function splitShell(source: string): SimpleCommand[] {
  const src = String(source ?? '').slice(0, MAX_COMMAND_CHARS);
  const n = src.length;
  const cmds: SimpleCommand[] = [];
  let cur: SimpleCommand = { words: [], redirects: [] };
  let buf = '';
  let inWord = false;
  let next: 'out' | 'in' | null = null;
  const heredocs: string[] = [];

  const pushWord = (): void => {
    if (!inWord) return;
    if (next === 'out') cur.redirects.push(buf);
    else if (next === null) cur.words.push(buf);
    next = null;
    buf = '';
    inWord = false;
  };
  const endCommand = (): void => {
    pushWord();
    next = null;
    if (cur.words.length > 0 || cur.redirects.length > 0) cmds.push(cur);
    cur = { words: [], redirects: [] };
  };

  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === '\\') {
      if (src[i + 1] === '\n') i += 2;
      else {
        if (i + 1 < n) buf += src[i + 1];
        inWord = true;
        i += 2;
      }
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      buf += src.slice(i + 1, end === -1 ? n : end);
      inWord = true;
      i = end === -1 ? n : end + 1;
    } else if (c === '"') {
      inWord = true;
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n && '"\\$`\n'.includes(src[i + 1]!)) {
          if (src[i + 1] !== '\n') buf += src[i + 1];
          i += 2;
        } else buf += src[i++];
      }
      i++;
    } else if (c === '$' && src[i + 1] === "'") {
      inWord = true;
      i += 2;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < n) {
          const m = /^\\(?:x([0-9a-fA-F]{1,2})|([0-7]{1,3})|(.))/s.exec(src.slice(i, i + 5));
          if (m) {
            buf += m[1] ? String.fromCharCode(parseInt(m[1], 16)) : m[2] ? String.fromCharCode(parseInt(m[2], 8)) : ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[m[3]!] ?? m[3];
            i += m[0].length;
            continue;
          }
        }
        buf += src[i++];
      }
      i++;
    } else if (c === '$' && src[i + 1] === '(') {
      endCommand();
      i += 2;
    } else if (c === '`' || c === '(' || c === ')' || c === ';' || c === '|') {
      endCommand();
      i++;
    } else if (c === '\n') {
      endCommand();
      i++;
      // A here-document body is data, not commands: skip to its terminator.
      while (heredocs.length > 0) {
        const delim = heredocs.shift()!;
        while (i < n) {
          const eol = src.indexOf('\n', i);
          const line = src.slice(i, eol === -1 ? n : eol);
          i = eol === -1 ? n : eol + 1;
          if (line.trim() === delim) break;
        }
      }
    } else if (c === ' ' || c === '\t' || c === '\r') {
      pushWord();
      i++;
    } else if (c === '#' && !inWord) {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '&') {
      if (src[i + 1] === '>') {
        pushWord();
        i += src[i + 2] === '>' ? 3 : 2;
        next = 'out';
      } else {
        endCommand();
        i++;
      }
    } else if (c === '>') {
      if (inWord && /^\d+$/.test(buf)) {
        buf = '';
        inWord = false;
      } else pushWord();
      i++;
      if (src[i] === '>' || src[i] === '|' || src[i] === '&') i++;
      next = 'out';
    } else if (c === '<') {
      if (inWord && /^\d+$/.test(buf)) {
        buf = '';
        inWord = false;
      } else pushWord();
      if (src[i + 1] === '<' && src[i + 2] === '<') {
        i += 3;
        next = 'in';
      } else if (src[i + 1] === '<') {
        i += 2;
        if (src[i] === '-') i++;
        while (src[i] === ' ' || src[i] === '\t') i++;
        let delim = '';
        while (i < n && !/[\s;&|<>()]/.test(src[i]!)) {
          if (src[i] !== "'" && src[i] !== '"' && src[i] !== '\\') delim += src[i];
          i++;
        }
        if (delim) heredocs.push(delim);
      } else {
        i++;
        next = 'in';
      }
    } else {
      buf += c;
      inWord = true;
      i++;
    }
  }
  endCommand();
  return cmds;
}

type BashFinding = { code: 'DENY_BASH_APPROVE' | 'DENY_BASH_NOTES' | 'DENY_APPROVAL_WRITE'; message: string };

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
/** Programs that run another program given as an argument. Only a command that starts with one is searched for a SpecGuard invocation. */
const WRAPPERS = new Set([
  'env', 'sudo', 'doas', 'command', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'timeout', 'gtimeout', 'xargs', 'setsid', 'builtin',
  'npx', 'pnpx', 'bunx', 'pnpm', 'yarn', 'npm', 'bun', 'dlx', 'node', 'nodejs', 'tsx', 'ts-node', 'deno',
]);

const baseName = (word: string): string => word.slice(word.lastIndexOf('/') + 1);

function isSpecguardEntry(word: string): boolean {
  const lower = word.toLowerCase();
  if (/^specguard(-ai)?(@[^/\s]*)?$/.test(baseName(lower))) return true;
  return /(^|\/)cli\/index\.(c|m)?[jt]s$/.test(lower);
}

function findInSpecguard(args: string[]): BashFinding | null {
  const plain = args.filter((a) => !a.startsWith('-'));
  for (let k = 0; k < plain.length - 1 && k <= 3; k++) {
    const [a, b] = [plain[k]!, plain[k + 1]!];
    if (a === 'spec' && b === 'approve') return { code: 'DENY_BASH_APPROVE', message: clamp(APPROVE_MESSAGE) };
    if (a === 'enforce' && (b === 'lower' || b === 'raise')) return { code: 'DENY_BASH_APPROVE', message: clamp(MESSAGES.bashEnforce(b)) };
    if (a === 'change' && (b === 'convert' || b === 'abandon')) return { code: 'DENY_BASH_APPROVE', message: clamp(MESSAGES.bashChange(b)) };
    if (a === 'change' && b === 'done' && args.some((x) => x === '--force' || x.startsWith('--force='))) {
      return { code: 'DENY_BASH_APPROVE', message: clamp(MESSAGES.bashChange('done --force --why <text>')) };
    }
    if (a === 'proof' && b === 'publish') return { code: 'DENY_BASH_APPROVE', message: clamp(MESSAGES.bashProof) };
  }
  return null;
}

function historyTarget(word: string, historyDir: string | undefined): boolean {
  const p = normalizePath(word);
  if (!historyDir || p === '') return false;
  const d = normalizePath(historyDir).replace(/\/$/, '');
  return p === d || p.startsWith(`${d}/`) || p.includes(`/${d}/`) || p.endsWith(`/${d}`);
}

function findInGit(args: string[]): BashFinding | null {
  const valued = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) i += valued.has(args[i]!) ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === 'notes' && rest.some((a) => /specguard/i.test(a))) return { code: 'DENY_BASH_NOTES', message: clamp(MESSAGES.bashNotes) };
  if ((sub === 'push' || sub === 'update-ref') && rest.some((a) => /refs\/notes/.test(a))) return { code: 'DENY_BASH_NOTES', message: clamp(MESSAGES.bashNotes) };
  return null;
}

function analyzeSimple(cmd: SimpleCommand, historyDir: string | undefined, depth: number): BashFinding | null {
  const historyWrite = (): BashFinding => ({ code: 'DENY_APPROVAL_WRITE', message: clamp(MESSAGES.bashHistory) });
  if (cmd.redirects.some((t) => historyTarget(t, historyDir))) return historyWrite();

  let start = 0;
  while (start < cmd.words.length && ASSIGNMENT.test(cmd.words[start]!)) start++;
  const words = cmd.words.slice(start);
  if (words.length === 0) return null;

  // Substitutions that survived inside quotes still run.
  if (depth < MAX_DEPTH) {
    for (const w of words) {
      if (!w.includes('$(') && !w.includes('`')) continue;
      for (const m of w.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
        const found = analyzeText(m[1] ?? m[2] ?? '', historyDir, depth + 1);
        if (found) return found;
      }
    }
  }

  const head = baseName(words[0]!).toLowerCase();
  const args = words.slice(1);

  if (isSpecguardEntry(words[0]!)) return findInSpecguard(args);
  if (head === 'git') return findInGit(args);
  if (SHELLS.has(head) && depth < MAX_DEPTH) {
    const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (c !== -1 && args[c + 1] !== undefined) return analyzeText(args[c + 1]!, historyDir, depth + 1);
  }
  if (head === 'eval' && depth < MAX_DEPTH) return analyzeText(args.join(' '), historyDir, depth + 1);

  const plain = args.filter((a) => !a.startsWith('-'));
  if (head === 'tee' && plain.some((a) => historyTarget(a, historyDir))) return historyWrite();
  if (['cp', 'mv', 'install', 'rsync', 'ln'].includes(head)) {
    const t = args.findIndex((a) => a === '-t' || a === '--target-directory');
    const dests = [plain[plain.length - 1], t !== -1 ? args[t + 1] : undefined, ...args.filter((a) => a.startsWith('--target-directory=')).map((a) => a.slice(19))];
    if (dests.some((d) => d !== undefined && historyTarget(d, historyDir))) return historyWrite();
  }
  if (head === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')) && plain.some((a) => historyTarget(a, historyDir))) return historyWrite();
  if (head === 'dd' && args.some((a) => a.startsWith('of=') && historyTarget(a.slice(3), historyDir))) return historyWrite();

  if (WRAPPERS.has(head) && depth < MAX_DEPTH) {
    for (let j = 1; j < Math.min(words.length, 12); j++) {
      const found = analyzeSimple({ words: words.slice(j), redirects: [] }, historyDir, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function analyzeText(text: string, historyDir: string | undefined, depth: number): BashFinding | null {
  for (const cmd of splitShell(text)) {
    const found = analyzeSimple(cmd, historyDir, depth);
    if (found) return found;
  }
  return null;
}

/** The first thing in a shell command line the agent may not run, or null. Exported for the hook's PostToolUse and for tests. */
export function guardBash(command: string, historyDir?: string): BashFinding | null {
  try {
    return analyzeText(command, historyDir, 0);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------------------------------------------------

function toDecision(v: Verdict, ev: HookEvent): HookDecision {
  const log: HookLogEntry = {
    ts: '',
    ...(ev.agent ? { agent: ev.agent } : {}),
    tool: ev.tool ?? '',
    paths: Array.isArray(ev.paths) ? ev.paths : [],
    caps: v.caps,
    level: v.level,
    decision: v.decision,
    code: v.code,
    ...(v.change ? { change: v.change } : {}),
  };
  return { decision: v.decision, ...(v.message ? { message: v.message } : {}), log };
}

/** Codex has no `ask`: it becomes a deny with the same message. */
export function forAgent(d: HookDecision, agent: HookEvent['agent'] | undefined): HookDecision {
  if (agent !== 'codex' || d.decision !== 'ask') return d;
  return { ...d, decision: 'deny', log: { ...d.log, decision: 'deny' } };
}

/** The entry stamps the clock and the session; this module has neither. */
export function withLogContext(d: HookDecision, ctx: { ts: string; session?: string }): HookDecision {
  return { ...d, log: { ...d.log, ts: ctx.ts, ...(ctx.session ? { session: ctx.session } : {}) } };
}

/**
 * The decisions the entry makes before or instead of the table: nothing to guard (`OUTSIDE_REPO`, `NOT_SPECGUARD`) and
 * errors (`ERROR_OPEN` allows with a notice, `ERROR_CLOSED` denies). `error` is the short cause.
 */
export function systemDecision(code: 'OUTSIDE_REPO' | 'NOT_SPECGUARD' | 'ERROR_OPEN' | 'ERROR_CLOSED', ev: HookEvent, error?: string): HookDecision {
  const verdict: Verdict =
    code === 'ERROR_OPEN' ? { decision: 'allow', code, message: clamp(MESSAGES.errorOpen(error ?? '')), caps: [], level: null }
    : code === 'ERROR_CLOSED' ? { decision: 'deny', code, message: clamp(MESSAGES.errorClosed(error ?? '')), caps: [], level: null }
    : { decision: 'allow', code, caps: [], level: null };
  return forAgent(toDecision(verdict, ev), ev?.agent);
}

/** With several paths each is decided and the strictest wins. `live.redValid` is change id -> red still valid, checked by the entry at call time. */
export function decide(ev: HookEvent, classes: PathClass[], index: HookIndex, live: { redValid: Map<string, boolean> }): HookDecision {
  if (ev?.event === 'PostToolUse') return forAgent(toDecision(FREE, ev), ev.agent);

  const verdicts: Verdict[] = [];
  for (const cls of Array.isArray(classes) ? classes : []) verdicts.push(pathVerdict(cls, ev, index, live));

  if (typeof ev?.bash === 'string' && ev.bash.length > 0) {
    const found = guardBash(ev.bash, index?.historyDir);
    if (found) verdicts.push({ decision: 'deny', code: found.code, message: found.message, caps: [], level: null });
  }

  const best = strictest(verdicts);
  // The log names every capability the edit touched and the strictest level among them, whichever verdict won.
  const caps = [...new Set(verdicts.flatMap((v) => v.caps))];
  const level = verdicts.reduce<Level | null>((acc, v) => (v.level !== null && (acc === null || LEVEL_ORDER[v.level] > LEVEL_ORDER[acc]) ? v.level : acc), null);
  return forAgent(toDecision({ ...best, caps, level }, ev ?? ({} as HookEvent)), ev?.agent);
}
