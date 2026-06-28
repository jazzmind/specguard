import { describe, it, expect } from 'vitest';
import { formatResult, toolResult, textResult, errorResult } from '../../src/mcp/format.js';
import { emptyResult } from '../../src/core/types.js';

describe('mcp format helpers', () => {
  it('formats a PipelineResult with counts, messages and items', () => {
    const result = emptyResult('status');
    result.created = 1;
    result.updated = 2;
    result.skipped = 3;
    result.failed = 0;
    result.exitCode = 0;
    result.messages = ['scanned 5 files'];
    result.items = [{ key: 'core/foo', status: 'ok', path: 'specs/core/foo.md' }];

    const text = formatResult(result);
    expect(text).toContain('[status]');
    expect(text).toContain('created=1 updated=2 skipped=3 failed=0');
    expect(text).toContain('scanned 5 files');
    expect(text).toContain('core/foo: ok');
    expect(text).toContain('Raw result:');
  });

  it('toolResult wraps formatted text in a single text content block', () => {
    const res = toolResult(emptyResult('drift'));
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).toContain('[drift]');
  });

  it('textResult returns plain text', () => {
    const res = textResult('hello');
    expect(res.content[0].text).toBe('hello');
    expect(res.isError).toBeUndefined();
  });

  it('errorResult marks isError and includes the message', () => {
    const res = errorResult(new Error('boom'));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('boom');
  });
});
