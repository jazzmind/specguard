import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ message: vi.fn(), error: vi.fn(), spawn: vi.fn() }));
vi.mock('vscode', () => ({ window: { showInformationMessage: mocked.message, showErrorMessage: mocked.error } }));
vi.mock('./dashboard/cli.js', () => ({ resolveCliPath: async () => 'cli', spawnCli: mocked.spawn }));
import { forceUpdateProjectFiles, updatePreview } from './project-updater.js';
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })); vi.resetAllMocks(); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-updater-')); roots.push(root);
  fs.mkdirSync(path.join(root, '.specguard')); fs.writeFileSync(path.join(root, '.specguard/config.json'), '{}');
  return root;
}
describe('setup update disclosure', () => {
  // [claims: capabilities/integration-surfaces#extension-setup-preview]
  it('discloses CLAUDE section preservation, marked-file replacement and unmarked-file preservation before running', async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Custom rules');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '<!-- specguard-managed: true -->\nMy edits');
    const text = updatePreview(root).join('\n');
    expect(text).toContain('preserve your surrounding Claude rules');
    expect(text).toContain('REPLACE the entire');
    expect(text).toContain('custom edits inside it will be overwritten');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'My own rules');
    expect(updatePreview(root).join('\n')).toContain('preserve unchanged (user-authored');
    mocked.message.mockResolvedValue(undefined);
    await forceUpdateProjectFiles({ extension: { packageJSON: { version: '0.6.0' } } } as never, root);
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(mocked.message.mock.calls[0][1]).toMatchObject({ modal: true, detail: expect.stringContaining('CLAUDE.md') });
  });
  // [claims: capabilities/integration-surfaces#extension-setup-preview]
  it('never advances the setup version or reports success after scaffold fails', async () => {
    const root = fixture();
    mocked.message.mockResolvedValue('Update SpecGuard files');
    mocked.spawn.mockReturnValue({ promise: Promise.resolve(1) });
    await forceUpdateProjectFiles({ extension: { packageJSON: { version: '0.6.0' } } } as never, root);
    expect(mocked.error).toHaveBeenCalledWith(expect.stringContaining('setup version was not advanced'));
    expect(fs.existsSync(path.join(root, '.specguard/sg-version.json'))).toBe(false);
  });
});
