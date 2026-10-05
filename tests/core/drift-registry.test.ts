import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  fromRegistryKey,
  loadRegistry,
  migrateRegistryKeys,
  registryPath,
  saveRegistry,
  toRegistryKey,
  updateFileEntry,
  getOrCreateSpecEntry,
} from '../../src/core/drift-registry.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'sg-reg-'));

describe('drift registry portability', () => {
  it('round-trips repo-relative POSIX keys', () => {
    const root = tmp();
    const abs = path.join(root, 'src', 'a', 'b.ts');
    const key = toRegistryKey(root, abs);
    expect(key).toBe('src/a/b.ts');
    expect(fromRegistryKey(root, key)).toBe(abs);
  });

  it('migrates absolute keys once and does not rewrite a relative registry', () => {
    const root = tmp();
    const abs = path.join(root, 'src', 'x.ts');
    const entry = { specKey: 'app/x', specHash: 'h', files: { [abs]: { hash: '1', lastChecked: '', lastVerdict: 'no-drift' as const } } };
    mkdirSync(path.join(root, '.specguard'));
    writeFileSync(registryPath(root), JSON.stringify({ 'app/x': entry }));
    const loaded = loadRegistry(root);
    expect(Object.keys(loaded['app/x'].files)).toEqual(['src/x.ts']);
    expect(JSON.parse(readFileSync(registryPath(root), 'utf8'))['app/x'].files['src/x.ts'].hash).toBe('1');
    const mtime = statSync(registryPath(root)).mtimeMs;
    expect(migrateRegistryKeys(root, loaded)).toBe(false);
    loadRegistry(root);
    expect(statSync(registryPath(root)).mtimeMs).toBe(mtime);
  });

  it('updateFileEntry keys by the given key', () => {
    const reg = {};
    const entry = getOrCreateSpecEntry(reg, 'a/b', 'h');
    updateFileEntry(entry, 'src/x.ts', 'deadbeef', 'drifted');
    expect(entry.files['src/x.ts'].lastVerdict).toBe('drifted');
    saveRegistry(tmp(), reg);
  });
});
