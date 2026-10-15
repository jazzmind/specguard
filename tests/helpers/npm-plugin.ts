import type { TmpRepo } from './repo.js';

/** Install a fake npm plugin package under the repo's node_modules. `source` is CommonJS and must set `exports.plugin`. */
export function installNpmPlugin(repo: TmpRepo, pkg: string, source: string): void {
  repo.write(`node_modules/${pkg}/package.json`, JSON.stringify({ name: pkg, version: '1.0.0', main: 'index.js' }));
  repo.write(`node_modules/${pkg}/index.js`, source);
}
