import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../src/core/config.js';
import { runSpecApprove } from '../../src/pipelines/approve.js';
import { gitCommit, gitInit, makeV2Repo } from './v2-repo.js';
import type { TmpRepo } from './repo.js';

/** Fixture tags are assembled here so no test file holds a literal tag of its own. */
export const commentTag = (ref: string): string => `// [claims${':'} ${ref}]`;

/**
 * A fake vitest. It reports each catalog test as passed or failed, and a test with `needs` passes only when that file
 * holds the marker, so a test "fails on the old code" exactly when the code lacks the marker. It honours `-t` and file
 * arguments and writes a vitest JSON report, so no network and no real runner is involved.
 */
export const RUNNER = `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const catalog = JSON.parse(fs.readFileSync('catalog.json', 'utf8'));
const t = args.indexOf('-t');
const re = t >= 0 ? new RegExp(args[t + 1]) : null;
const files = args.filter((a) => /\\.test\\.ts$/.test(a));
const ok = (c) => !c.needs || (fs.existsSync(c.needs.file) && fs.readFileSync(c.needs.file, 'utf8').includes(c.needs.marker));
const chosen = catalog.filter((c) => (!re || re.test(c.title)) && (files.length === 0 || files.includes(c.file)));
const byFile = {};
for (const c of chosen) (byFile[c.file] = byFile[c.file] || []).push({ title: c.title, ancestorTitles: [], fullName: c.title, status: ok(c) ? 'passed' : 'failed' });
const testResults = Object.entries(byFile).map(([file, assertionResults]) => ({ name: path.resolve(file), assertionResults }));
fs.writeFileSync('report.json', JSON.stringify({ testResults }));
process.exit(chosen.some((c) => !ok(c)) ? 1 : 0);
`;

export const SHIPPING_TITLE = 'applies free shipping over fifty';
export const AUTH_TITLE = 'logs in @claim:capabilities/auth#login-valid-code';
export const FREE_SHIPPING = 'capabilities/shop#free-shipping';
export const CART_TOTALS = 'capabilities/shop#cart-totals';

export interface CatalogEntry {
  file: string;
  title: string;
  needs?: { file: string; marker: string };
}

export const setCatalog = (repo: TmpRepo, entries: CatalogEntry[]): void => void repo.write('catalog.json', JSON.stringify(entries));

/** The shop test that proves the free-shipping claim; passes only once `src/shop/cart.ts` holds FREE_SHIPPING. */
export const SHOP_CATALOG: CatalogEntry[] = [
  { file: 'tests/auth.test.ts', title: AUTH_TITLE },
  { file: 'tests/shop.test.ts', title: SHIPPING_TITLE, needs: { file: 'src/shop/cart.ts', marker: 'FREE_SHIPPING' } },
];

export const shopTestSource = (extra = ''): string =>
  [commentTag(FREE_SHIPPING), `it('${SHIPPING_TITLE}', () => {`, '  expect(shippingFee(60)).toBe(0);', '});', extra, ''].join('\n');

/** A v2 repo (auth, shop) whose app runs the fake runner, committed to git. */
export function changeRepo(): TmpRepo {
  const repo = makeV2Repo({
    apps: [
      {
        name: 'app',
        repo: '.',
        specDir: 'specs',
        sources: { routes: ['src/**/*.ts'], tests: ['tests/**/*.test.ts'] },
        framework: 'vitest',
        testOutput: 'tests/',
        test: { command: 'node run-tests.cjs', resultsFile: 'report.json', reporter: 'vitest' },
      },
    ],
  });
  repo.write('run-tests.cjs', RUNNER);
  setCatalog(repo, [SHOP_CATALOG[0]!]);
  gitInit(repo.dir);
  return repo;
}

export const read = (repo: TmpRepo, rel: string): string => readFileSync(path.join(repo.dir, rel), 'utf8');

/** Add the free-shipping requirement to the shop spec (below the existing claim). */
export function addFreeShippingClaim(repo: TmpRepo): void {
  const file = path.join(repo.dir, 'specs/capabilities/shop.md');
  const before = readFileSync(file, 'utf8');
  writeFileSync(file, before.replace('<!-- claim: cart-totals -->\n', '<!-- claim: cart-totals -->\n- [ ] Orders over fifty dollars ship free <!-- claim: free-shipping -->\n'));
}

/** A person approves the shop requirements, as `spec approve` does from a terminal. */
export async function approveShop(repo: TmpRepo): Promise<void> {
  await runSpecApprove(await loadConfig(repo.dir), { targets: ['shop'], yes: true, by: 'Ada', actor: { agent: false, tty: true } });
}

/** Write the shop test and its catalog entry (not yet passing: the code lacks the marker). */
export function writeShopTests(repo: TmpRepo): void {
  repo.write('tests/shop.test.ts', shopTestSource());
  setCatalog(repo, SHOP_CATALOG);
}

/** The code the shop test waits for. */
export function writeShopCode(repo: TmpRepo): void {
  repo.write('src/shop/cart.ts', 'export const cart = 1;\nexport const FREE_SHIPPING = 50;\n');
}

export { gitCommit };
