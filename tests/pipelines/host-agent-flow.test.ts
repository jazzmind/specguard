import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { AgentWorkPendingError, answerAgentRequest, listAgentRequests, pendingThisRun, resetPending, type AgentRequest } from '../../src/core/agent-work.js';
import { loadConfig } from '../../src/core/config.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import { resetLlmRuntime } from '../../src/core/llm.js';
import { runCapabilityDrift } from '../../src/pipelines/drift-capability.js';
import { runSpecDraft } from '../../src/pipelines/spec-draft.js';
import { runSpecTag } from '../../src/pipelines/spec-tag.js';
import { runStart } from '../../src/pipelines/start.js';
import { makeRepo, type TmpRepo } from '../helpers/repo.js';

/**
 * The host agent stands in for the model: these tests drive the real pipelines with `llm.provider: "host"` and
 * play the agent by answering the request files the pipelines write.
 */
let repo: TmpRepo;

const synth = {
  problemAndValue: 'Shoppers see correct totals.',
  users: ['A shopper sees a total'],
  requirements: [
    { id: 'total-sums-prices', text: 'The total is the sum of the prices' },
    { id: 'discount-applies', text: 'A discount lowers the total by that percentage' },
  ],
  scenarios: [{ name: 'Total', steps: ['Total 10 and 20'], expected: ['30'] }],
  security: '',
  interfaces: 'total()',
  outOfScope: 'Tax.',
};

/** What a reasonable agent would answer for each kind of request. */
function respond(req: AgentRequest): unknown {
  switch (req.pipeline) {
    case 'summarize': {
      const paths = [...req.prompt.matchAll(/=== FILE: (\S+)/g)].map((m) => m[1]);
      return { summaries: paths.map((p) => ({ path: p, summary: `does the work of ${p}` })) };
    }
    case 'cluster':
      return {
        system: { title: 'Shop', problem: 'Shoppers need totals.', users: ['Shoppers'], value: 'Right totals.', nonGoals: [] },
        capabilities: [
          { id: 'cart', title: 'Cart', value: 'Totals are right.', rationale: 'one area', sources: ['src/cart/**'], tests: ['tests/**'], docs: [], specs: [], components: [] },
          { id: 'greeting', title: 'Greeting', value: 'People are greeted.', rationale: 'another area', sources: ['src/greet/**'], tests: [], docs: [], specs: [], components: [] },
        ],
      };
    case 'spec-draft':
      return synth;
    case 'tag':
      return { matches: [{ test: 0, claims: [{ id: 'total-sums-prices', confidence: 'high' }, { id: 'discount-applies', confidence: 'medium' }] }] };
    default:
      throw new Error(`no answer for ${req.pipeline}`);
  }
}

function answerAll(root: string): number {
  const dir = path.join(root, '.specguard', 'replay');
  const requests = listAgentRequests(root);
  for (const r of requests) answerAgentRequest(root, dir, r.hash, respond(r));
  return requests.length;
}

async function freshConfig() {
  resetLlmRuntime();
  resetPending();
  return loadConfig(repo.dir);
}

beforeEach(() => {
  repo = makeRepo({ llm: { provider: 'host', model: 'host-agent', apiKeyEnv: 'NONE' } });
  repo.write('src/cart/total.ts', 'export const total = (p: number[]) => p.reduce((a, b) => a + b, 0);\n');
  repo.write('src/greet/hello.ts', 'export const hello = (n: string) => `Hello ${n}`;\n');
  repo.write('tests/total.test.ts', "import { it } from 'vitest';\nit('sums prices', () => {});\n");
});

describe('spec draft and spec tag with the host agent [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#host-agent-batching]
  it('drafts a spec tree in batched rounds, with every capability asked for in one round', async () => {
    const rounds: string[][] = [];
    let result;
    for (let round = 0; round < 6; round += 1) {
      const config = await freshConfig();
      result = await runSpecDraft(config, { yes: true, force: true }).catch((e) => {
        if (e instanceof AgentWorkPendingError) return undefined; // a step with no answer yet stops the run; the CLI exits 12
        throw e;
      });
      const waiting = pendingThisRun();
      if (waiting.length === 0) break;
      rounds.push(waiting.map((w) => w.pipeline));
      expect(answerAll(repo.dir)).toBeGreaterThan(0);
    }
    expect(result?.exitCode).toBe(ExitCode.Success);
    // Summaries (all files in one request), the map, then one request per capability, together.
    expect(rounds[0]).toEqual(['summarize']);
    expect(rounds[1]).toEqual(['cluster']);
    expect(rounds[2].sort()).toEqual(['spec-draft', 'spec-draft']);
    expect(rounds).toHaveLength(3);
    for (const id of ['cart', 'greeting']) expect(existsSync(path.join(repo.dir, 'specs', 'capabilities', `${id}.md`))).toBe(true);
    expect(readFileSync(path.join(repo.dir, 'specs', 'system.md'), 'utf8')).toContain('Shop');
  });

  // [claims: capabilities/platform-foundation#host-agent-batching]
  it('reports a half-answered draft as waiting, not failed, and writes no system spec yet', async () => {
    const config = await freshConfig();
    await runSpecDraft(config, { yes: true }).catch(() => undefined);
    answerAll(repo.dir); // summaries
    let c = await freshConfig();
    await runSpecDraft(c, { yes: true }).catch(() => undefined);
    answerAll(repo.dir); // map
    c = await freshConfig();
    const result = await runSpecDraft(c, { yes: true });
    expect(result.exitCode).toBe(ExitCode.AgentWorkPending);
    expect(result.failed).toBe(0);
    expect(result.items.every((i) => i.status === 'skipped')).toBe(true);
    expect(existsSync(path.join(repo.dir, 'specs', 'system.md'))).toBe(false);
  });

  // [claims: capabilities/platform-foundation#host-agent-batching]
  it('tags tests from the agent answer, keeping only high-confidence links, after one round', async () => {
    repo.write(
      'specs/capabilities/cart.md',
      `---\nid: cart\nkind: capability\nparent: system\nvalue: Totals are right.\nstatus: active\nsources:\n  - "src/cart/**"\ntests:\n  - "tests/**/*.test.ts"\n---\n\n# Cart\n\n## Problem & Value\n\nTotals.\n\n## Requirements\n\n- [ ] The total is the sum of the prices <!-- claim: total-sums-prices -->\n- [ ] A discount lowers the total by that percentage <!-- claim: discount-applies -->\n`,
    );
    let config = await freshConfig();
    await expect(runSpecTag(config, { yes: true })).rejects.toMatchObject({ exitCode: ExitCode.AgentWorkPending });
    expect(pendingThisRun().map((p) => p.pipeline)).toEqual(['tag']);
    // Nothing is applied while an answer is missing.
    expect(readFileSync(path.join(repo.dir, 'tests', 'total.test.ts'), 'utf8')).not.toContain('claims:');

    answerAll(repo.dir);
    config = await freshConfig();
    const result = await runSpecTag(config, { yes: true });
    expect(result.exitCode).toBe(ExitCode.Success);
    const test = readFileSync(path.join(repo.dir, 'tests', 'total.test.ts'), 'utf8');
    expect(test).toContain('[claims: capabilities/cart#total-sums-prices]');
    expect(test).not.toContain('discount-applies'); // a medium-confidence link would overstate what the test proves
  });

  // [claims: capabilities/platform-foundation#host-agent-batching]
  it('never records a guessed drift verdict while the agent has not judged a change', async () => {
    repo.write(
      'specs/capabilities/cart.md',
      `---\nid: cart\nkind: capability\nparent: system\nvalue: Totals are right.\nstatus: active\nsources:\n  - "src/cart/**"\n---\n\n# Cart\n\n## Problem & Value\n\nTotals.\n\n## Requirements\n\n- [ ] The total is the sum of the prices <!-- claim: total-sums-prices -->\n`,
    );
    let config = await freshConfig();
    await runCapabilityDrift(config, {}); // baseline
    repo.write('src/cart/total.ts', 'export const total = (p: number[]) => p.reduce((a, b) => a + b, 1);\n');
    config = await freshConfig();
    const result = await runCapabilityDrift(config, {});
    expect(pendingThisRun().map((p) => p.pipeline)).toEqual(['drift']);
    expect(result.items.find((i) => i.key === 'cart')?.status).toBe('skipped');
    const assessments = path.join(repo.dir, '.specguard', 'drift-assessments.json');
    expect(!existsSync(assessments) || !readFileSync(assessments, 'utf8').includes('"affectedClaims": [\n          "*"')).toBe(true);
  });

  // [claims: capabilities/integration-surfaces#start-command]
  it('start carries a project from nothing to a first report, resuming after each round of agent answers', async () => {
    // The tag answer needs a capability whose tests glob matches; the map above gives `cart` the tests.
    const exits: number[] = [];
    let last;
    for (let round = 0; round < 8; round += 1) {
      resetLlmRuntime();
      resetPending();
      last = await runStart({ cwd: repo.dir, skipTests: true }).catch((e) => {
        if (e instanceof AgentWorkPendingError) return undefined;
        throw e;
      });
      exits.push(last?.exitCode ?? ExitCode.AgentWorkPending);
      if (last && last.exitCode !== ExitCode.AgentWorkPending) break;
      expect(answerAll(repo.dir)).toBeGreaterThan(0);
    }
    expect(last?.exitCode).toBe(ExitCode.Success);
    // summaries, map, capability specs, tagging: four waits, then the report.
    expect(exits.filter((e) => e === ExitCode.AgentWorkPending)).toHaveLength(4);
    const text = last?.messages.join('\n') ?? '';
    expect(text).toContain('[5/5] where things stand');
    expect(text).toMatch(/claims/);
    expect(existsSync(path.join(repo.dir, 'specs', 'system.md'))).toBe(true);
  });

  // [claims: capabilities/integration-surfaces#start-command]
  it('start sets a bare project up first: a config and specs README, no key file, then waits for the agent', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
    const os = await import('node:os');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-start-'));
    writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    process.env.SPECGUARD_HOST_AGENT = '1';
    try {
      resetLlmRuntime();
      resetPending();
      const result = await runStart({ cwd: dir, skipTests: true });
      expect(result.exitCode).toBe(ExitCode.AgentWorkPending);
      expect(result.messages.join('\n')).toContain('Run `specguard start` again');
      expect(existsSync(path.join(dir, '.specguard', 'config.json'))).toBe(true);
      expect(existsSync(path.join(dir, '.specguard', '.env'))).toBe(false);
      expect(pendingThisRun().map((p) => p.pipeline)).toEqual(['summarize']);
    } finally {
      delete process.env.SPECGUARD_HOST_AGENT;
    }
  });
});
