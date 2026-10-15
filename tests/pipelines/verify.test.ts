import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/adapters/playwright.js', () => {
  const page = {
    goto: vi.fn(async () => ({ status: () => 200 })),
    title: vi.fn(async () => 'Sign in'),
    url: vi.fn(() => 'http://localhost:3000/'),
    screenshot: vi.fn(async () => Buffer.from('PNG')),
    on: vi.fn(),
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
  };
  return {
    launchBrowser: vi.fn(async () => ({ _browser: { close: vi.fn() }, _page: page, _consoleErrors: [] })),
    closeBrowser: vi.fn(async () => {}),
    openSession: vi.fn(async () => ({ _browser: { close: vi.fn() }, _page: page, _consoleErrors: [], _ownsBrowser: false })),
    inspectTarget: vi.fn(async () => null),
    navigateTo: vi.fn(async () => ({ url: 'http://localhost:3000/', title: 'Sign in', statusCode: 200, consoleErrors: [] })),
    takeScreenshot: vi.fn(async (_h: unknown, label: string, dir: string) => path.join(dir, `${label}.png`)),
    getAccessibilitySnapshot: vi.fn(async () => '{"role":"WebArea"}'),
    getPageHtml: vi.fn(async () => '<html></html>'),
    PlaywrightUnavailableError: class extends Error {},
  };
});
vi.mock('../../src/adapters/auth-state-machine.js', () => ({
  authenticate: vi.fn(async () => ({ success: true })),
  contextOptionsFor: vi.fn(() => ({ options: {} })),
  clearSessionCache: vi.fn(),
}));
vi.mock('../../src/core/llm.js', () => ({ llmGenerateObject: vi.fn(), llmGenerateText: vi.fn() }));

import { loadConfig } from '../../src/core/config.js';
import { llmGenerateObject } from '../../src/core/llm.js';
import { ingestVerdicts } from '../../src/pipelines/proof.js';
import { runValidate } from '../../src/pipelines/validate.js';

const mocked = llmGenerateObject as unknown as ReturnType<typeof vi.fn>;
let root: string;

const SPEC = `---
id: auth
kind: capability
parent: system
value: Only approved people sign in.
sources:
  - "src/**"
---
# Auth

## Problem & Value

Staff must sign in with a one-time code so only approved people reach the portal.

## Users & Journeys

- A staff member requests a code and signs in.

## Requirements

- [ ] A valid code signs the user in <!-- claim: login-valid-code -->
- [ ] An invalid code is rejected <!-- claim: login-invalid-code -->
- [ ] login <!-- claim: login -->

## Scenarios

### Scenario 1: Sign in
**Steps:**
1. Open the sign-in page
2. Enter the emailed code

**Expected Results:**
- The portal home page is shown
`;

async function put(rel: string, content: string) {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content);
}
const ledger = async () => JSON.parse(await readFile(path.join(root, '.specguard/proofs.json'), 'utf8')).proofs as Record<string, { verdict: string; evidence?: string }>;

/** PLAN round 1 acts, PLAN round 2 is done, then VERIFY. */
function script(verify: unknown, plans: unknown[] = [{ actions: [{ description: 'click sign in', selector: '#go' }] }, { actions: [] }]) {
  mocked.mockReset();
  for (const p of plans) mocked.mockResolvedValueOnce(p);
  mocked.mockResolvedValueOnce(verify);
}

const verdicts = (rows: Array<[string, string]>) => rows.map(([criterion, verdict]) => ({ criterion, verdict, reason: `${verdict} because` }));

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'sg-verify-'));
  await put(
    '.specguard/config.json',
    JSON.stringify({
      apps: [{ name: 'app', repo: '.', specDir: 'specs', sources: { api: ['src/**/*.ts'] }, framework: 'playwright', testOutput: 'tests' }],
      llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'K' },
    }),
  );
  await put('specs/system.md', '---\nid: system\nkind: system\nvalue: v\n---\n# S\n');
  await put('specs/capabilities/auth.md', SPEC);
  await put('src/auth.ts', 'export const a = 1;\n');
});

const run = async (opts: Parameters<typeof runValidate>[1] = { all: true, baseUrl: 'http://localhost:3000' }, tweak?: (c: Awaited<ReturnType<typeof loadConfig>>) => void) => {
  const config = await loadConfig(root);
  tweak?.(config);
  return runValidate(config, opts);
};

describe('verify: capability journeys judged against value [verify-v2]', () => {
  // [claims: capabilities/agentic-verification#value-judgement, capabilities/agentic-verification#verify-walks-journeys]
  it('picks up a v2 capability with only a base URL, walks several rounds, and judges value [rounds-and-value]', async () => {
    script({
      verdicts: verdicts([['login-valid-code', 'PASS'], ['login-invalid-code', 'PASS']]),
      value: { delivers: 'YES', reason: 'Signing in with a code works.', gaps: [] },
    });
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(mocked).toHaveBeenCalledTimes(3);
    const planRound2 = mocked.mock.calls[1][0].prompt as string;
    expect(planRound2).toContain('Actions already taken: click sign in');
    expect(planRound2).toContain('Scenarios:');
    expect(planRound2).toContain('Enter the emailed code');
    const verify = mocked.mock.calls[2][0].prompt as string;
    expect(verify).toContain('Staff must sign in with a one-time code');
    expect(verify).toContain('login-valid-code: A valid code signs the user in');
    expect(r.messages.join('\n')).toContain('value: YES');
    const report = JSON.parse(await readFile(path.join(root, '.specguard/reports/verify-capabilities-auth.json'), 'utf8'));
    expect(report.value.delivers).toBe('YES');
  });

  // [claims: capabilities/agentic-verification#ledger-proof, capabilities/agentic-verification#verify-proof-matching]
  it('records PASS and FAIL as agentic proof, matching claim ids exactly, never by substring [agentic-proof]', async () => {
    script({
      verdicts: verdicts([['login-valid-code: A valid code signs the user in', 'PASS'], ['login-invalid-code', 'FAIL']]),
      value: { delivers: 'PARTIAL', reason: 'Rejection broken.', gaps: ['invalid codes are accepted'] },
    });
    const r = await run();
    const proofs = await ledger();
    expect(proofs['capabilities/auth#login-valid-code']).toMatchObject({ verdict: 'proven', evidence: 'agentic' });
    expect(proofs['capabilities/auth#login-invalid-code']).toMatchObject({ verdict: 'failed', evidence: 'agentic' });
    // "login" is a prefix of both ids but was never named, so it must not be touched.
    expect(proofs['capabilities/auth#login']).toBeUndefined();
    expect(r.exitCode).toBe(2);
    expect(r.messages.join('\n')).toContain('[gap] invalid codes are accepted');
  });

  // [claims: capabilities/agentic-verification#value-judgement, capabilities/agentic-verification#verify-value-fails]
  it('fails the capability when the value is judged NO even if every requirement passes [value-no]', async () => {
    script({ verdicts: verdicts([['login-valid-code', 'PASS']]), value: { delivers: 'NO', reason: 'The page is blank.', gaps: [] } });
    const r = await run();
    expect(r.exitCode).toBe(2);
    expect(r.failed).toBe(1);
  });

  // [claims: capabilities/agentic-verification#verify-proof-matching]
  it('does not let BLOCKED or INCONCLUSIVE overwrite a proof a test run already earned [no-downgrade]', async () => {
    await ingestVerdicts({ runId: 'ci', verdicts: [{ claim: 'capabilities/auth#login-valid-code', verdict: 'proven', exercised: 3 }] }, root);
    script({
      verdicts: verdicts([['login-valid-code', 'INCONCLUSIVE'], ['login-invalid-code', 'BLOCKED']]),
      value: { delivers: 'INCONCLUSIVE', reason: 'could not tell', gaps: [] },
    });
    await run();
    const proofs = await ledger();
    expect(proofs['capabilities/auth#login-valid-code']).toMatchObject({ verdict: 'proven', exercised: 3 });
    expect(proofs['capabilities/auth#login-valid-code'].evidence).toBeUndefined();
    expect(proofs['capabilities/auth#login-invalid-code']).toBeUndefined();
  });

  // [claims: capabilities/agentic-verification#verify-walks-journeys]
  it('honours validate.maxRounds [max-rounds]', async () => {
    script({ verdicts: verdicts([['login-valid-code', 'PASS']]), value: { delivers: 'YES', reason: 'ok', gaps: [] } }, [{ actions: [{ description: 'click', selector: '#x' }] }]);
    await run(undefined, (c) => {
      c.validate = { ...c.validate, maxRounds: 1 };
    });
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  // [claims: capabilities/agentic-verification#verify-walks-journeys]
  it('skips a capability when there is no URL to verify it from [needs-url]', async () => {
    mocked.mockReset();
    const r = await run({ all: true });
    expect(mocked).not.toHaveBeenCalled();
    expect(r.messages.join('\n')).toContain('No specs found');
  });

  // [claims: capabilities/agentic-verification#verify-walks-journeys]
  it('lists as "already taken" only the actions that were actually performed [taken-only-performed]', async () => {
    script(
      { verdicts: verdicts([['login-valid-code', 'PASS']]), value: { delivers: 'YES', reason: 'ok', gaps: [] } },
      [{ actions: [{ description: 'navigate to /settings' }, { description: 'click sign in', selector: '#go' }] }, { actions: [] }],
    );
    await run();
    const planRound2 = mocked.mock.calls[1][0].prompt as string;
    expect(planRound2).toContain('Actions already taken: click sign in');
    expect(planRound2).not.toContain('navigate to /settings');
  });

  // [claims: capabilities/agentic-verification#ledger-proof]
  it('treats an empty verdict list as inconclusive, never as a pass, and records no proof [empty-verdicts]', async () => {
    script({ verdicts: [], value: { delivers: 'YES', reason: 'looked fine', gaps: [] } });
    const r = await run();
    expect(r.messages.join('\n')).toMatch(/INCONCLUSIVE/i);
    expect(await ledger().catch(() => ({}))).toEqual({});
  });
});
