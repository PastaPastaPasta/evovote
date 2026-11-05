import { afterEach, describe, expect, it, vi } from 'vitest';
import { storedNetwork } from './sdk';

afterEach(() => vi.unstubAllGlobals());
function browser(href: string, legacy: string | null) {
  const location = { href };
  const data = new Map(legacy ? [['evovote.network', legacy]] : []);
  vi.stubGlobal('location', location);
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, removeItem: (k: string) => data.delete(k) });
  vi.stubGlobal('history', { state: null, replaceState: (_: unknown, __: string, url: URL) => { location.href = url.href; } });
  return { location, data };
}
describe('URL network migration', () => {
  it('imports the legacy preference once and keeps the old contest hash', () => {
    const b = browser('https://vote.dashhq.org/#/c/german', 'testnet');
    expect(storedNetwork()).toBe('testnet');
    expect(b.location.href).toBe('https://vote.dashhq.org/?network=testnet#/c/german');
    expect(b.data.size).toBe(0);
    b.location.href = 'https://vote.dashhq.org/';
    expect(storedNetwork()).toBe('mainnet');
  });
  it('uses an explicit Mainnet URL ahead of the old preference and canonicalizes it', () => {
    const b = browser('https://vote.dashhq.org/?network=mainnet#/about', 'testnet');
    expect(storedNetwork()).toBe('mainnet');
    expect(b.location.href).toBe('https://vote.dashhq.org/#/about');
  });
  it('keeps an unsupported network visible so the app can disclose the fallback', () => {
    const b = browser('https://vote.dashhq.org/?network=devnet-local#/about', null);
    expect(storedNetwork()).toBe('mainnet');
    expect(b.location.href).toContain('network=devnet-local');
  });
});
