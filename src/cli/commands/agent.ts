/**
 * `specguard agent pending|answer` — the host coding agent's side of `llm.provider: "host"`.
 *
 * `pending` lists the model requests waiting for an answer; `answer` records one. Thin wrappers over
 * `src/core/agent-work.ts`. Spec: specs/capabilities/platform-foundation.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { answerAgentRequest, listAgentRequests, parseAnswerText, readAgentRequest, resolveRequestHash } from '../../core/agent-work.js';
import { ExitCode } from '../../core/exit-codes.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

function replayDirOf(config: Awaited<ReturnType<typeof loadCliConfig>>): string {
  const root = config.rootDir ?? process.cwd();
  const dir = config.llm.replay?.dir ?? path.join('.specguard', 'replay');
  return path.isAbsolute(dir) ? dir : path.resolve(root, dir);
}

export async function agentPendingCommand(opts: GlobalOpts & { full?: boolean }): Promise<void> {
  const config = await loadCliConfig(opts);
  const root = config.rootDir ?? process.cwd();
  const requests = listAgentRequests(root);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(opts.full ? requests : requests.map(({ hash, kind, pipeline, answerFile, rejection, createdAt }) => ({ hash, kind, pipeline, answerFile, rejection, createdAt, file: `.specguard/agent-requests/${hash}.json` })))}\n`);
    process.exit(ExitCode.Success);
  }
  if (requests.length === 0) {
    process.stdout.write('No model requests are waiting for the host agent.\n');
    process.exit(ExitCode.Success);
  }
  for (const r of requests) {
    process.stdout.write(`${r.hash}  ${r.pipeline}  ${r.kind}${r.rejection ? '  (previous answer refused)' : ''}\n  request: .specguard/agent-requests/${r.hash}.json\n`);
  }
  process.stdout.write(`\n${requests.length} waiting. Answer each with: specguard agent answer <hash> --file <answer>\n`);
  process.exit(ExitCode.AgentWorkPending);
}

export async function agentAnswerCommand(hashOrPrefix: string, opts: GlobalOpts & { file?: string; stdin?: boolean }): Promise<void> {
  const config = await loadCliConfig(opts);
  const root = config.rootDir ?? process.cwd();
  const hash = resolveRequestHash(root, hashOrPrefix);
  const req = hash ? readAgentRequest(root, hash) : null;
  if (!hash || !req) {
    process.stderr.write(`No single pending request matches "${hashOrPrefix}". List them with \`specguard agent pending\`.\n`);
    process.exit(ExitCode.InternalError);
  }
  if (!opts.file && !opts.stdin) {
    process.stderr.write('Give the answer with --file <path> or --stdin.\n');
    process.exit(ExitCode.InternalError);
  }
  const text = opts.file ? readFileSync(path.resolve(opts.file), 'utf8') : readFileSync(0, 'utf8');
  let answer: unknown;
  try {
    answer = req.kind === 'object' ? parseAnswerText(text) : text.replace(/\n$/, '');
  } catch (err) {
    process.stderr.write(`The answer is not valid JSON: ${(err as Error).message}\n`);
    process.exit(ExitCode.InternalError);
  }
  try {
    answerAgentRequest(root, replayDirOf(config), hash, answer);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(ExitCode.InternalError);
  }
  process.stdout.write(`Recorded the answer to ${hash.slice(0, 12)} (${req.pipeline}). Rerun the command that asked.\n`);
  process.exit(ExitCode.Success);
}
