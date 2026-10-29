import { beforeEach, describe, expect, it, vi } from 'vitest';
const { pick, spawn, info } = vi.hoisted(() => ({ pick: vi.fn(), spawn: vi.fn(), info: vi.fn() }));
vi.mock('vscode', () => ({ window: { showQuickPick: pick, showInformationMessage: info, showInputBox: vi.fn(), showTextDocument: vi.fn() }, workspace: { openTextDocument: vi.fn() } }));
vi.mock('./dashboard/cli.js', () => ({ resolveCliPath: vi.fn(async () => '/cli.js'), spawnCli: spawn }));
import { prepareOutputRun } from './output-routing.js';
const app = { app: 'api', code: '/source/backend', configRoot: '/overlay/apps/api', outputs: ['specs', 'tests.unit', 'tests.integration', 'tests.e2e', 'docs', 'plans'].map(kind => ({ kind, directory: `/overlay/${kind}`, saved: true, mappingOnly: false })) };
beforeEach(() => {
  vi.clearAllMocks();
  spawn.mockImplementation((_cli, _args, _root, onLine) => { onLine(JSON.stringify([app])); return { promise: Promise.resolve(0), kill: vi.fn() }; });
});
// [claims: capabilities/integration-surfaces#extension-output-routing]
describe('generation destination chooser', () => {
  // [claims: capabilities/integration-surfaces#extension-output-routing]
  it('uses the saved overlay destination and scopes Playwright generation to backend claims', async () => {
    pick.mockResolvedValueOnce('e2e').mockImplementationOnce(async options => options[0]).mockImplementationOnce(async options => options[0]);
    const args = await prepareOutputRun('/code', 'generate', []);
    expect(args).toEqual(['--type', 'e2e', '--framework', 'playwright', '--app', 'api']);
    expect(pick.mock.calls[1][0][0].label).toBe('/overlay/tests.e2e');
    expect(pick.mock.calls[1][1].placeHolder).toContain('/source/backend');
    expect(spawn).toHaveBeenCalledTimes(1); // the existing preference is retained
  });
  // [claims: capabilities/integration-surfaces#extension-output-routing]
  it('does not persist a newly selected destination if the run is cancelled', async () => {
    pick.mockResolvedValueOnce('unit').mockResolvedValueOnce({ directory: '/new-tests' }).mockResolvedValueOnce(undefined);
    expect(await prepareOutputRun('/code', 'generate', [])).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).not.toContain('--directory');
  });
  // [claims: capabilities/integration-surfaces#extension-output-routing]
  it('scopes reverse and gap actions to the selected application', async () => {
    pick.mockImplementation(async options => options[0]);
    expect(await prepareOutputRun('/code', 'reverse', [])).toEqual(['--app', 'api']);
    expect(await prepareOutputRun('/code', 'gap-analysis', [])).toEqual(['--app', 'api']);
  });
  // [claims: capabilities/integration-surfaces#extension-output-routing]
  it('leaves non-generation actions untouched', async () => {
    expect(await prepareOutputRun('/code', 'check', ['--gaps'])).toEqual(['--gaps']);
    expect(spawn).not.toHaveBeenCalled();
  });
});
