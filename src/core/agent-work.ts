/**
 * Agent work: model output supplied by the host coding agent instead of an API key.
 *
 * With `llm.provider: "host"` (or `"auto"` resolving to it inside an agent), a call
 * that has no recorded answer writes a request file and the run reports
 * `AgentWorkPending`. The agent answers by writing the replay record for the
 * request's hash, then reruns the command, which validates the answer with the
 * pipeline's own schema. SpecGuard's proofs never depend on this output: it only
 * supplies drafts and advice (spec text, test-to-claim links), which a person
 * reviews and which the deterministic checks then verify.
 *
 * Kept free of the AI SDK so loading it costs nothing.
 *
 * Spec: specs/capabilities/platform-foundation.md
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { SpecGuardError } from './errors.js';
import { ExitCode } from './exit-codes.js';
import { loadReplay, previewOf, replayFile, saveReplay, type ReplayKind } from './llm-replay.js';

/** A model call waiting for the host agent. The `.specguard/agent-requests/<hash>.json` file. */
export interface AgentRequest {
  version: 1;
  hash: string;
  kind: ReplayKind;
  /** The pipeline that asked (for example `summarize`, `cluster`, `spec-draft`, `tag`). */
  pipeline: string;
  system?: string;
  /** The prompt, after credential masking. */
  prompt: string;
  /** JSON Schema the answer must satisfy; present for `object` requests. */
  jsonSchema?: unknown;
  createdAt: string;
  /** Where the answer goes, relative to the project root. */
  answerFile: string;
  /** Why the previous answer was refused, when it was. */
  rejection?: string;
  instructions: string;
}

export const AGENT_REQUESTS_DIR = path.join('.specguard', 'agent-requests');

/** A short, stable line naming a pending request, for logs and the exit message. */
export interface PendingRef {
  hash: string;
  pipeline: string;
  kind: ReplayKind;
  file: string;
  rejection?: string;
}

/** Thrown when a call needs the host agent. The CLI exits with `ExitCode.AgentWorkPending`. */
export class AgentWorkPendingError extends SpecGuardError {
  constructor(public readonly pending: PendingRef[]) {
    super(
      `Agent work pending: ${pending.length} model request(s) wait for the host agent (see ${AGENT_REQUESTS_DIR}).`,
      ExitCode.AgentWorkPending,
    );
    this.name = 'AgentWorkPendingError';
  }
}

// ---------------------------------------------------------------------------
// Detecting an agent
// ---------------------------------------------------------------------------

/**
 * Whether this process runs inside a coding agent, so the agent can do the model work.
 * `SPECGUARD_HOST_AGENT=1` forces it on and `=0` off. Claude Code is recognised on its own (it sets
 * `CLAUDECODE=1` for the commands it runs) and so is Codex (`CODEX_THREAD_ID` is set for the commands it runs). Other
 * agents have no documented marker, so the Cursor plugin config and skills set `SPECGUARD_HOST_AGENT=1` themselves.
 */
export function detectHostAgent(env: NodeJS.ProcessEnv = process.env): boolean {
  const forced = env.SPECGUARD_HOST_AGENT;
  if (forced === '1' || forced === 'true') return true;
  if (forced === '0' || forced === 'false') return false;
  return Boolean(env.CLAUDECODE || env.CODEX_THREAD_ID);
}

// ---------------------------------------------------------------------------
// Requests and answers
// ---------------------------------------------------------------------------

export function agentRequestsDir(rootDir: string): string {
  return path.join(rootDir, AGENT_REQUESTS_DIR);
}

const requestFile = (rootDir: string, hash: string): string => path.join(agentRequestsDir(rootDir), `${hash}.json`);

const HASH = /^[a-f0-9]{64}$/;

/** Write (or refresh) the request file for a call and return its reference. */
export function writeAgentRequest(rootDir: string, replayDir: string, req: Omit<AgentRequest, 'version' | 'createdAt' | 'answerFile' | 'instructions'>): PendingRef {
  const answerFile = path.relative(rootDir, replayFile(replayDir, req.hash)).split(path.sep).join('/');
  const full: AgentRequest = {
    version: 1,
    ...req,
    createdAt: new Date().toISOString(),
    answerFile,
    instructions:
      req.kind === 'object'
        ? 'Produce a JSON value that satisfies jsonSchema, following system and prompt. Submit it with `specguard agent answer <hash> --file <answer.json>` (or the specguard_agent_work tool), then rerun the command that asked.'
        : 'Produce the text the prompt asks for, following system. Submit it with `specguard agent answer <hash> --file <answer.txt>` (or the specguard_agent_work tool), then rerun the command that asked.',
  };
  mkdirSync(agentRequestsDir(rootDir), { recursive: true, mode: 0o700 });
  writeFileSync(requestFile(rootDir, req.hash), `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
  return { hash: req.hash, pipeline: req.pipeline, kind: req.kind, file: path.relative(rootDir, requestFile(rootDir, req.hash)).split(path.sep).join('/'), ...(req.rejection ? { rejection: req.rejection } : {}) };
}

/** The reference to a request that is already on disk. */
export function refOfRequest(rootDir: string, req: AgentRequest): PendingRef {
  return {
    hash: req.hash,
    pipeline: req.pipeline,
    kind: req.kind,
    file: path.relative(rootDir, requestFile(rootDir, req.hash)).split(path.sep).join('/'),
    ...(req.rejection ? { rejection: req.rejection } : {}),
  };
}

export function readAgentRequest(rootDir: string, hash: string): AgentRequest | null {
  if (!HASH.test(hash)) return null;
  try {
    return JSON.parse(readFileSync(requestFile(rootDir, hash), 'utf8')) as AgentRequest;
  } catch {
    return null;
  }
}

/** Every request still waiting for an answer, oldest first. */
export function listAgentRequests(rootDir: string): AgentRequest[] {
  const dir = agentRequestsDir(rootDir);
  if (!existsSync(dir)) return [];
  const out: AgentRequest[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const req = readAgentRequest(rootDir, name.slice(0, -'.json'.length));
    if (req) out.push(req);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The one pending request a hash or unique prefix (8+ characters) names, or null when none or several match. */
export function resolveRequestHash(rootDir: string, prefix: string): string | null {
  if (HASH.test(prefix)) return prefix;
  if (!/^[a-f0-9]{8,63}$/.test(prefix)) return null;
  const hits = listAgentRequests(rootDir).filter((r) => r.hash.startsWith(prefix));
  return hits.length === 1 ? hits[0].hash : null;
}

/** Parse an agent's JSON answer, tolerating a surrounding markdown code fence. */
export function parseAnswerText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (first) {
    const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed);
    if (fenced) return JSON.parse(fenced[1]);
    throw first;
  }
}

export function removeAgentRequest(rootDir: string, hash: string): void {
  if (HASH.test(hash)) rmSync(requestFile(rootDir, hash), { force: true });
}

/**
 * Record the host agent's answer to a request, in the replay store where the rerun finds it.
 * Only the shape is checked here (an object for an `object` request); the schema check happens
 * when the pipeline reads the answer, with the pipeline's own zod schema.
 * @throws {SpecGuardError} for an unknown request or a malformed answer.
 */
export function answerAgentRequest(rootDir: string, replayDir: string, hash: string, answer: unknown): void {
  const req = readAgentRequest(rootDir, hash);
  if (!req) throw new SpecGuardError(`No pending agent request ${hash.slice(0, 16)}. List them with \`specguard agent pending\`.`, ExitCode.InternalError);
  if (req.kind === 'object' && (typeof answer !== 'object' || answer === null)) {
    throw new SpecGuardError('This request needs a JSON object (or array) that satisfies its jsonSchema.', ExitCode.InternalError);
  }
  if (req.kind === 'text' && typeof answer !== 'string') {
    throw new SpecGuardError('This request needs plain text.', ExitCode.InternalError);
  }
  saveReplay(replayDir, {
    kind: req.kind,
    hash: req.hash,
    promptPreview: previewOf(req.prompt),
    provider: 'host',
    model: 'host-agent',
    recordedAt: new Date().toISOString(),
    response: answer,
  });
}

/** The recorded answer to a request, or null when the agent has not answered yet. */
export function recordedAnswer(replayDir: string, hash: string): unknown | null {
  const rec = loadReplay(replayDir, hash);
  return rec ? rec.response : null;
}

/** Set an unusable answer aside and mark the request, so the agent answers it again. */
export function rejectAnswer(rootDir: string, replayDir: string, hash: string, reason: string): void {
  const file = replayFile(replayDir, hash);
  if (existsSync(file)) {
    const aside = path.join(replayDir, 'rejected');
    mkdirSync(aside, { recursive: true });
    renameSync(file, path.join(aside, `${hash}.json`));
  }
  const req = readAgentRequest(rootDir, hash);
  if (req) writeFileSync(requestFile(rootDir, hash), `${JSON.stringify({ ...req, rejection: reason.slice(0, 1500) }, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// What this process is waiting for
// ---------------------------------------------------------------------------

const pending = new Map<string, PendingRef>();

export function notePending(ref: PendingRef): void {
  pending.set(ref.hash, ref);
}

/** The requests this process asked for and has no answer to. */
export function pendingThisRun(): PendingRef[] {
  return [...pending.values()];
}

export function resetPending(): void {
  pending.clear();
}

/** The message the CLI prints when it exits waiting for the agent. */
export function pendingMessage(refs: PendingRef[]): string {
  const lines = [
    `Agent work pending: ${refs.length} model request(s) need an answer from the host agent.`,
    ...refs.slice(0, 20).map((r) => `  - ${r.pipeline} (${r.kind}) ${r.hash.slice(0, 12)}  ${r.file}${r.rejection ? `  [previous answer refused: ${r.rejection.slice(0, 120)}]` : ''}`),
    ...(refs.length > 20 ? [`  ... and ${refs.length - 20} more`] : []),
    'Read each request file, write the answer (JSON for `object` requests, text for `text`), submit it with',
    '  specguard agent answer <hash> --file <answer>',
    'then rerun the same command. Exit code 12 means "waiting for the agent", not a failure.',
  ];
  return lines.join('\n');
}
