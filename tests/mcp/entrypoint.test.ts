import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { isEntrypoint } from '../../src/mcp/entrypoint.js';

describe('MCP server entry check', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(): { real: string; link: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'sg-mcp-entry-'));
    dirs.push(dir);
    const real = path.join(dir, 'dist', 'mcp', 'server.js');
    const link = path.join(dir, 'node_modules', '.bin', 'specguard-mcp');
    for (const p of [real, link]) mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(real, '');
    symlinkSync(real, link);
    return { real, link };
  }

  // [claims: capabilities/integration-surfaces#mcp-starts-through-bin-link]
  it('starts when run through a linked bin, as npx and npm .bin links do', () => {
    const { real, link } = fixture();
    expect(isEntrypoint(pathToFileURL(real).href, link)).toBe(true);
  });

  // [claims: capabilities/integration-surfaces#mcp-starts-through-bin-link]
  it('starts when run by its own path', () => {
    const { real } = fixture();
    expect(isEntrypoint(pathToFileURL(real).href, real)).toBe(true);
  });

  // [claims: capabilities/integration-surfaces#mcp-tools-parity]
  it('does not start when another module is the entry, or there is none', () => {
    const { real } = fixture();
    expect(isEntrypoint(pathToFileURL(real).href, path.join(path.dirname(real), 'other.js'))).toBe(false);
    expect(isEntrypoint(pathToFileURL(real).href, undefined)).toBe(false);
  });
});
