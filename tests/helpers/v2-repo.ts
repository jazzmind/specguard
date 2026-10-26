import { execFileSync } from 'node:child_process';

import { makeRepo, type TmpRepo } from './repo.js';

const front = (id: string, extra: string) => `---\nid: ${id}\nkind: capability\nparent: system\nvalue: ${id} value\nstatus: active\n${extra}---\n`;

export const SYSTEM_SPEC = '---\nid: system\nkind: system\nvalue: v\n---\n# System\n\n## Problem\n\nx\n';

export const AUTH_SPEC =
  front('auth', 'sources:\n  - "src/auth/**"\ntests:\n  - "tests/auth.test.ts"\n') +
  '# Auth\n\n## Problem & Value\n\nOnly approved people sign in.\n\n## Requirements\n\n' +
  '- [ ] Login succeeds with a valid code <!-- claim: login-valid-code -->\n' +
  '- [ ] Logout clears the session <!-- claim: logout-clears-session -->\n\n## Scenarios\n\n### Scenario 1: Login\n**Steps:**\n1. Enter code\n\n**Expected Results:**\n- Signed in\n';

export const SHOP_SPEC =
  front('shop', 'sources:\n  - "src/shop/**"\n  - "src/core/awards.ts"\n') +
  '# Shop\n\n## Problem & Value\n\nPeople can buy things.\n\n## Requirements\n\n- [ ] Cart totals are correct <!-- claim: cart-totals -->\n\n## Scenarios\n\n### Scenario 1: Total\n**Steps:**\n1. Add item\n\n**Expected Results:**\n- Total shown\n';

/** A repo with system + auth + shop capabilities and one unowned source file. */
export function makeV2Repo(extraConfig: Record<string, unknown> = {}): TmpRepo {
  const repo = makeRepo(extraConfig);
  // Replace the v1 seed spec so the repo is purely v2.
  repo.write('specs/core/awards.md', '');
  repo.write('specs/system.md', SYSTEM_SPEC);
  repo.write('specs/capabilities/auth.md', AUTH_SPEC);
  repo.write('specs/capabilities/shop.md', SHOP_SPEC);
  repo.write('src/auth/login.ts', 'export const login = 1;\n');
  repo.write('src/auth/logout.ts', 'export const logout = 1;\n');
  repo.write('src/shop/cart.ts', 'export const cart = 1;\n');
  repo.write('src/orphan.ts', 'export const orphan = 1;\n');
  repo.write('tests/auth.test.ts', "it('logs in @claim:capabilities/auth#login-valid-code', () => {});\n");
  return repo;
}

/** Commit everything, optionally at a fixed date (ISO) so history comparisons are deterministic. */
export function gitCommit(dir: string, message: string, date?: string): void {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, stdio: 'ignore', env });
}

/** Initialise a git repo with everything committed, so diffs have a base. */
export function gitInit(dir: string, date?: string): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  gitCommit(dir, 'base', date);
}

/** The shop capability with an examples table under its one claim (rows `ny-small` and `ny-free`). */
export const SHOP_SPEC_WITH_ROWS = SHOP_SPEC.replace(
  '<!-- claim: cart-totals -->\n',
  '<!-- claim: cart-totals -->\n\n  | id       | state | total |\n  |----------|-------|-------|\n  | ny-small | NY    | 5.00  |\n  | ny-free  | NY    | 0.00  |\n',
);
