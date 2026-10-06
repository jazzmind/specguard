import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A HiRocky-shaped repo: multi-app, per-app specDirs under one specs root,
 * app `repo` roots, root-relative and repo-relative `sources:` headers,
 * tagged tests, and Vitest + Playwright JSON reports.
 */
const spec = (title: string, sources: string, claims: string[]): string =>
  `# ${title}\n\n<!--\n  module: ${sources.split(',')[0].trim()}\n  type: service\n  status: stable\n  sources: ${sources}\n-->\n\n## Overview\n\n${title}.\n\n## Acceptance Criteria\n\n` +
  claims.map((c) => `- [ ] ${c} behaves <!-- claim: ${c} -->`).join('\n') +
  '\n';

export const MESSAGING = 'api/services/messaging';
export const SIGNATURE = 'api/sms/signature';
export const INBOX = 'web/pages/inbox';
export const JOURNEY = 'journeys/opt-out';

export interface HiRockyFixture {
  dir: string;
  write: (rel: string, content: string) => string;
  /** Vitest JSON report paths, relative to dir. */
  reports: { api: string; web: string; e2e: string };
}

function vitestReport(file: string, rows: Array<[string, 'passed' | 'failed' | 'skipped']>): string {
  return JSON.stringify({
    numTotalTests: rows.length,
    testResults: [
      {
        name: file,
        assertionResults: rows.map(([title, status]) => ({
          title,
          fullName: title,
          ancestorTitles: [],
          status,
          duration: 1,
          failureMessages: status === 'failed' ? ['boom'] : [],
        })),
      },
    ],
  });
}

export function makeHiRockyRepo(): HiRockyFixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-hirocky-'));
  const write = (rel: string, content: string): string => {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  };
  const app = (name: string, repo: string, specDir: string, testOutput: string, framework = 'vitest') => ({
    name,
    repo,
    language: 'typescript',
    framework,
    specDir,
    testOutput,
    stripPrefix: 'src/',
    sources: { api: repo === '.' ? [] : ['src/**/*.{ts,tsx}'], tests: framework === 'vitest' ? ['test/**/*.test.ts', 'src/**/*.test.ts'] : ['e2e/journeys/**/*.spec.ts'] },
  });
  write(
    '.specguard/config.json',
    JSON.stringify({
      paths: { specsRoot: 'specs', proofLedger: '.specguard/proofs.json' },
      apps: [
        app('api', 'apps/api', 'specs/api', 'apps/api/test/'),
        app('web', 'apps/web', 'specs/web', 'apps/web/src/'),
        { ...app('journeys', '.', 'specs/journeys', 'e2e/journeys/', 'playwright'), extraTestSources: ['e2e/journeys/**/*.spec.ts'] },
      ],
      llm: { provider: 'none', model: 'none', apiKeyEnv: 'NONE' },
    }),
  );
  // Root-relative sources header (as HiRocky wrote it) and an app-relative one.
  write('specs/api/services/messaging.md', spec('Messaging', 'apps/api/src/services/messaging.ts, apps/api/src/services/redaction.ts', ['stop-opts-out', 'send-blocked']));
  write('specs/api/sms/signature.md', spec('Signature', 'src/sms/signature.ts', ['valid-signature', 'bad-signature']));
  write('specs/web/pages/inbox.md', spec('Inbox', 'src/pages/inbox.tsx', ['lists-cases']));
  write('specs/journeys/opt-out.md', spec('Opt out', 'apps/api/src/services/messaging.ts', ['journey-stop']));
  write('apps/api/src/services/messaging.ts', 'export const send = 1;\n');
  write('apps/api/src/services/redaction.ts', 'export const redact = 1;\n');
  write('apps/api/src/sms/signature.ts', 'export const sig = 1;\n');
  write('apps/web/src/pages/inbox.tsx', 'export const Inbox = 1;\n');
  write('apps/api/test/messaging.test.ts', `it('stop opts out @claim:${MESSAGING}#stop-opts-out', () => {});\nit('blocks @claim:${MESSAGING}#send-blocked', () => {});\n`);
  write('apps/api/test/signature.test.ts', `it('valid @claim:${SIGNATURE}#valid-signature', () => {});\nit('bad @claim:${SIGNATURE}#bad-signature', () => {});\n`);
  write('apps/web/src/inbox.test.ts', `it('lists @claim:${INBOX}#lists-cases', () => {});\n`);
  write('e2e/journeys/opt-out.spec.ts', `test('stop @claim:${JOURNEY}#journey-stop', async () => {});\n`);
  write('package-lock.json', '{"lockfileVersion":3}\n');
  write(
    'reports/vitest-api.json',
    vitestReport('apps/api/test/messaging.test.ts', [
      [`stop opts out @claim:${MESSAGING}#stop-opts-out`, 'passed'],
      [`blocks @claim:${MESSAGING}#send-blocked`, 'passed'],
      [`valid @claim:${SIGNATURE}#valid-signature`, 'passed'],
      [`bad @claim:${SIGNATURE}#bad-signature`, 'passed'],
    ]),
  );
  write('reports/vitest-web.json', vitestReport('apps/web/src/inbox.test.ts', [[`lists @claim:${INBOX}#lists-cases`, 'passed']]));
  write(
    'reports/playwright.json',
    JSON.stringify({
      config: {},
      suites: [
        {
          title: 'opt-out.spec.ts',
          file: 'opt-out.spec.ts',
          specs: [
            {
              title: `stop @claim:${JOURNEY}#journey-stop`,
              file: 'opt-out.spec.ts',
              tags: [],
              tests: [{ projectName: 'chromium', expectedStatus: 'passed', status: 'expected', annotations: [], results: [{ status: 'passed', duration: 10 }] }],
            },
          ],
          suites: [],
        },
      ],
    }),
  );
  return { dir, write, reports: { api: 'reports/vitest-api.json', web: 'reports/vitest-web.json', e2e: 'reports/playwright.json' } };
}
