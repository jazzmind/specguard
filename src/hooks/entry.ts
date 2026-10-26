/**
 * The agent edit guard's hot path. A coding agent runs it before every edit or shell command: it reads the tool call
 * from stdin, finds the SpecGuard project, loads the ownership index (rebuilding it in process when a spec, the config
 * or a change record moved), asks the decision table, and prints the host's JSON answer. No model, no network.
 *
 * A repository whose specs live in an overlay repo (see `src/core/overlay.ts`) is judged too: the project root is the real
 * repository, the config, change records, index cache and decision log are the overlay app's.
 *
 * It fails open. A project without `.specguard/config.json` (and no overlay covering it) gets silence; an error, an unreadable index or an unreadable
 * payload allows the edit with a visible notice, unless the config says `hooks.onError: "deny"`, which fails closed in a
 * project with an `enforce` capability. CI stays the gate either way.
 *
 * The same code runs as the committed single-file bundle (`plugins/specguard/hooks/dist/specguard-hook.mjs`, built from
 * `src/hooks/main.ts`) and as `specguard hook pre-tool-use`. Keep its static imports light: the bundle's start-up is
 * the hook's latency, and everything heavy loads on demand in `index-build.ts`.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */
import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

import { classify, decide, systemDecision, withLogContext, type HookDecision, type HookEvent, type HookLogEntry, type PathClass } from './decide.js';
import { CONFIG_FILE, liveRedValidity, loadHookIndex, readHookIndexCache, readLiteConfig, repoView, type CachedHookIndex } from './index-build.js';
import { entriesOfConfig, matchOverlayEntries, resolveConfigDirDetailed, type ConfigResolution } from '../core/overlay.js';
import { parseHookInput, type ParsedHookInput } from './stdin.js';

export type HookAgent = 'claude' | 'codex';

/** Where decisions are logged (gitignored with the rest of `.specguard/cache/`), and when the log rolls over. */
export const HOOK_LOG_FILE = '.specguard/cache/hooks.jsonl';
export const HOOK_LOG_ROTATED_FILE = '.specguard/cache/hooks.1.jsonl';
export const HOOK_LOG_MAX_BYTES = 1_000_000;

export interface HookRun {
  /** What the host reads: one JSON line, or nothing for a silent allow. */
  stdout: string;
  stderr: string;
  /** Always 0: a decision is carried by the JSON, and a hook that crashes must not block the agent. */
  exitCode: number;
  /** Absent when the call was not ours to judge (no SpecGuard project, nothing it would write). */
  decision?: HookDecision;
}

export interface EntryOptions {
  /** Which host sent the payload; inferred from it (Codex sends `turn_id`) when absent. */
  agent?: HookAgent;
  /** Where to look for the project when the payload has no `cwd`. Default: the process's directory. */
  cwd?: string;
  now?: () => Date;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pieces shared with `specguard hook doctor`
// ---------------------------------------------------------------------------------------------------------------------

const matchers = new Map<string, (p: string) => boolean>();

/** picomatch with dotfiles on, one compiled matcher per glob for the life of the process. */
export function matchGlob(glob: string, p: string): boolean {
  let m = matchers.get(glob);
  if (!m) {
    m = picomatch(glob, { dot: true });
    matchers.set(glob, m);
  }
  return m(p);
}

/**
 * The project root for a directory: the nearest ancestor with `.specguard/config.json`, not looking past a git
 * boundary (a nested repository that has no config is not part of the outer project). Lexical, so paths the agent sends
 * (in the same form as its `cwd`) stay comparable. Null when there is none.
 */
export function findProjectRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir;
    if (existsSync(path.join(dir, '.git'))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Where a tool call happens and where SpecGuard's own files are: the same folder, or (overlay mode) two. */
export interface HookProject {
  /** The repository the agent works in. Paths in the payload are made relative to it. */
  root: string;
  /** The folder holding `.specguard/` (config, change records, index cache, decision log): `root`, or the overlay app's folder. */
  stateRoot: string;
  /** Set in overlay mode: how the config was found. */
  overlay?: ConfigResolution;
}

/**
 * The project for a directory. The repository's own config first (exactly {@link findProjectRoot}); failing that a light
 * lookup through `SPECGUARD_CONFIG`, `SPECGUARD_OVERLAY` and the per-user overlay registry (node built-ins only: this is
 * the hot path). Fails open: an ambiguous or broken overlay setup is "not a project", never an error.
 */
export function findProject(start: string, env: NodeJS.ProcessEnv = process.env): HookProject | null {
  const own = findProjectRoot(start);
  if (own) return { root: own, stateRoot: own };
  try {
    const detail = resolveConfigDirDetailed(start, env);
    const r = detail.resolved;
    if (!r || r.via === 'repo') return null;
    if (r.via === 'env-config') {
      // One config for every directory: the guarded repository is whichever of its apps contains the start directory.
      const m = matchOverlayEntries(start, entriesOfConfig(path.join(r.dir, CONFIG_FILE)).entries);
      return m ? { root: m.dir, stateRoot: r.dir, overlay: { ...r, repo: m.hits[0]!.repo, app: m.hits[0]!.app } } : null;
    }
    return detail.repoDir && r.repo ? { root: detail.repoDir, stateRoot: r.dir, overlay: r } : null;
  } catch {
    return null;
  }
}

/** Whether the history entry already on disk is an approval (its frontmatter says `kind: approval`). Unreadable means no. */
function approvalOnDisk(root: string, rel: string): boolean {
  try {
    return /^kind:\s*["']?approval["']?\s*$/m.test(readFileSync(path.join(root, rel), 'utf8').slice(0, 4096));
  } catch {
    return false;
  }
}

export function decideForEvent(event: HookEvent, root: string, index: CachedHookIndex, stateRoot: string = root): { classes: PathClass[]; decision: HookDecision } {
  const view = repoView(index, stateRoot);
  const classes = event.paths.map((p): PathClass => {
    const cls = classify(p, view, matchGlob);
    // An edit is judged on its new text alone, so changing the hashes inside an approval already on disk would pass:
    // any change to an existing approval is treated as writing one.
    return cls.kind === 'history' && !cls.approvalLike && approvalOnDisk(root, p) ? { ...cls, approvalLike: true } : cls;
  });
  // The red evidence lives with the change records, in the folder that holds `.specguard/`.
  return { classes, decision: decide(event, classes, view, { redValid: liveRedValidity(stateRoot, index) }) };
}

/** The host's JSON for a decision. Empty for an allow with nothing to say. */
export function renderPreToolUse(d: HookDecision): string {
  // An allow prints no `permissionDecision`: "allow" would also skip the permission prompt the user would otherwise
  // see, and a guard that only advises must not grant anything. A warning rides in `additionalContext`.
  const out =
    d.decision === 'allow'
      ? d.message
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: d.message } }
        : undefined
      : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.message ?? '' } };
  return out ? `${JSON.stringify(out)}\n` : '';
}

/** One line per decision, newest last. Rolls over to `hooks.1.jsonl` past 1 MB. Never throws: a log must not block an edit. */
export function appendHookLog(root: string, entry: HookLogEntry): void {
  try {
    const file = path.join(root, HOOK_LOG_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (statSync(file).size > HOOK_LOG_MAX_BYTES) renameSync(file, path.join(root, HOOK_LOG_ROTATED_FILE));
    } catch {
      /* no log yet */
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    /* read-only checkout: the decision still stands */
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The hot path
// ---------------------------------------------------------------------------------------------------------------------

const silent = (): HookRun => ({ stdout: '', stderr: '', exitCode: 0 });

function probeCwd(raw: string): string | undefined {
  try {
    const data: unknown = JSON.parse(raw);
    const cwd = typeof data === 'object' && data !== null ? (data as { cwd?: unknown }).cwd : undefined;
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the deepest existing ancestor through symlinks (`/tmp` -> `/private/tmp`), then re-append the rest. */
function realPathLoose(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Paths that look outside the root only because of a symlinked prefix are really inside it: move them over. */
function reanchor(parsed: ParsedHookInput, root: string): void {
  if (parsed.outside.length === 0) return;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return;
  }
  const still: string[] = [];
  for (const p of parsed.outside) {
    const rel = path.relative(realRoot, realPathLoose(path.resolve(parsed.cwd ?? root, p)));
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      still.push(p);
      continue;
    }
    const posix = rel.split(path.sep).join('/');
    if (!parsed.event.paths.includes(posix)) parsed.event.paths.push(posix);
  }
  parsed.outside = still;
}

function failure(err: unknown, root: string, event: HookEvent, repoRoot?: string): HookDecision {
  const short = err instanceof Error ? err.message : String(err);
  // What to do with an error comes from the last good index when there is one, else the raw config.
  const stale = readHookIndexCache(root, repoRoot);
  const onError = stale?.onError ?? readLiteConfig(root)?.onError ?? 'allow';
  const nothingToEnforce = stale !== null && !stale.capabilities.some((c) => c.enforce === 'enforce');
  return systemDecision(onError === 'deny' && !nothingToEnforce ? 'ERROR_CLOSED' : 'ERROR_OPEN', event, short);
}

function finish(root: string, decision: HookDecision, ctx: { ts: string; session?: string }): HookRun {
  const d = withLogContext(decision, ctx);
  appendHookLog(root, d.log);
  return { stdout: renderPreToolUse(d), stderr: '', exitCode: 0, decision: d };
}

/** One PreToolUse call: the host's payload in, the host's answer out. Never throws. */
export async function runPreToolUse(raw: string, opts: EntryOptions = {}): Promise<HookRun> {
  // `logRoot` is where `.specguard/` is (the decision log, the cache); `root` is the repository the paths belong to.
  let logRoot: string | null = null;
  let repoRoot: string | undefined;
  let event: HookEvent = { event: 'PreToolUse', tool: '', paths: [], agent: opts.agent ?? 'claude' };
  try {
    const now = opts.now ?? ((): Date => new Date());
    const project = findProject(probeCwd(raw) ?? opts.cwd ?? process.cwd());
    // Not a SpecGuard project: nothing to say, and nothing is read.
    if (!project) return silent();
    const { root, stateRoot } = project;
    logRoot = stateRoot;
    repoRoot = project.overlay ? project.overlay.repo : undefined;

    const parsed = parseHookInput(raw, { ...(opts.agent ? { agent: opts.agent } : {}), root });
    event = parsed.event;
    const ctx = { ts: now().toISOString(), ...(parsed.session ? { session: parsed.session } : {}) };

    // A payload we cannot read is always an allow, with a notice: the hook never breaks a session over its input.
    if (parsed.noop === 'malformed-json' || parsed.noop === 'not-an-object') {
      return finish(stateRoot, systemDecision('ERROR_OPEN', event, 'unreadable hook input'), ctx);
    }
    reanchor(parsed, root);
    if (parsed.event.paths.length === 0 && parsed.event.bash === undefined) return silent();

    const { index } = await loadHookIndex(stateRoot, repoRoot ? { repoRoot } : {});
    return finish(stateRoot, decideForEvent(parsed.event, root, index, stateRoot).decision, ctx);
  } catch (err) {
    if (!logRoot) return silent();
    try {
      return finish(logRoot, failure(err, logRoot, event, repoRoot), { ts: new Date().toISOString() });
    } catch {
      return silent();
    }
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > 6_000_000) break;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Bundle and CLI entry: `<pre-tool-use|pre-tool> [--agent claude|codex]`, payload on stdin. Events the guard does not
 * judge (post-tool, session-start) are accepted and ignored, so a host config can name them without a failure.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const sub = argv[0];
  const flag = argv.indexOf('--agent');
  const agent = flag !== -1 && (argv[flag + 1] === 'codex' || argv[flag + 1] === 'claude') ? (argv[flag + 1] as HookAgent) : undefined;
  if (sub !== 'pre-tool-use' && sub !== 'pre-tool') {
    if (sub !== 'post-tool-use' && sub !== 'post-tool' && sub !== 'session-start') process.stderr.write(`specguard hook: unknown event "${sub ?? ''}"; nothing to do\n`);
    return 0;
  }
  const run = await runPreToolUse(await readStdin(), agent ? { agent } : {});
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  return run.exitCode;
}
