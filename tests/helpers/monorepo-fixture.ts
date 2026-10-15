import { readFileSync } from 'node:fs';

import { makeRepo, type TmpRepo } from './repo.js';
import { gitInit } from './v2-repo.js';

const front = (id: string, sources: string[], extra = '') =>
  `---\nid: ${id}\nkind: capability\nparent: system\nvalue: ${id} value\nstatus: active\nsources:\n${sources.map((s) => `  - "${s}"`).join('\n')}\n${extra}---\n`;

const AUTH =
  front('auth', ['packages/web/src/**', 'packages/api/src/**']) +
  '# Auth\n\n## Problem & Value\n\nOnly approved people sign in.\n\n## Requirements\n\n- [ ] A valid code signs the user in <!-- claim: login --> \n- [ ] Logout ends the session <!-- claim: logout -->\n\n## Scenarios\n\n### Scenario 1: Login\n**Steps:**\n1. Sign in\n\n**Expected Results:**\n- Signed in\n';

const DESIGN =
  front('design-system', ['packages/ui/src/**']) +
  '# Design system\n\n## Problem & Value\n\nOne look and feel.\n\n## Requirements\n\n- [ ] Buttons are keyboard accessible <!-- claim: buttons-accessible -->\n\n## Scenarios\n\n### Scenario 1: Button\n**Steps:**\n1. Tab to a button\n\n**Expected Results:**\n- It is focused\n';

/** A fake test command: records which unit ran and writes a JUnit report where the runner asked. */
const RUN_UNIT = `
const fs = require('fs');
const unit = process.argv[2];
const arg = process.argv.find((a) => a.startsWith('--junitxml='));
fs.appendFileSync('ran.log', unit + '\\n');
const claims = { web: 'capabilities/auth#login', api: 'capabilities/auth#logout', ui: 'capabilities/design-system#buttons-accessible' };
const tag = claims[unit] ? ' @claim:' + claims[unit] : '';
if (arg) fs.writeFileSync(arg.slice('--junitxml='.length), '<testsuite name="' + unit + '"><testcase classname="' + unit + '" name="' + unit + ' works' + tag + '"/></testsuite>');
`;

export interface Monorepo extends TmpRepo {
  /** Units that `ran.log` says were tested, in order. */
  ran(): string[];
}

/** pnpm-style monorepo: ui (shared), web and api (both depend on ui), tools (no spec, no deps). */
export function makeMonorepo(): Monorepo {
  const repo = makeRepo({
    apps: [
      {
        name: 'app',
        repo: '.',
        specDir: 'specs',
        sources: { routes: ['packages/*/src/**/*.ts'], tests: ['packages/*/tests/**/*.test.ts'] },
        framework: 'vitest',
        testOutput: 'tests/',
      },
    ],
  });
  repo.write('specs/core/awards.md', '');
  repo.write('src/core/awards.ts', '');
  repo.write('specs/system.md', '---\nid: system\nkind: system\nvalue: v\n---\n# System\n\n## Problem\n\nx\n');
  repo.write('specs/capabilities/auth.md', AUTH);
  repo.write('specs/capabilities/design-system.md', DESIGN);
  repo.write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  repo.write('package.json', JSON.stringify({ name: 'root' }));
  for (const [name, deps] of Object.entries({ ui: {}, web: { '@acme/ui': 'workspace:*' }, api: { '@acme/ui': 'workspace:*' }, tools: {} })) {
    repo.write(`packages/${name}/package.json`, JSON.stringify({ name: `@acme/${name}`, dependencies: deps }));
    repo.write(`packages/${name}/src/index.ts`, `export const ${name} = 1;\n`);
  }
  repo.write('packages/ui/src/button.ts', 'export const button = 1;\n');
  repo.write('run-unit.cjs', RUN_UNIT);
  const unit = (key: string) => ({
    path: `packages/${key}`,
    kind: 'package',
    role: 'package',
    packageName: `@acme/${key}`,
    ecosystem: 'js',
    test: { command: `node run-unit.cjs ${key}`, framework: 'pytest' },
  });
  repo.write(
    '.specguard/workspace.json',
    JSON.stringify({ version: '2', name: 'acme', repos: {}, units: { ui: unit('ui'), web: unit('web'), api: unit('api'), tools: unit('tools') } }),
  );
  repo.write('.gitignore', '.specguard/\nran.log\n');
  gitInit(repo.dir);
  return {
    ...repo,
    ran: () => {
      try {
        return readFileSync(`${repo.dir}/ran.log`, 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}
