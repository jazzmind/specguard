import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SpecGuard is an open-source project. Names of private projects, employers and
 * internal hosts must not appear in its tracked files (code, tests, specs, docs,
 * fixtures, history). The list is kept as SHA-256 hashes of lowercase word tokens
 * so it does not itself name anyone. To add an entry:
 *   node -e "console.log(require('crypto').createHash('sha256').update('word').digest('hex'))"
 * Spec: specs/capabilities/platform-foundation.md
 */
const DENIED = new Set([
  'fe6f62d63ba123cadd8af2857ccdfab2a9b9ee6b442cf9c4ba1c0995c2b03b3d',
  'a744d93f2c6e8830a70b434113ecdebdaf568ba8c0557c63bd0914528760ae53',
  '7581de4903bdaf06ceb6ccbeb73342d67674437ea182f89c3dad285d4e41a0ff',
  'd404f7bae637dff3b695d9b388f81ab291af5f465f1910e2388e79971c8db3f7',
  'fa7a311c8a95caf367d5c153d590c2684802f60d6210c1b4efc48aea0ebfd5ba',
  'd285c657f540d4f9ec32c0eaa4ea19ccf2061c030c45c967470c3be5d4204312',
  '62aae98660d39cf19a051ced41d9b83198af6d29fc5fdb8713d97f9560b3f14e',
]);

const root = path.resolve(import.meta.dirname, '..', '..');
const SKIP = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|\.specguard\/(proofs|trace)\.json)$|\.(png|jpe?g|gif|ico|vsix|woff2?|pdf|zip)$/;

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((f) => f && !SKIP.test(f));
}

describe('no private names in tracked files [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#no-private-names]
  it('contains no denied word token', () => {
    const hits: string[] = [];
    for (const rel of trackedFiles()) {
      let text: string;
      try {
        text = readFileSync(path.join(root, rel), 'utf8');
      } catch {
        continue;
      }
      const seen = new Set<string>();
      for (const m of (rel + '\n' + text).toLowerCase().matchAll(/[a-z0-9]+/g)) {
        const token = m[0];
        if (seen.has(token)) continue;
        seen.add(token);
        if (DENIED.has(createHash('sha256').update(token).digest('hex'))) hits.push(`${rel}`);
      }
    }
    expect([...new Set(hits)]).toEqual([]);
  });
});
