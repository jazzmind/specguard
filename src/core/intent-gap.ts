/**
 * Intent gaps: capabilities whose code changed with neither a requirement
 * history entry nor a spec edit since. Code changing without any recorded
 * intent is the gap requirement history exists to close.
 *
 * Informational, never a failure. Skipped entirely until the repo has at least
 * one history entry, and outside git repositories.
 *
 * Spec: specs/capabilities/requirement-history.md
 */
import { execFileSync } from 'node:child_process';

import type { HistoryEntry } from './history.js';
import type { TraceNode } from './trace.js';

export interface IntentGap {
  id: string;
  /** Date of the latest code change, `YYYY-MM-DD`. */
  codeDate: string;
  /** Latest of the capability's history entries and its spec edit, or '' when none. */
  intentDate: string;
}

/** Unix time of the latest commit touching any of `paths`, or 0 outside git or when none did. */
function lastCommitTime(root: string, paths: string[]): number {
  let best = 0;
  for (let i = 0; i < paths.length; i += 100) {
    try {
      const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', ...paths.slice(i, i + 100)], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      best = Math.max(best, Number(out) || 0);
    } catch {
      return 0;
    }
  }
  return best;
}

const day = (seconds: number): string => (seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 10) : '');
/** A history entry only has a day; it covers code committed any time that day. */
const endOfDay = (date: string): number => Math.floor(Date.parse(`${date}T23:59:59Z`) / 1000) || 0;

/**
 * Capabilities whose code changed after their docs did: the docs may no longer describe the code.
 * Skipped outside git, and for capabilities with no docs or no committed code.
 */
export function staleDocs(root: string, nodes: TraceNode[]): string[] {
  const stale: string[] = [];
  for (const n of nodes) {
    if (n.kind !== 'capability' && n.kind !== 'component') continue;
    if (n.ownedFiles.length === 0 || n.docs.length === 0) continue;
    const code = lastCommitTime(root, n.ownedFiles);
    const docs = lastCommitTime(root, n.docs);
    if (code > 0 && docs > 0 && code > docs) stale.push(n.id);
  }
  return stale;
}

export function intentGaps(root: string, nodes: TraceNode[], entries: HistoryEntry[], specsRootRel = 'specs'): IntentGap[] {
  if (entries.length === 0) return [];
  const gaps: IntentGap[] = [];
  for (const n of nodes) {
    if (n.kind !== 'capability' && n.kind !== 'component') continue;
    if (n.ownedFiles.length === 0) continue;
    const code = lastCommitTime(root, n.ownedFiles);
    if (code === 0) continue;
    const history = entries.filter((e) => e.affects.includes(n.id) || n.history.includes(e.id)).map((e) => endOfDay(e.date));
    const spec = lastCommitTime(root, [`${specsRootRel}/${n.specKey}.md`]);
    const intent = Math.max(0, spec, ...history);
    if (code > intent) gaps.push({ id: n.id, codeDate: day(code), intentDate: day(intent) });
  }
  return gaps;
}
