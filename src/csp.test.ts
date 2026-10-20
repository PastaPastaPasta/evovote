import { describe, expect, it } from 'vitest';
import { cspPolicy, withCsp } from './csp';

describe('Content-Security-Policy', () => {
  it('allows the WASM SDK, this origin, https connections and Google Fonts, nothing inline but by hash', () => {
    const policy = cspPolicy(['abc=']);
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-abc='");
    expect(policy).toContain("connect-src 'self' https:");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain("style-src 'self' https://fonts.googleapis.com");
    expect(policy).toContain('font-src https://fonts.gstatic.com');
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain('unsafe-inline');
  });

  it('puts the meta right after the charset and hashes each inline script exactly', async () => {
    const html = '<html><head><meta charset="UTF-8" /><script>x()</script><script type="module" src="./a.js"></script></head></html>';
    const out = await withCsp(html);
    // sha256("x()") in base64.
    const expected = btoa(
      String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('x()')))),
    );
    expect(out.indexOf('Content-Security-Policy')).toBeGreaterThan(out.indexOf('<meta charset'));
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<script>'));
    expect(out).toContain(`'sha256-${expected}'`);
    expect(out.match(/sha256-/g)).toHaveLength(1);
  });
});
