import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { repositoryContent } from './repository-content.js';
describe('workspace contributions', () => {
  // [claims: capabilities/integration-surfaces#extension-overlay-workspace]
  it('recognizes evidence containers without a root app config and relates their code consumers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-contributions-'));
    try {
      const overlay = path.join(root, 'evidence'); const app = path.join(overlay, 'apps/web');
      fs.mkdirSync(path.join(app, '.specguard'), { recursive: true });
      for (const dir of ['docs', 'e2e']) fs.mkdirSync(path.join(overlay, dir));
      fs.writeFileSync(path.join(app, '.specguard/config.json'), JSON.stringify({ apps: [{ specDir: 'specs' }] }));
      const projects = [{ key: 'web', absPath: path.join(root, 'web'), config: { configured: true, via: 'overlay' as const, configDir: app, overlayRoot: overlay } }];
      expect(repositoryContent(overlay, projects)).toMatchObject({ overlayFor: ['web'], contents: expect.arrayContaining(['specs', 'tests', 'docs']) });
      expect(repositoryContent(path.join(root, 'web'), projects)).toMatchObject({ contents: ['code'], suppliedBy: [overlay] });
      expect(repositoryContent(path.join(root, 'evidence-other'), projects).overlayFor).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
