import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { inventorySpecs, specCountLabel } from './spec-inventory.js';

describe('spec inventory [vscode-dashboard]', () => {
  it('counts capabilities and leaves archived v1 specs out of the current count', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-specs-'));
    fs.mkdirSync(path.join(root, 'capabilities'));
    fs.mkdirSync(path.join(root, '_archive', 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'system.md'), '# system\n');
    fs.writeFileSync(path.join(root, 'capabilities', 'design.md'), '# design\n');
    fs.writeFileSync(path.join(root, 'capabilities', 'deliver.md'), '# deliver\n');
    fs.writeFileSync(path.join(root, '_archive', 'v1', 'old.md'), '# old\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# readme\n');

    const inventory = inventorySpecs(root);
    expect(inventory).toMatchObject({ capabilities: 2, hasSystem: true, livingFiles: 3, archivedFiles: 1 });
    expect(specCountLabel(inventory)).toEqual({ specCount: 2, specLabel: '2 capabilities' });
  });

  it('counts living files when a repo has not been consolidated', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-specs-'));
    fs.writeFileSync(path.join(root, 'login.md'), '# login\n');
    expect(specCountLabel(inventorySpecs(root))).toEqual({ specCount: 1, specLabel: '1 spec file' });
  });
});
