/**
 * Replay store: recorded LLM responses keyed by a hash of the request, so CI and
 * tests run deterministically and offline.
 *
 * Spec: specs/core/llm.md
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type ReplayKind = 'text' | 'object';

export interface ReplayRecord {
  kind: ReplayKind;
  hash: string;
  /** Short preview of the prompt, for humans reading the recording. */
  promptPreview: string;
  provider: string;
  model: string;
  recordedAt: string;
  response: unknown;
}

/** Hash of everything that determines the answer: kind, system text, prompt, image bytes. */
export function replayKey(kind: ReplayKind, system: string | undefined, prompt: string, images?: Buffer[]): string {
  const h = createHash('sha256');
  h.update(kind);
  h.update('\0');
  h.update(system ?? '');
  h.update('\0');
  h.update(prompt);
  for (const image of images ?? []) {
    h.update('\0');
    h.update(createHash('sha256').update(image).digest('hex'));
  }
  return h.digest('hex');
}

export function replayFile(dir: string, hash: string): string {
  return path.join(dir, `${hash}.json`);
}

export function loadReplay(dir: string, hash: string): ReplayRecord | null {
  const file = replayFile(dir, hash);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ReplayRecord;
  } catch {
    return null;
  }
}

export function saveReplay(dir: string, record: ReplayRecord): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(replayFile(dir, record.hash), `${JSON.stringify(record, null, 2)}\n`);
}

export function previewOf(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}
