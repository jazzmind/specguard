import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect, it } from 'vitest';

// [claims: capabilities/integration-surfaces#extension-output-browser]
it('loads the packaged host and its output-browser dependencies in Node without activating the editor', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-host-bundle-'));
  try {
    const out = path.join(temp, 'host.cjs');
    execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/build.mjs'), 'host', '--out', out], { stdio: 'pipe' });
    const check = `const Module = require('node:module');
const original = Module._load;
Module._load = function(name, ...args) {
  if(name === 'vscode') return { TreeItem: class {}, EventEmitter: class { event=()=>{}; fire(){}; dispose(){} } };
  return original.call(this, name, ...args);
};
const host = require(${JSON.stringify(out)});
if(typeof host.activate !== 'function') throw new Error('missing activation entry');
process.stdout.write('loaded');`;
    expect(execFileSync(process.execPath, ['-e', check], { encoding: 'utf8' })).toBe('loaded');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}, 30_000);
