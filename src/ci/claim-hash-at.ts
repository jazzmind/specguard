/**
 * The hash of a claim (or example row) as it read at an earlier commit. A pull request review covers a claim only when
 * the claim's hash at the reviewed commit equals its hash now, so CI and `spec approve --from-pr` both ask this question
 * of git. Impure (it runs `git show`), small, and cached per commit and spec file.
 *
 * Spec: specs/capabilities/intent-approval.md
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { claimHashOf } from '../core/claim-hash.js';
import { parseClaimRef } from '../core/claims.js';
import type { SpecGraph } from '../core/spec-graph.js';
import { specsRootDir } from '../core/spec-key.js';
import { parseSpecContent } from '../core/spec-parser.js';
import type { ParsedSpec, SpecGuardConfig } from '../core/types.js';

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

function show(root: string, commit: string, rel: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${commit}:./${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/**
 * `hashAt(commit, ref)` for `specKey#claim` and `specKey#claim/row`: the full hash at `commit`, or undefined when the
 * commit is not a full object name, is not in this clone, the spec did not exist there, or the claim or row did not.
 */
export function makeHashAt(config: SpecGuardConfig, graph: SpecGraph): (commit: string, ref: string) => string | undefined {
  const root = config.rootDir ?? process.cwd();
  const specsRoot = specsRootDir(config);
  const byKey = new Map<string, { filePath: string; specKey: string }>();
  for (const n of graph.nodes.values()) if (n.kind === 'capability' || n.kind === 'component') byKey.set(n.specKey, { filePath: n.spec.filePath, specKey: n.spec.specKey });
  const parsed = new Map<string, ParsedSpec | null>();

  return (commit, ref) => {
    if (!FULL_SHA.test(commit)) return undefined;
    const claim = parseClaimRef(ref);
    const spec = claim ? byKey.get(claim.specKey) : undefined;
    if (!claim || !spec) return undefined;
    const key = `${commit.toLowerCase()}\0${spec.specKey}`;
    let at = parsed.get(key);
    if (at === undefined) {
      const rel = path.relative(root, spec.filePath).split(path.sep).join('/');
      const text = show(root, commit, rel);
      at = text === undefined ? null : { ...parseSpecContent(text, spec.filePath, specsRoot), specKey: spec.specKey };
      parsed.set(key, at);
    }
    if (!at) return undefined;
    if (!claim.exampleId) return claimHashOf(at, claim.claimId);
    return at.claims.find((c) => c.id === claim.claimId)?.examples?.rows.find((r) => r.id === claim.exampleId)?.hash;
  };
}
