import { describe, expect, it } from 'vitest';
import { CONTRACTS_MODES, MAP_MODES, contractMappingsEnabled, contractsArgs, existingMappingFiles, mapArgs, mappingsFileName } from './contract-mappings.js';

// [claims: capabilities/integration-surfaces#extension-generate-contract-mappings]
describe('Generate Contract Mappings choices become CLI flags', () => {
  it('maps each mode to its flags', () => {
    expect(mapArgs('text', false)).toEqual([]);
    expect(mapArgs('text-llm', false)).toEqual(['--with-llm']);
    expect(mapArgs('assess', false)).toEqual(['--assess']);
    expect(mapArgs('code', false)).toEqual(['--with-code']);
    expect(mapArgs('code-llm', false)).toEqual(['--with-llm', '--with-code']);
  });
  it('adds --dry-run except for assess, which never writes, and --repo from a repo row', () => {
    expect(mapArgs('text', true)).toEqual(['--dry-run']);
    expect(mapArgs('code-llm', true, 'web')).toEqual(['--with-llm', '--with-code', '--dry-run', '--repo', 'web']);
    expect(mapArgs('assess', true)).toEqual(['--assess']);
  });
  it('offers every mode once', () => {
    expect(MAP_MODES.map((m) => m.mode)).toEqual(['text', 'text-llm', 'assess', 'code', 'code-llm']);
  });
  it('maps the Build Contract Graph choices', () => {
    expect(CONTRACTS_MODES.map((m) => contractsArgs(m.mode))).toEqual([[], ['--force'], ['--with-llm']]);
  });
  it('is shown only when a repo config enables the plugin', () => {
    expect(contractMappingsEnabled({ plugins: ['quality', 'contract-mappings'] })).toBe(true);
    expect(contractMappingsEnabled({ plugins: [{ name: 'contract-mappings' }] })).toBe(true);
    expect(contractMappingsEnabled({ plugins: ['contract-mappings'], disabledPlugins: ['contract-mappings'] })).toBe(false);
    for (const c of [undefined, {}, { plugins: ['quality'] }, 'x']) expect(contractMappingsEnabled(c)).toBe(false);
  });
  it('finds each existing mapping file, honouring a configured path', () => {
    expect(mappingsFileName({})).toBe('.specguard/contract-mappings.json');
    expect(mappingsFileName({ contractMappings: { file: 'maps.json' } })).toBe('maps.json');
    const cfg = (r: { key: string }) => (r.key === 'b' ? { contractMappings: { file: 'maps.json' } } : {});
    const exists = (f: string) => f === '/r/a/.specguard/contract-mappings.json' || f === '/r/b/maps.json';
    const repos = [{ key: 'a', absPath: '/r/a' }, { key: 'b', absPath: '/r/b' }, { key: 'c', absPath: '/r/c' }];
    expect(existingMappingFiles(repos, cfg, exists)).toEqual(['/r/a/.specguard/contract-mappings.json', '/r/b/maps.json']);
  });
});
