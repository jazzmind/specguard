import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import { UI_HTML } from '../../src/server/ui.js';

/** Run the page's script against stubs so its pure helpers can be called. */
function load() {
  const script = UI_HTML.match(/<script>([\s\S]*)<\/script>/)![1];
  const el = () => ({ innerHTML: '', className: '', insertAdjacentHTML() {}, querySelectorAll: () => [] });
  const ctx: Record<string, unknown> = {
    document: { getElementById: el },
    location: { hash: '' },
    window: {},
    fetch: () => Promise.reject(new Error('offline')),
    encodeURIComponent,
    decodeURIComponent,
    Array,
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return ctx as { md: (s: string) => string; esc: (s: string) => string };
}

describe('web UI [ui]', () => {
  it('has a script that parses and runs [parses]', () => {
    expect(() => load()).not.toThrow();
  });

  // [claims: capabilities/documentation-api#ui-escapes-markdown]
  it('escapes HTML in model-written markdown so it cannot inject script [escapes]', () => {
    const { md } = load();
    const out = md('# Title <img src=x onerror=alert(1)>\n\n<script>alert(1)</script> and **bold**');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('<strong>bold</strong>');
  });

  // [claims: capabilities/documentation-api#ui-escapes-markdown]
  it('links only http(s), site-relative and anchor URLs [links]', () => {
    const { md } = load();
    expect(md('[ok](https://example.com/a)')).toContain('<a href="https://example.com/a">ok</a>');
    expect(md('[rel](/docs)')).toContain('href="/docs"');
    expect(md('[bad](javascript:alert(1))')).not.toContain('<a ');
    expect(md('[bad](data:text/html;base64,AAAA)')).not.toContain('<a ');
  });

  it('renders code fences verbatim and escaped, lists and tables [blocks]', () => {
    const { md } = load();
    const fence = '\x60\x60\x60';
    expect(md(`${fence}\n<b>x</b>\n${fence}`)).toContain('<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
    expect(md('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(md('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
    const table = md('| A | B |\n|---|---|\n| 1 | <i>2</i> |');
    expect(table).toContain('<th>A</th>');
    expect(table).toContain('&lt;i&gt;2&lt;/i&gt;');
  });
});
