import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/llm.js', () => ({ llmGenerateObject: vi.fn(), llmGenerateText: vi.fn(), resolveTargets: vi.fn(() => [{ model: 'm' }]) }));
vi.mock('../../src/pipelines/remediate/detect.js', () => ({ detect: vi.fn() }));

import { loadConfig } from '../../src/core/config.js';
import { llmGenerateObject } from '../../src/core/llm.js';
import { RemediationPlanSchema } from '../../src/core/remediation-schema.js';
import { ingestVerdicts } from '../../src/pipelines/proof.js';
import { detect } from '../../src/pipelines/remediate/detect.js';
import type { DetectionReport, ItemReport } from '../../src/pipelines/remediate/types.js';
import { runSecurityFix } from '../../src/pipelines/security-fix.js';
import { readPlan, runPlanSetStatus } from '../../src/pipelines/security-plan.js';
import { runSecurityScan } from '../../src/pipelines/security-scan.js';
import { installNpmPlugin } from '../helpers/npm-plugin.js';
import { makeMonorepo } from '../helpers/monorepo-fixture.js';
import { makeV2Repo } from '../helpers/v2-repo.js';
import type { TmpRepo } from '../helpers/repo.js';

const mockedDetect = detect as unknown as ReturnType<typeof vi.fn>;
const mockedLlm = llmGenerateObject as unknown as ReturnType<typeof vi.fn>;

const advisory = (over: Record<string, unknown> = {}) => ({
  id: 'GHSA-aaaa',
  aliases: [],
  ecosystem: 'npm',
  package: 'lodash',
  installedVersion: '4.17.0',
  vulnerableRange: '<4.17.21',
  fixedVersions: ['4.17.21'],
  severity: 'high',
  direct: true,
  dependencyPath: [],
  source: 'npm-audit',
  title: 'Prototype pollution',
  ...over,
});

function detection(over: Partial<DetectionReport> = {}): DetectionReport {
  return { advisories: [], suppressed: [], belowThreshold: [], sast: [], secrets: [], warnings: [], sources: [], threshold: 'high', ...over } as DetectionReport;
}

let repo: TmpRepo;
const scan = async (opts: Parameters<typeof runSecurityScan>[1] = {}, tweak?: (c: Awaited<ReturnType<typeof loadConfig>>) => void) => {
  const config = await loadConfig(repo.dir);
  tweak?.(config);
  return runSecurityScan(config, { noSpecReview: true, ...opts });
};
const withModel = (c: Awaited<ReturnType<typeof loadConfig>>) => {
  c.llm = { ...c.llm, provider: 'anthropic' };
};

beforeEach(() => {
  mockedDetect.mockReset();
  mockedLlm.mockReset();
  mockedDetect.mockResolvedValue(detection());
  repo = makeV2Repo();
});

describe('security scan [security-scan]', () => {
  // [claims: capabilities/security-and-remediation#remediation-plan, capabilities/security-and-remediation#unified-scan]
  it('turns advisories, code findings and secrets into one valid plan [one-plan]', async () => {
    mockedDetect.mockResolvedValue(
      detection({
        advisories: [advisory()],
        sast: [{ kind: 'sast', ruleId: 'js.xss', path: 'src/auth/login.ts', line: 3, message: 'unescaped output', severity: 'critical' }],
        secrets: [{ kind: 'secret', ruleId: 'aws-key', path: 'src/shop/cart.ts', line: 9, message: 'found AKIAABCDEFGHIJKLMNOP in file' }],
      }),
    );
    const r = await scan({ planId: 'scan-test' });
    expect(r.exitCode).toBe(5);
    const stored = JSON.parse(readFileSync(path.join(repo.dir, '.specguard/security/plans/scan-test.json'), 'utf8'));
    expect(RemediationPlanSchema.safeParse(stored).success).toBe(true);
    expect(stored.items.map((i: { type: string }) => i.type).sort()).toEqual(['code', 'dependency', 'secret']);

    const dep = stored.items.find((i: { type: string }) => i.type === 'dependency');
    expect(dep).toMatchObject({ change: 'dependency', severity: 'high', status: 'open', files: ['package.json'], verify: { scope: 'all-proven' } });
    expect(dep.summary).toContain('4.17.21');

    const code = stored.items.find((i: { type: string }) => i.type === 'code');
    expect(code).toMatchObject({ severity: 'critical', capability: 'auth', files: ['src/auth/login.ts'] });
    expect(code.findings[0]).toMatchObject({ detector: 'semgrep', ruleId: 'js.xss', line: 3 });
    expect(stored.items[0].severity).toBe('critical');
  });

  // [claims: capabilities/security-and-remediation#plan-no-secret-values]
  it('never copies a secret\'s message into the plan [no-secret-leak]', async () => {
    mockedDetect.mockResolvedValue(detection({ secrets: [{ kind: 'secret', ruleId: 'aws-key', path: 'src/shop/cart.ts', line: 9, message: 'found AKIAABCDEFGHIJKLMNOP in file' }] }));
    await scan({ planId: 'scan-test' });
    const text = readFileSync(path.join(repo.dir, '.specguard/security/plans/scan-test.json'), 'utf8');
    expect(text).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(text).toContain('Secret detected by rule aws-key');
  });

  it('lists the capability\'s proven claims for code fixes to preserve [verify-claims]', async () => {
    await ingestVerdicts({ runId: 'r', verdicts: [{ claim: 'capabilities/auth#login-valid-code', verdict: 'proven' }, { claim: 'capabilities/auth#logout-clears-session', verdict: 'failed' }] }, repo.dir);
    mockedDetect.mockResolvedValue(detection({ sast: [{ kind: 'sast', ruleId: 'r', path: 'src/auth/login.ts', message: 'm', severity: 'high' }] }));
    const r = await scan();
    expect(r.plan!.items[0].verify).toEqual({ scope: 'listed', claims: ['capabilities/auth#login-valid-code'] });
  });

  // [claims: capabilities/security-and-remediation#unified-detection]
  it('drops findings below the minimum severity [threshold]', async () => {
    mockedDetect.mockResolvedValue(detection({ advisories: [advisory({ id: 'GHSA-low', severity: 'low', package: 'tiny' })] }));
    const high = await scan({ minSeverity: 'high' });
    expect(high.plan!.items).toHaveLength(0);
    expect(high.exitCode).toBe(0);
    const low = await scan({ minSeverity: 'low' });
    expect(low.plan!.items).toHaveLength(1);
  });

  // [claims: capabilities/security-and-remediation#plan-carry-over]
  it('keeps item ids and statuses across scans and closes what is gone [carry-over]', async () => {
    mockedDetect.mockResolvedValue(detection({ advisories: [advisory(), advisory({ id: 'GHSA-bbbb', package: 'axios' })], sources: ['osv-scanner'] }));
    const first = await scan({ planId: 'scan-1' });
    const lodash = first.plan!.items.find((i) => i.title.startsWith('lodash'))!;
    await runPlanSetStatus(await loadConfig(repo.dir), 'scan-1', lodash.id, 'in-progress', { externalRef: 'SEC-1' });

    mockedDetect.mockResolvedValue(detection({ advisories: [advisory()], sources: ['osv-scanner'] }));
    const second = await scan({ planId: 'scan-2' });
    expect(second.plan!.previous).toBe('scan-1');
    const kept = second.plan!.items.find((i) => i.id === lodash.id)!;
    expect(kept).toMatchObject({ status: 'in-progress', externalRef: 'SEC-1' });
    const gone = second.plan!.items.find((i) => i.title.startsWith('axios'))!;
    expect(gone.status).toBe('fixed');
    expect(gone.statusHistory.at(-1)?.note).toBe('no longer detected');
    expect(second.failed).toBe(1);

    const third = await scan({ planId: 'scan-3' });
    expect(third.plan!.items.map((i) => i.id)).toEqual([lodash.id]);
  });

  describe('carry-over safety [carry-over-safety]', () => {
    const sast = (over: Record<string, unknown> = {}) => ({ kind: 'sast', ruleId: 'sql-injection', path: 'src/a.ts', line: 10, message: 'bad query', severity: 'high', ...over });
    const secret = (over: Record<string, unknown> = {}) => ({ kind: 'secret', ruleId: 'aws-key', path: 'src/b.ts', line: 3, message: 'secret', ...over });

    // [claims: capabilities/security-and-remediation#plan-carry-over]
    it('does not close findings when the detector that found them did not run [no-detector]', async () => {
      mockedDetect.mockResolvedValue(detection({ advisories: [advisory()], sast: [sast()] as never, secrets: [secret()] as never, sources: ['osv-scanner', 'semgrep', 'gitleaks'] }));
      await scan({ planId: 'scan-1' });
      // Same repo, but no detector ran this time (tools missing): silence is not a fix.
      mockedDetect.mockResolvedValue(detection({ warnings: ['gitleaks is not installed'], sources: [] }));
      const second = await scan({ planId: 'scan-2' });
      expect(second.plan!.items).toHaveLength(3);
      expect(second.plan!.items.every((i) => i.status === 'open')).toBe(true);
      expect(second.exitCode).not.toBe(0);
    });

    // [claims: capabilities/security-and-remediation#plan-carry-over]
    it('closes only what the detectors that did run could have seen [partial-detectors]', async () => {
      mockedDetect.mockResolvedValue(detection({ advisories: [advisory()], sast: [sast()] as never, sources: ['osv-scanner', 'semgrep'] }));
      await scan({ planId: 'scan-1' });
      mockedDetect.mockResolvedValue(detection({ sources: ['osv-scanner'] }));
      const second = await scan({ planId: 'scan-2' });
      const byType = Object.fromEntries(second.plan!.items.map((i) => [i.type, i.status]));
      expect(byType).toEqual({ dependency: 'fixed', code: 'open' });
    });

    // [claims: capabilities/security-and-remediation#plan-carry-over]
    it('does not close anything on a scan narrowed to one app or raised above an item severity [narrowed]', async () => {
      mockedDetect.mockResolvedValue(detection({ advisories: [advisory({ severity: 'moderate' })], sources: ['osv-scanner'] }));
      await scan({ planId: 'scan-1', minSeverity: 'moderate' });
      mockedDetect.mockResolvedValue(detection({ sources: ['osv-scanner'] }));
      const raised = await scan({ planId: 'scan-2', minSeverity: 'high' });
      expect(raised.plan!.items.map((i) => i.status)).toEqual(['open']);
      const narrowed = await scan({ planId: 'scan-3', app: 'web', minSeverity: 'moderate' });
      expect(narrowed.plan!.items.map((i) => i.status)).toEqual(['open']);
    });

    // [claims: capabilities/security-and-remediation#plan-carry-over]
    it('reopens a finding someone marked fixed when the scanner still reports it [reopen]', async () => {
      mockedDetect.mockResolvedValue(detection({ advisories: [advisory()], sources: ['osv-scanner'] }));
      const first = await scan({ planId: 'scan-1' });
      const id = first.plan!.items[0].id;
      await runPlanSetStatus(await loadConfig(repo.dir), 'scan-1', id, 'fixed', { by: 'tracker' });
      const second = await scan({ planId: 'scan-2' });
      expect(second.plan!.items[0]).toMatchObject({ id, status: 'open' });
      expect(second.plan!.items[0].statusHistory.at(-1)?.note).toContain('detected again');
      expect(second.exitCode).not.toBe(0);
    });

    // [claims: capabilities/security-and-remediation#plan-carry-over]
    it('gives two findings of one rule in one file different identities, stable when lines move [fingerprints]', async () => {
      mockedDetect.mockResolvedValue(detection({ sast: [sast({ line: 10 }), sast({ line: 40 })] as never, secrets: [secret({ line: 3 }), secret({ line: 9 })] as never, sources: ['semgrep', 'gitleaks'] }));
      const first = await scan({ planId: 'scan-1' });
      expect(new Set(first.plan!.items.map((i) => i.id)).size).toBe(4);
      expect(new Set(first.plan!.items.map((i) => i.fingerprint)).size).toBe(4);
      mockedDetect.mockResolvedValue(detection({ sast: [sast({ line: 14 }), sast({ line: 44 })] as never, secrets: [secret({ line: 5 }), secret({ line: 11 })] as never, sources: ['semgrep', 'gitleaks'] }));
      const second = await scan({ planId: 'scan-2' });
      expect(second.plan!.items.map((i) => i.id).sort()).toEqual(first.plan!.items.map((i) => i.id).sort());
    });

    // [claims: capabilities/security-and-remediation#plan-carry-over]
    it('refuses to carry on when the latest plan cannot be read, rather than dropping every status [unreadable-latest]', async () => {
      mockedDetect.mockResolvedValue(detection({ advisories: [advisory()], sources: ['osv-scanner'] }));
      const first = await scan({ planId: 'scan-1' });
      const file = first.planFile!;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(file, '{ not json');
      const second = await scan({ planId: 'scan-2' });
      expect(second.exitCode).toBe(1);
      expect(second.plan).toBeUndefined();
      expect(second.messages.join('\n')).toContain('does not validate');
    });
  });

  // [claims: capabilities/workspaces#unit-aware-pipelines]
  it('names the workspace unit each finding is in, and omits it outside a workspace [unit-key]', async () => {
    const sastIn = (file: string) => ({ kind: 'sast', ruleId: 'js.xss', path: file, line: 1, message: 'x', severity: 'high' });
    mockedDetect.mockResolvedValue(detection({ sast: [sastIn('packages/web/src/index.ts'), sastIn('packages/ui/src/button.ts')] as never, advisories: [advisory()], sources: ['semgrep', 'osv-scanner'] }));
    const mono = makeMonorepo();
    const inMono = await runSecurityScan(await loadConfig(mono.dir), { noSpecReview: true });
    const unitOfTitle = Object.fromEntries(inMono.plan!.items.map((i) => [i.title, i.unit]));
    expect(unitOfTitle['js.xss in packages/web/src/index.ts']).toBe('web');
    expect(unitOfTitle['js.xss in packages/ui/src/button.ts']).toBe('ui');
    // A dependency item points at the root manifest, which belongs to no package.
    expect(inMono.plan!.items.find((i) => i.type === 'dependency')!.unit).toBeUndefined();
    expect(RemediationPlanSchema.safeParse(inMono.plan).success).toBe(true);
    const plain = await scan({});
    expect(plain.plan!.items.every((i) => i.unit === undefined)).toBe(true);
  });

  describe('plugin detectors [plugin-detectors]', () => {
    // The package is loaded once per process, so its answer is read from a file the test rewrites between scans.
    const PLUGIN =
      "const fs = require('fs'); const path = require('path');" +
      "exports.plugin = { id: 'lint-rules', detectors: [{ id: 'lint-rules', detect: async ({ rootDir }) => {" +
      "const state = JSON.parse(fs.readFileSync(path.join(rootDir, 'detector-state.json'), 'utf8'));" +
      "if (state.throw) throw new Error(state.throw); return state; } }] };";
    const answer = (state: unknown) => repo.write('detector-state.json', JSON.stringify(state));
    const withPlugin = (c: Awaited<ReturnType<typeof loadConfig>>) => {
      c.plugins = [{ name: 'lint-rules', package: 'specguard-plugin-lint-rules' }];
    };
    const evalFinding = { ruleId: 'no-eval', path: 'src/auth/login.ts', line: 4, message: 'eval on input', severity: 'high' };

    beforeEach(() => installNpmPlugin(repo, 'specguard-plugin-lint-rules', PLUGIN));

    // [claims: capabilities/integration-surfaces#planned-plugin-extensions]
    it('turns a plugin detector\'s findings into code items under the owning capability [findings]', async () => {
      answer({ findings: [evalFinding, { ruleId: 'tiny', path: 'src/auth/login.ts', message: 'nit', severity: 'low' }] });
      const r = await scan({}, withPlugin);
      const items = r.plan!.items.filter((i) => i.findings[0].detector === 'plugin');
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ type: 'code', severity: 'high', capability: 'auth', files: ['src/auth/login.ts'] });
      expect(items[0].findings[0]).toMatchObject({ source: 'lint-rules', ruleId: 'no-eval', line: 4 });
      expect(RemediationPlanSchema.safeParse(r.plan).success).toBe(true);
    });

    // [claims: capabilities/integration-surfaces#planned-plugin-extensions]
    it('closes its findings only when the detector ran cleanly, and never patches them [lifecycle]', async () => {
      answer({ findings: [evalFinding] });
      await scan({ planId: 'scan-1' }, withPlugin);
      // The detector now warns: it did not finish, so silence is not a fix.
      answer({ findings: [], warnings: ['rules file missing'] });
      const partial = await scan({ planId: 'scan-2' }, withPlugin);
      expect(partial.plan!.items.map((i) => i.status)).toEqual(['open']);
      // Cleanly empty: closed.
      answer({ findings: [] });
      const clean = await scan({ planId: 'scan-3' }, withPlugin);
      expect(clean.plan!.items.map((i) => i.status)).toEqual(['fixed']);
      // And security fix leaves a plugin-found item alone.
      answer({ findings: [evalFinding] });
      await scan({ planId: 'scan-4' }, withPlugin);
      const remediate = vi.fn();
      const fixed = await runSecurityFix(await loadConfig(repo.dir), { planId: 'scan-4' }, {}, remediate as never);
      expect(remediate).not.toHaveBeenCalled();
      expect(fixed.messages.join('\n')).toContain('found by a plugin detector');
    });

    // [claims: capabilities/integration-surfaces#planned-plugin-extensions]
    it('a detector that throws is reported and does not stop the scan [detector-crash]', async () => {
      answer({ throw: 'boom' });
      mockedDetect.mockResolvedValue(detection({ advisories: [advisory()], sources: ['osv-scanner'] }));
      const r = await scan({}, withPlugin);
      expect(r.messages.join('\n')).toContain('detector lint-rules failed: boom');
      expect(r.plan!.items.map((i) => i.type)).toEqual(['dependency']);
    });
  });

  it('reports a detection failure instead of writing an empty plan [detect-failure]', async () => {
    mockedDetect.mockRejectedValue(new Error('osv offline'));
    const r = await scan();
    expect(r.exitCode).toBe(1);
    expect(r.messages.join('\n')).toContain('osv offline');
    expect(r.plan).toBeUndefined();
  });

  describe('spec-level review [spec-review]', () => {
    const finding = (over: Record<string, unknown> = {}) => ({
      kind: 'missing-rate-limit',
      severity: 'high',
      title: 'Code requests are not rate limited',
      detail: 'The login requirement lets anyone request unlimited codes.',
      claims: ['login-valid-code', 'not-a-claim'],
      recommendation: 'Add a requirement limiting code requests per address.',
      ...over,
    });

    // [claims: capabilities/security-and-remediation#spec-review]
    it('adds a spec item per finding, grounded in the capability, with the real claim refs only [spec-items]', async () => {
      mockedLlm.mockImplementation(async (o: { prompt: string }) => (o.prompt.includes('(auth)') ? { findings: [finding()] } : { findings: [] }));
      const r = await scan({ noSpecReview: false }, withModel);
      const specs = r.plan!.items.filter((i) => i.type === 'spec');
      expect(specs).toHaveLength(1);
      expect(specs[0]).toMatchObject({
        change: 'spec',
        severity: 'high',
        capability: 'auth',
        claims: ['capabilities/auth#login-valid-code'],
        files: ['specs/capabilities/auth.md'],
        summary: 'Add a requirement limiting code requests per address.',
      });
      expect(specs[0].findings[0]).toMatchObject({ detector: 'spec-review', ruleId: 'missing-rate-limit' });
      const call = mockedLlm.mock.calls.find((c) => (c[0].prompt as string).includes('(auth)'))![0];
      expect(call.pipeline).toBe('spec-review');
      expect(call.prompt).toContain('login-valid-code: Login succeeds with a valid code');
      expect(call.prompt).toContain('Only approved people sign in.');
    });

    // [claims: capabilities/security-and-remediation#plan-carry-over]
    it('keeps a spec finding as one item when the model rewords its title, and never auto-closes it [spec-identity]', async () => {
      mockedLlm.mockImplementation(async (o: { prompt: string }) => (o.prompt.includes('(auth)') ? { findings: [finding()] } : { findings: [] }));
      const first = await scan({ noSpecReview: false, planId: 'scan-1' }, withModel);
      mockedLlm.mockImplementation(async (o: { prompt: string }) => (o.prompt.includes('(auth)') ? { findings: [finding({ title: 'No limit on code requests' })] } : { findings: [] }));
      const second = await scan({ noSpecReview: false, planId: 'scan-2' }, withModel);
      expect(second.plan!.items.filter((i) => i.type === 'spec').map((i) => i.id)).toEqual(first.plan!.items.filter((i) => i.type === 'spec').map((i) => i.id));
      // The model says nothing this time: a model's silence is not evidence the gap is closed.
      mockedLlm.mockResolvedValue({ findings: [] });
      const third = await scan({ noSpecReview: false, planId: 'scan-3' }, withModel);
      expect(third.plan!.items.filter((i) => i.type === 'spec').map((i) => i.status)).toEqual(['open']);
    });

    // [claims: capabilities/security-and-remediation#spec-review]
    it('shows the model the code findings under the capability so it can spot a requirement gap [code-in-review]', async () => {
      mockedDetect.mockResolvedValue(detection({ sast: [{ kind: 'sast', ruleId: 'js.csrf', path: 'src/auth/login.ts', message: 'no csrf check', severity: 'high' }] }));
      mockedLlm.mockResolvedValue({ findings: [] });
      await scan({ noSpecReview: false }, withModel);
      const authCall = mockedLlm.mock.calls.find((c) => (c[0].prompt as string).includes('(auth)'))![0];
      expect(authCall.prompt).toContain('js.csrf in src/auth/login.ts: no csrf check');
    });

    it('keeps one capability\'s failure from stopping the rest, and says so [review-failure]', async () => {
      mockedLlm.mockImplementation(async (o: { prompt: string }) => {
        if (o.prompt.includes('(auth)')) throw new Error('rate limited');
        return { findings: [finding({ claims: [] })] };
      });
      const r = await scan({ noSpecReview: false }, withModel);
      expect(r.messages.join('\n')).toContain('spec review of auth failed: rate limited');
      expect(r.plan!.items.filter((i) => i.type === 'spec').map((i) => i.capability)).toEqual(['shop']);
    });

    it('is skipped, with a reason, when there is no model or the flag says so [skips]', async () => {
      const none = await scan({ noSpecReview: false });
      expect(none.messages.join('\n')).toContain('spec-level review skipped: no model configured');
      const flagged = await scan({ noSpecReview: true }, withModel);
      expect(flagged.messages.join('\n')).toContain('--no-spec-review');
      expect(mockedLlm).not.toHaveBeenCalled();
    });
  });
});

describe('security fix [security-fix]', () => {
  async function planWith() {
    mockedDetect.mockResolvedValue(
      detection({
        advisories: [advisory(), advisory({ id: 'GHSA-bbbb', package: 'axios' }), advisory({ id: 'GHSA-cccc', package: 'left-pad' })],
        sast: [{ kind: 'sast', ruleId: 'js.xss', path: 'src/auth/login.ts', message: 'x', severity: 'high' }],
        secrets: [{ kind: 'secret', ruleId: 'aws-key', path: 'src/shop/cart.ts', message: 'm' }],
      }),
    );
    return (await scan({ planId: 'scan-1' })).plan!;
  }

  const result = (over: Partial<ItemReport>): ItemReport => ({ branch: 'b', advisoryIds: [], changedFiles: [], selectedTests: { claimTagged: 0, importing: 0, total: 0, files: [] }, evidence: {}, ...over });
  const fakeRemediate = (results: ItemReport[], exitCode = 8) => vi.fn(async () => ({ exitCode, messages: [], items: [], created: 0, updated: 0, skipped: 0, failed: 0, pipeline: 'remediate', report: { results } }) as never);

  // [claims: capabilities/security-and-remediation#security-fix-statuses]
  it('moves each item by what happened to its branch, and never touches spec or secret items [statuses]', async () => {
    const plan = await planWith();
    const idOf = (t: string) => plan.items.find((i) => i.title.includes(t))!.id;
    const remediate = fakeRemediate([
      result({ branch: 'fix/lodash', advisoryIds: ['GHSA-aaaa'], verdict: 'PRESERVED', pr: { url: 'https://pr/1', draft: false, pushed: true } }),
      result({ branch: 'fix/axios', advisoryIds: ['GHSA-bbbb'], verdict: 'CHANGED' }),
      result({ branch: 'fix/code', advisoryIds: ['semgrep:js.xss@src/auth/login.ts'], error: 'patch did not apply' }),
    ]);
    const r = await runSecurityFix(await loadConfig(repo.dir), {}, {}, remediate);
    const stored = readPlan(await loadConfig(repo.dir), 'scan-1')!;
    const by = (id: string) => stored.items.find((i) => i.id === id)!;
    expect(by(idOf('lodash')).status).toBe('fixed');
    expect(by(idOf('lodash')).statusHistory.at(-1)?.note).toContain('https://pr/1');
    expect(by(idOf('axios')).status).toBe('in-progress');
    expect(by(idOf('axios')).statusHistory.at(-1)?.note).toContain('verdict CHANGED');
    expect(by(idOf('src/auth')).status).toBe('open');
    expect(by(idOf('src/auth')).statusHistory.at(-1)?.note).toContain('patch did not apply');
    // Not attempted by the executor: back to open, with a reason.
    expect(by(idOf('left-pad')).status).toBe('open');
    expect(by(idOf('left-pad')).statusHistory.at(-1)?.note).toContain('not attempted');
    // Secrets are never patched.
    expect(by(idOf('Secret')).status).toBe('open');
    expect(by(idOf('Secret')).statusHistory).toEqual([]);
    expect(r.messages.join('\n')).toContain('a secret needs rotation by a person');
    expect(r.exitCode).toBe(8);
  });

  // [claims: capabilities/security-and-remediation#security-fix-statuses]
  it('keeps an update a tracker made while the fix ran, and restores items when the run crashes [concurrent-update]', async () => {
    const plan = await planWith();
    const lodash = plan.items.find((i) => i.title.startsWith('lodash'))!;
    const axios = plan.items.find((i) => i.title.startsWith('axios'))!;
    const config = await loadConfig(repo.dir);
    // While remediate runs, a tracker links an external ref to axios and the team marks lodash won't-fix.
    const remediate = vi.fn(async () => {
      await runPlanSetStatus(config, 'scan-1', axios.id, 'in-progress', { externalRef: 'SEC-9' });
      await runPlanSetStatus(config, 'scan-1', lodash.id, 'wont-fix', { note: 'accepted risk' });
      return { exitCode: 8, messages: [], items: [], created: 0, updated: 0, skipped: 0, failed: 0, pipeline: 'remediate', report: { results: [result({ branch: 'fix/lodash', advisoryIds: ['GHSA-aaaa'], verdict: 'PRESERVED' }), result({ branch: 'fix/axios', advisoryIds: ['GHSA-bbbb'], verdict: 'PRESERVED' })] } } as never;
    });
    const r = await runSecurityFix(config, { item: undefined }, {}, remediate);
    const stored = readPlan(config, 'scan-1')!;
    expect(stored.items.find((i) => i.id === lodash.id)!.status).toBe('wont-fix');
    expect(stored.items.find((i) => i.id === axios.id)!.externalRef).toBe('SEC-9');
    expect(r.messages.join('\n')).toContain('left as is');

    const crash = vi.fn(async () => {
      throw new Error('worktree exploded');
    });
    await expect(runSecurityFix(config, {}, {}, crash)).rejects.toThrow('worktree exploded');
    const after = readPlan(config, 'scan-1')!;
    expect(after.items.filter((i) => i.status === 'in-progress' && i.statusHistory.at(-1)?.note?.includes('remediation started'))).toEqual([]);
    expect(after.items.find((i) => i.id === lodash.id)!.status).toBe('wont-fix');
  });

  it('narrows the run to one advisory when a single dependency item is chosen [single-item]', async () => {
    const plan = await planWith();
    const axios = plan.items.find((i) => i.title.startsWith('axios'))!;
    const remediate = fakeRemediate([result({ advisoryIds: ['GHSA-bbbb'], verdict: 'PRESERVED', branch: 'fix/axios' })]);
    await runSecurityFix(await loadConfig(repo.dir), { item: axios.id, pr: true }, {}, remediate);
    expect(remediate.mock.calls[0][1]).toMatchObject({ advisory: 'GHSA-bbbb', pr: true, minSeverity: 'high' });
  });

  it('leaves the plan untouched on a dry run [dry-run]', async () => {
    await planWith();
    const remediate = fakeRemediate([result({ advisoryIds: ['GHSA-aaaa'], verdict: 'PRESERVED', branch: 'b' })]);
    await runSecurityFix(await loadConfig(repo.dir), { dryRun: true }, {}, remediate);
    expect(readPlan(await loadConfig(repo.dir), 'scan-1')!.items.every((i) => i.status === 'open' && i.statusHistory.length === 0)).toBe(true);
    expect(remediate.mock.calls[0][1]).toMatchObject({ dryRun: true });
  });

  it('says so when there is no plan or nothing it can fix [nothing-to-do]', async () => {
    expect((await runSecurityFix(await loadConfig(repo.dir), {})).exitCode).toBe(1);
    mockedDetect.mockResolvedValue(detection({ secrets: [{ kind: 'secret', ruleId: 'k', path: 'src/shop/cart.ts', message: 'm' }] }));
    await scan({ planId: 'scan-9' });
    const remediate = fakeRemediate([]);
    const r = await runSecurityFix(await loadConfig(repo.dir), {}, {}, remediate);
    expect(r.messages.join('\n')).toContain('nothing to fix automatically');
    expect(remediate).not.toHaveBeenCalled();
  });
});
