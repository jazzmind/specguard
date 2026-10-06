import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Advisory, Candidate } from '../advisory.js';
import { rankFixes } from './semver.js';

export function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hasFile(repo: string, name: string): boolean {
  return existsSync(path.join(repo, name));
}

export function readText(repo: string, name: string): string | null {
  try {
    return readFileSync(path.join(repo, name), 'utf8');
  } catch {
    return null;
  }
}

export function writeText(repo: string, name: string, text: string): void {
  writeFileSync(path.join(repo, name), text);
}

/** Hash of the named files that exist, in a stable order. */
export function fingerprintFiles(repo: string, names: string[]): string {
  const parts = [...names]
    .sort()
    .filter((n) => hasFile(repo, n))
    .map((n) => `${n}:${sha(readFileSync(path.join(repo, n)))}`);
  return sha(parts.join('\n'));
}

/** Parse JSON and remember its indentation and trailing newline so the rewrite is a minimal diff. */
export function readJsonKeepFormat(repo: string, name: string): { data: Record<string, unknown>; indent: string | number; eol: string } | null {
  const text = readText(repo, name);
  if (text === null) return null;
  const indent = /^(\s+)"/m.exec(text)?.[1] ?? 2;
  return { data: JSON.parse(text) as Record<string, unknown>, indent, eol: text.endsWith('\n') ? '\n' : '' };
}

export function writeJsonKeepFormat(repo: string, name: string, f: { data: unknown; indent: string | number; eol: string }): void {
  writeText(repo, name, JSON.stringify(f.data, null, f.indent) + f.eol);
}

/** Candidates for an advisory: every fixing version above the installed one, smallest bump first. */
export function candidatesFor(adv: Advisory): Candidate[] {
  return rankFixes(adv.installedVersion, adv.fixedVersions).map((f) => ({
    advisoryIds: [adv.id, ...adv.aliases],
    ecosystem: adv.ecosystem,
    package: adv.package,
    fromVersion: adv.installedVersion,
    toVersion: f.version,
    bump: f.bump,
    mode: adv.direct ? 'direct' : 'override',
  }));
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
